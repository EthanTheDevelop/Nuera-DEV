import 'server-only';
import { sessionEvents } from '@nuera/db/schema';
import { RESUME_CONTEXT_MAX_CHARS } from '@nuera/shared/runner';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/server/db';
import { redactSecrets } from '@/server/integrations/redact';

/**
 * « Reprendre avec le contexte »: when the conversation recorded by Claude Code is gone (retention,
 * folder lost, worktree recreated…), the fresh CLI receives — only after the owner said so — a
 * first instruction built from what Nuera Dev itself stored for the session (`session_events`):
 * title, branch, last instructions of the owner, last messages of Claude, files changed, last
 * commit. Capped in size; secrets are masked (known values of the session's variables, token
 * patterns) and `NOM=valeur` assignments never carry their value.
 */

export interface ResumeContextInput {
  title: string;
  projectName: string;
  branch: string | null;
  /** Oldest first. */
  instructions: string[];
  /** Oldest first. */
  messages: string[];
  /** Paths written by Claude's file tools (Edit, Write…), most recent first. */
  files: string[];
  /** `abc1234 feat: …` of the last commit seen on the branch, if known. */
  lastCommit: string | null;
  /** Values that must never appear (the session's variables, decrypted for its launch). */
  secrets?: ReadonlyArray<string | null | undefined>;
}

const MAX_INSTRUCTIONS = 5;
const MAX_MESSAGES = 3;
const MAX_FILES = 25;
const INSTRUCTION_CHARS = 600;
const MESSAGE_CHARS = 900;

/** `API_KEY=sk-…`, `export TOKEN="…"`: the name stays, the value never does. */
const ASSIGNMENT = /\b((?:export\s+)?[A-Z][A-Z0-9_]{1,63})\s*=\s*("[^"\n]*"|'[^'\n]*'|[^\s"'`]+)/g;

/** Keys the shared redaction does not know (Anthropic, Stripe, AWS, Slack, OpenAI-style). */
const EXTRA_KEYS = [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, /\b[rs]k_(?:live|test)_[A-Za-z0-9]{8,}/g, /\bAKIA[0-9A-Z]{16}\b/g, /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, /\bsk-[A-Za-z0-9_-]{20,}/g];

/** Masked, on one paragraph, cut with « … ». */
export function cleanContextText(text: string, max: number, secrets: ReadonlyArray<string | null | undefined> = []): string {
  let masked = redactSecrets(text, secrets);
  for (const pattern of EXTRA_KEYS) masked = masked.replace(pattern, '[masqué]');
  masked = masked.replace(ASSIGNMENT, '$1=[masqué]');
  const flat = masked.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** The first instruction of the fresh CLI (≤ RESUME_CONTEXT_MAX_CHARS characters). */
export function buildResumeContext(input: ResumeContextInput): string {
  const secrets = input.secrets ?? [];
  const clean = (text: string, max: number) => cleanContextText(text, max, secrets);
  const head = [
    `Reprise de la session « ${clean(input.title, 200)} » du projet ${clean(input.projectName, 120)} (Nuera Dev).`,
    "La conversation précédente de Claude Code n'a pas pu être rouverte : voici un résumé de l'historique enregistré par Nuera Dev.",
    input.branch ? `Branche : ${clean(input.branch, 200)}.` : null,
    input.lastCommit ? `Dernier commit : ${clean(input.lastCommit, 200)}.` : null,
  ].filter((line): line is string => Boolean(line));
  const tail = "Prends connaissance de ce contexte, vérifie l'état du worktree (git status, git log -3), puis résume en quelques lignes où en était le travail et attends mes instructions.";

  const sections: string[][] = [];
  const instructions = input.instructions.slice(-MAX_INSTRUCTIONS).map((text) => clean(text, INSTRUCTION_CHARS)).filter(Boolean);
  if (instructions.length) sections.push(['Dernières instructions :', ...instructions.map((text, i) => `${i + 1}. ${text}`)]);
  const messages = input.messages.slice(-MAX_MESSAGES).map((text) => clean(text, MESSAGE_CHARS)).filter(Boolean);
  if (messages.length) sections.push(['Derniers messages de Claude :', ...messages.map((text) => `- ${text}`)]);
  const files = [...new Set(input.files.map((file) => clean(file, 200)).filter(Boolean))].slice(0, MAX_FILES);
  if (files.length) sections.push([`Fichiers modifiés : ${files.join(', ')}.`]);

  // Longest first sections are trimmed until the whole text fits.
  const render = () => [head.join('\n'), ...sections.map((lines) => lines.join('\n')), tail].join('\n\n');
  let text = render();
  while (text.length > RESUME_CONTEXT_MAX_CHARS) {
    const longest = sections.reduce((best, lines, index) => (lines.length > 1 && lines.join('\n').length > (sections[best]?.join('\n').length ?? 0) ? index : best), 0);
    const lines = sections[longest];
    if (!lines || lines.length <= 1) break;
    // Drop the oldest entry of that section (its first item after the heading).
    lines.splice(1, 1);
    if (lines.length === 1) sections.splice(longest, 1);
    text = render();
  }
  return text.length > RESUME_CONTEXT_MAX_CHARS ? `${text.slice(0, RESUME_CONTEXT_MAX_CHARS - 1)}…` : text;
}

const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const COMMIT_LINE = /\[[^\]\s]+ ([0-9a-f]{7,12})\] ([^\n]{1,160})/;

/**
 * Data of {@link buildResumeContext} read from the session's stored events (the caller has
 * already scoped the session to the space). The last commit is the last `git commit` output a
 * Bash step printed, if any (never asked to the runner: its worktree may be the one being recreated).
 */
export async function readResumeContextInput(sessionId: string): Promise<Omit<ResumeContextInput, 'title' | 'projectName' | 'branch' | 'secrets'>> {
  const rows = await db
    .select({ kind: sessionEvents.kind, payload: sessionEvents.payload })
    .from(sessionEvents)
    .where(and(eq(sessionEvents.sessionId, sessionId), inArray(sessionEvents.kind, ['instruction', 'assistant', 'tool'])))
    .orderBy(desc(sessionEvents.position))
    .limit(400);
  const instructions: string[] = [];
  const messages: string[] = [];
  const files: string[] = [];
  let lastCommit: string | null = null;
  for (const row of rows) {
    const payload = row.payload as Record<string, unknown>;
    const text = typeof payload.text === 'string' ? payload.text : null;
    if (row.kind === 'instruction' && text && instructions.length < MAX_INSTRUCTIONS) instructions.unshift(text);
    else if (row.kind === 'assistant' && text && messages.length < MAX_MESSAGES) messages.unshift(text);
    else if (row.kind === 'tool') {
      const tool = typeof payload.tool === 'string' ? payload.tool : '';
      const target = typeof payload.target === 'string' ? payload.target : null;
      if (FILE_TOOLS.has(tool) && target && payload.status === 'done' && files.length < MAX_FILES && !files.includes(target)) files.push(target);
      if (!lastCommit && tool === 'Bash' && typeof payload.output === 'string') {
        const match = COMMIT_LINE.exec(payload.output);
        if (match) lastCommit = `${match[1]} ${match[2]}`;
      }
    }
  }
  return { instructions, messages, files, lastCommit };
}
