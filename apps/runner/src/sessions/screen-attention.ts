/**
 * Interactive screens of the official Claude Code CLI that block a session until someone answers
 * in its terminal (first-run theme picker, login, workspace trust, bypass-permissions warning,
 * Remote Control, `.mcp.json` approval, « Press Enter to continue », any other selection menu).
 *
 * Pure: reads the visible screen of the session's headless mirror (`Terminal.viewportText()`, ANSI
 * already interpreted) and answers what is on it. Wording changes between CLI versions: each entry
 * matches a few stable fragments, and every pattern lives in {@link SCREEN_PATTERNS} (tested on
 * screen snapshots in `test/screen-attention.test.ts`).
 *
 * Only `theme` and `continue` may be answered by the runner (Enter accepts the highlighted
 * default; purely cosmetic). Login, trust, bypass, Remote Control, MCP approval and unknown menus
 * grant rights or choose an account: they are ALWAYS left to a human (CLAUDE.md rule 1,
 * docs/research/claude-code.md §13.4).
 */
import { SESSION_ATTENTION_TEXT_MAX, type SessionAttentionKind } from '@nuera/shared/runner';
import { redactSecrets } from '../safety/redact';

export interface ScreenPattern {
  kind: SessionAttentionKind;
  /** The screen shows this kind when ANY of these matches… */
  any: RegExp[];
  /** …and ALL of these match (extra conditions). */
  all?: RegExp[];
  /** …and NONE of these matches. */
  none?: RegExp[];
  /**
   * false: a message printed above the normal prompt (« Login expired · Please run /login »): the
   * owner is told, but typing still reaches the prompt. Default true (a screen that takes the keys).
   */
  blocks?: boolean;
}

/** Selection cursor of an Ink menu: `❯ 1. Yes` (numbered) or `❯ ✔ Dark mode`. */
const MENU_CURSOR = /^\s*[❯>›]\s*(?:\d+\.|✔|◯|◉|\[[ x]\])\s*\S/m;
/** A second option line of a numbered menu (`  2. No, exit`). */
const MENU_OPTION = /^\s{2,}(?:\d+\.|✔|◯|◉)\s*\S/m;
const YES_NO = /\(y\/n\)\s*$/im;

/**
 * Ordered: the first kind that matches wins, rights-granting screens before cosmetic ones, so that
 * a screen mixing fragments is never answered automatically.
 */
export const SCREEN_PATTERNS: readonly ScreenPattern[] = [
  {
    kind: 'login',
    any: [
      /select login method/i,
      /claude account with subscription/i,
      /anthropic console account/i,
      /paste code here/i,
      /browser didn'?t open\?/i,
    ],
  },
  { kind: 'login', any: [/(?:not logged in|login expired|oauth token (?:has been )?revoked|invalid api key)[^\n]{0,40}\/login/i], blocks: false },
  {
    kind: 'trust',
    any: [
      /do you trust the files in this folder/i,
      /yes,? i trust this folder/i,
      /is this a project you created or one you trust/i,
      /trust (?:the files in )?this (?:folder|workspace|directory)\?/i,
      /quick safety check/i,
    ],
  },
  {
    kind: 'bypass_warning',
    any: [/running in bypass permissions mode/i, /accept all responsibility/i, /bypass permissions mode[\s\S]{0,600}yes,? i accept/i],
  },
  { kind: 'remote_control', any: [/enable remote control\?/i, /remote control[^\n]{0,60}\(y\/n\)/i] },
  {
    kind: 'mcp_servers',
    any: [/new mcp servers? found in/i, /use this and all future mcp servers/i, /continue without using th(?:is|ese) mcp servers?/i],
  },
  {
    kind: 'theme',
    any: [/text style that looks best/i, /to change this later,? run \/theme/i, /choose the (?:text style|theme|color theme)/i, /dark mode[\s\S]{0,400}light mode/i],
    all: [MENU_CURSOR],
  },
  {
    kind: 'continue',
    any: [/press enter to continue/i],
    // A choice or a question on the same screen is never « just continue ».
    none: [MENU_CURSOR, YES_NO],
  },
  { kind: 'menu', any: [MENU_CURSOR], all: [MENU_OPTION] },
  { kind: 'menu', any: [YES_NO] },
];

/** Kinds the runner answers itself (Enter on the highlighted default). */
export const AUTO_ANSWERED_KINDS: ReadonlySet<SessionAttentionKind> = new Set(['theme', 'continue']);

export interface ScreenDetection {
  kind: SessionAttentionKind;
  /** Screen excerpt shown to the owner (frames removed, secrets masked, ≤ 400 characters). */
  text: string;
  /** Stable identity of what is shown (kind + excerpt): « the same screen » across evaluations. */
  fingerprint: string;
  /** The screen takes the keys: an instruction typed now would be lost (or answer it). */
  blocks: boolean;
}

const FRAME = /[│┃║╭╮╰╯┌┐└┘├┤┬┴┼─━═╌╍┄┅▔▁▏▕]/g;

/** Lines of the screen without box-drawing frames nor trailing spaces. */
function cleanLines(screen: string): string[] {
  // eslint-disable-next-line no-control-regex
  const plain = screen.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
  return plain.split('\n').map((line) => line.replace(FRAME, ' ').replace(/\s+$/, ''));
}

/** Login codes, OAuth parameters and long tokens never leave the runner in an excerpt. */
function maskSensitive(text: string): string {
  return redactSecrets(text)
    .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1?…')
    .replace(/[A-Za-z0-9_\-#~+=]{32,}/g, '…');
}

/**
 * Excerpt from `before` lines above the first line matching one of `anchors` (single-line
 * fragments), then until ~400 characters. Frames removed, blank runs collapsed, common indent dropped.
 */
export function screenExcerpt(lines: readonly string[], anchors: readonly RegExp[], max = SESSION_ATTENTION_TEXT_MAX, before = 3): string {
  const kept: string[] = [];
  let blank = false;
  for (const line of lines) {
    if (!line.trim()) {
      if (kept.length && !blank) kept.push('');
      blank = true;
      continue;
    }
    blank = false;
    kept.push(line);
  }
  while (kept.length && !kept[kept.length - 1]) kept.pop();
  let start = 0;
  const singles = anchors.filter((re) => !re.source.includes('[\\s\\S]')).map((re) => new RegExp(re.source, re.flags.replace('g', '')));
  const index = singles.length ? kept.findIndex((line) => singles.some((re) => re.test(line))) : -1;
  if (index > 0) start = Math.max(0, index - before);
  const slice = kept.slice(start);
  const indent = Math.min(...slice.filter(Boolean).map((line) => /^\s*/.exec(line)![0].length));
  let out = '';
  for (const line of slice) {
    const masked = maskSensitive(line.slice(Number.isFinite(indent) ? indent : 0));
    const next = out ? `${out}\n${masked}` : masked;
    if (next.length > max) {
      if (!out) out = `${masked.slice(0, max - 1)}…`;
      else if (out.length <= max - 2) out = `${out}\n…`;
      break;
    }
    out = next;
  }
  return out.slice(0, max);
}

/**
 * What the visible screen of the CLI asks, or null when nothing blocks it (normal prompt, Claude
 * at work…). `screen` = visible rows only (never the scrollback).
 */
export function detectScreen(screen: string): ScreenDetection | null {
  const lines = cleanLines(screen);
  const text = lines.join('\n');
  if (!text.trim()) return null;
  for (const pattern of SCREEN_PATTERNS) {
    const hit = pattern.any.find((re) => re.test(text));
    if (!hit) continue;
    if (pattern.all && !pattern.all.every((re) => re.test(text))) continue;
    if (pattern.none?.some((re) => re.test(text))) continue;
    // The earliest line that shows this kind; a generic menu starts a few lines above its cursor.
    const anchors = pattern.kind === 'menu' ? pattern.any : [...pattern.any, ...(MENU_CURSOR.test(text) ? [MENU_CURSOR] : [])];
    const excerpt = screenExcerpt(lines, anchors, SESSION_ATTENTION_TEXT_MAX, pattern.kind === 'menu' ? 5 : 3);
    return { kind: pattern.kind, text: excerpt, fingerprint: `${pattern.kind}:${excerpt}`, blocks: pattern.blocks ?? true };
  }
  return null;
}
