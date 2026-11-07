/**
 * « Aperçu » — a dev server that does not start is handed to Claude in the current session
 * (« Demander à Claude de corriger automatiquement »). Pure: the failure rules shared by the
 * browser (when to ask) and the server (whether to accept), and the instruction text.
 */
import { redactSecrets as redactCommonSecrets } from '@nuera/shared/runner';
import { terminalText } from '@/components/dev/lib/ansi';

/** Lines of output given to Claude (the end of the output: where a start-up error is). */
export const AUTODEBUG_TAIL_LINES = 80;
/** Characters of output given to Claude at most (after redaction), the end kept. */
export const AUTODEBUG_OUTPUT_MAX = 8_000;
/** A dev server still without a port this long after its start, with errors in its output, is stuck. */
export const AUTODEBUG_STALL_MS = 60_000;

/** Output lines that say something went wrong (« Error: », « ERR! », « Failed to compile », stack traces). */
const ERROR_LINE = /\berr!|\b(error|erreur|failed|failure|exception|cannot find|not found|unhandled|traceback|panic|elifecycle|eaddrinuse|enoent|eacces)\b|^\s+at\s.+:\d+/im;

export function outputShowsErrors(output: string): boolean {
  return ERROR_LINE.test(terminalText(output));
}

export type DevServerFailure = 'exit' | 'stalled';

/**
 * Why a dev server counts as « ne démarre pas »: it ended in failure (`exit`: non-zero code), or it
 * still runs without a detected port {@link AUTODEBUG_STALL_MS} after its start while its output
 * shows errors (`stalled`). null: not (or not yet) a failure.
 */
export function devServerFailure(
  run: { status: string; port: number | null; startedAt: string; exitCode?: number | null },
  output: string,
  now: number = Date.now(),
): DevServerFailure | null {
  if (run.status === 'failed') return 'exit';
  if (run.status !== 'running' || run.port) return null;
  const started = Date.parse(run.startedAt);
  if (!Number.isFinite(started) || now - started < AUTODEBUG_STALL_MS) return null;
  return outputShowsErrors(output) ? 'stalled' : null;
}

/** The last {@link AUTODEBUG_TAIL_LINES} non-empty-ended lines of an output, as a terminal shows them. */
export function outputTail(output: string, lines = AUTODEBUG_TAIL_LINES): string {
  const all = terminalText(output)
    .split('\n')
    .map((line) => line.trimEnd());
  while (all.length && !all[all.length - 1]) all.pop();
  while (all.length && !all[0]) all.shift();
  return all.slice(-lines).join('\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Credentials removed from a text given to Claude: the values of the project's variables (exact
 * match, 6 characters or more) then the runner's patterns (tokens, keys, Authorization headers…).
 */
export function redactForClaude(text: string, knownSecrets: ReadonlyArray<string | null | undefined> = []): string {
  let out = text;
  const secrets = [...new Set(knownSecrets.filter((s): s is string => typeof s === 'string' && s.length >= 6))].sort((a, b) => b.length - a.length);
  for (const secret of secrets) out = out.replace(new RegExp(escapeRegExp(secret), 'g'), '[masqué]');
  return redactCommonSecrets(out);
}

/** A Markdown fence longer than any run of backticks of the text (the output cannot close it). */
function longestTicks(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return longest;
}

function fenceFor(text: string): string {
  return '`'.repeat(Math.max(3, longestTicks(text) + 1));
}

function inlineCode(text: string): string {
  const longest = longestTicks(text);
  if (!longest) return `\`${text}\``;
  const fence = '`'.repeat(longest + 1);
  return `${fence} ${text} ${fence}`;
}

export interface AutodebugInstructionInput {
  /** Dev server name (« client »). */
  name: string;
  command: string;
  output: string;
  failure: DevServerFailure;
  exitCode?: number | null;
  /** Values of the project's variables, never given to Claude. */
  knownSecrets?: ReadonlyArray<string | null | undefined>;
}

/**
 * The instruction typed into the session: the server, its command, the end of its output (last
 * {@link AUTODEBUG_TAIL_LINES} lines, redacted, {@link AUTODEBUG_OUTPUT_MAX} characters at most)
 * and what is asked of Claude.
 */
export function buildAutodebugInstruction(input: AutodebugInstructionInput): string {
  const secrets = input.knownSecrets ?? [];
  let tail = redactForClaude(outputTail(input.output), secrets);
  if (tail.length > AUTODEBUG_OUTPUT_MAX) {
    const cut = tail.slice(tail.length - AUTODEBUG_OUTPUT_MAX);
    const newline = cut.indexOf('\n');
    tail = `…\n${newline >= 0 && newline < 200 ? cut.slice(newline + 1) : cut}`;
  }
  const command = redactForClaude(input.command, secrets);
  const fence = fenceFor(tail);
  const how =
    input.failure === 'exit'
      ? `ne démarre pas : il s'est arrêté${input.exitCode !== null && input.exitCode !== undefined ? ` avec le code ${input.exitCode}` : ''}`
      : "ne démarre pas : aucun port n'apparaît dans sa sortie, qui montre des erreurs";
  return [
    `Le serveur de développement « ${input.name} » (${inlineCode(command)}) ${how}. Voici la fin de sa sortie :`,
    '',
    fence,
    tail || '(aucune sortie)',
    fence,
    '',
    "Trouve la cause et corrige-la si c'est dans le code ou la configuration du projet, puis dis-moi comment relancer.",
  ].join('\n');
}
