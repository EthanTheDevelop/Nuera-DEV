/**
 * Pure logic of the Workspace (tested in `thread.test.ts`): conversation store (upsert by
 * key / version), session status → composer / header / persistence copy, panel defaults, W1
 * suggestions and W3 summary inputs. No React, no I/O.
 */
import type { ComposerState, PermissionOption, PersistenceContext, SessionSuggestion } from '@/components/dev';
import type { PermissionRequestDto, SessionEventItem } from '@nuera/shared/runner';
import type { SessionStatusEvent } from '@nuera/shared/events';
import { formatDuration, formatTime } from '@nuera/shared/format';
import {
  isLiveStatus,
  type SessionStatus,
  type WorkspacePanel,
  type WorkspaceSession,
} from './contract';

// ---------------------------------------------------------------------------------------------
// Conversation store
// ---------------------------------------------------------------------------------------------

export type ThreadMap = ReadonlyMap<string, SessionEventItem>;

export function itemKey(item: Pick<SessionEventItem, 'key' | 'id'>): string {
  return item.key ?? `id:${item.id}`;
}

/** Upserts items (a newer `version` wins; equal versions replace, older ones are ignored). */
export function upsertItems(map: ThreadMap, items: readonly SessionEventItem[]): ThreadMap {
  if (items.length === 0) return map;
  let next: Map<string, SessionEventItem> | null = null;
  for (const item of items) {
    const key = itemKey(item);
    const existing = (next ?? map).get(key);
    if (existing && existing.version > item.version) continue;
    next ??= new Map(map);
    next.set(key, item);
  }
  return next ?? map;
}

/** Display order = creation order (`position`). */
export function orderedItems(map: ThreadMap): SessionEventItem[] {
  return [...map.values()].sort((a, b) => a.position - b.position || a.id - b.id);
}

export function maxVersion(map: ThreadMap, floor = 0): number {
  let version = floor;
  for (const item of map.values()) if (item.version > version) version = item.version;
  return version;
}

// ---------------------------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------------------------

/** Applies a `session.status` event to the session view. */
export function applyStatusEvent(session: WorkspaceSession, event: SessionStatusEvent): WorkspaceSession {
  if (event.sessionId !== session.id) return session;
  return {
    ...session,
    status: event.status,
    live: event.live,
    currentActivity: event.currentActivity,
    startedAt: event.startedAt ?? session.startedAt,
    endedAt: event.endedAt,
    lastActivityAt: event.lastActivityAt ?? session.lastActivityAt,
    errorCode: event.errorCode,
    errorMessage: event.errorMessage,
    cliStatus: event.cliStatus ?? session.cliStatus,
    queuedInstructions: event.queuedInstructions,
  };
}

/**
 * Whether a `session.status` event needs a fresh server snapshot: once the CLI is gone, whether the
 * session can be resumed (`resumable`, computed by the runner: worktree and conversation present)
 * is not carried by the event — without it « Reprendre la session » stays hidden until a reload.
 */
export function statusNeedsSnapshot(event: Pick<SessionStatusEvent, 'live' | 'status'>): boolean {
  return !event.live && event.status !== 'new';
}

/** Keeps the pending permission in sync with `session.permission` events. */
export function applyPermissionEvent(current: PermissionRequestDto | null, next: PermissionRequestDto): PermissionRequestDto | null {
  if (next.status === 'pending') return next;
  // Moved to the terminal: the CLI still waits there (official dialog), keep it as the open request.
  if (next.status === 'answered_in_terminal') return next;
  return current && current.id === next.id ? null : current;
}

export interface ComposerInputs {
  status: SessionStatus;
  /** Browser ↔ server stream lost (W7). */
  reconnecting: boolean;
  /** Claude CLI not usable (T6). */
  claudeBlocked: boolean;
  /** The worktree was removed: nothing can run any more. */
  worktreeMissing: boolean;
  resumable: boolean;
}

/** Composer variant (`Dev · Compositeur` Prêt / En cours / Attente, W7, T6). */
export function composerStateFor(input: ComposerInputs): { state: ComposerState; reason: string | null } {
  if (input.reconnecting) return { state: 'reconnecting', reason: null };
  if (input.claudeBlocked) {
    return { state: 'unavailable', reason: 'Claude Code est déconnecté : reconnectez-le pour envoyer une instruction…' };
  }
  if (input.worktreeMissing) {
    return { state: 'unavailable', reason: 'Le worktree de cette session a été supprimé : la session ne peut plus reprendre…' };
  }
  switch (input.status) {
    case 'waiting_permission':
      return { state: 'waiting_permission', reason: null };
    case 'running':
      return { state: 'running', reason: null };
    case 'archived':
      return { state: 'unavailable', reason: 'Session archivée : sa conversation reste lisible…' };
    case 'interrupted':
    case 'stopped':
    case 'failed':
      return input.resumable
        ? { state: 'ready', reason: null }
        : { state: 'unavailable', reason: 'Reprise impossible : la conversation enregistrée est introuvable…' };
    default:
      return { state: 'ready', reason: null };
  }
}

/** Persistence line under the composer (D05, W1, W3, W7). */
export function persistenceContextFor(input: {
  status: SessionStatus;
  host: string;
  reconnecting: boolean;
  lastSignalSeconds: number;
  permissionPending: boolean;
}): PersistenceContext {
  if (input.reconnecting) {
    return { kind: 'reconnecting', lastSignalSeconds: input.lastSignalSeconds, permissionPending: input.permissionPending };
  }
  if (input.status === 'new') return { kind: 'new' };
  if (isLiveStatus(input.status)) return { kind: 'live', host: input.host };
  return { kind: 'ended' };
}

const ENDED_VERB: Partial<Record<SessionStatus, string>> = {
  finished: 'terminée',
  stopped: 'arrêtée',
  interrupted: 'interrompue',
  failed: 'en échec',
};

function validDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Elapsed time of a live session / total duration of an ended one (ms), null when unknown. */
export function sessionDurationMs(session: Pick<WorkspaceSession, 'startedAt' | 'endedAt' | 'status'>, now: number): number | null {
  const started = validDate(session.startedAt);
  if (!started) return null;
  const ended = isLiveStatus(session.status) ? null : validDate(session.endedAt);
  return Math.max(0, (ended ? ended.getTime() : now) - started.getTime());
}

/**
 * Context meta of the header: `tmux · 12 min · vit sur VPS-3`, `pas encore démarrée`,
 * `tmux · terminée à 11:00`.
 */
export function headerMeta(
  session: Pick<WorkspaceSession, 'status' | 'backend' | 'startedAt' | 'endedAt'>,
  host: string,
  now: number,
): string {
  const runtime = session.backend === 'tmux' ? 'tmux' : 'PTY';
  if (session.status === 'new') return 'pas encore démarrée';
  if (isLiveStatus(session.status)) {
    const elapsed = sessionDurationMs(session, now);
    return elapsed === null ? `${runtime} · vit sur ${host}` : `${runtime} · ${formatDuration(elapsed)} · vit sur ${host}`;
  }
  const verb = ENDED_VERB[session.status];
  const ended = validDate(session.endedAt);
  if (verb && ended) return `${runtime} · ${verb} à ${formatTime(ended)}`;
  if (verb) return `${runtime} · ${verb}`;
  return runtime;
}

/** Phone status row: `12 min · vit sur VPS-3` (no runtime word). */
export function phoneStatusMeta(session: Pick<WorkspaceSession, 'status' | 'backend' | 'startedAt' | 'endedAt'>, host: string, now: number): string {
  const meta = headerMeta(session, host, now);
  return meta.replace(/^(tmux|PTY) · /, '');
}

/** Default context-panel tab: the changes when there are some (D05), else the files (W1). */
export function defaultPanel(status: SessionStatus, changedFiles: number | null): Exclude<WorkspacePanel, 'ferme'> {
  if (status === 'new') return 'fichiers';
  return changedFiles === 0 ? 'fichiers' : 'modifications';
}

/** Something can leave the VPS: uncommitted files, or commits the remote branch does not have. */
export function canPrepareCommit(input: {
  worktreePresent: boolean;
  changedFiles: number | null;
  branch: { ahead: number; upstream: { ahead: number } | null } | null;
}): boolean {
  if (!input.worktreePresent) return false;
  if ((input.changedFiles ?? 0) > 0) return true;
  if (!input.branch) return false;
  return input.branch.upstream ? input.branch.upstream.ahead > 0 : input.branch.ahead > 0;
}

// ---------------------------------------------------------------------------------------------
// Permission card
// ---------------------------------------------------------------------------------------------

export type PermissionPayload = Extract<SessionEventItem, { kind: 'permission' }>['payload'];

/** Buttons of the card, in the CLI's order (max 3). */
export function permissionOptionsOf(payload: Pick<PermissionPayload, 'options'>): PermissionOption[] {
  return payload.options.slice(0, 3).map((option) => ({ id: option.id, kind: option.id, label: option.label }));
}

/**
 * Status drawn by the card. A request whose wait ran out (`answered_in_terminal`) while the session
 * still waits for it is still open — in the terminal (« Répondre dans le terminal »).
 */
export function permissionCardStatus(
  payload: Pick<PermissionPayload, 'status' | 'permissionId'>,
  sessionStatus: SessionStatus,
  open: PermissionRequestDto | null,
): PermissionPayload['status'] {
  // A request still marked pending in a session whose CLI is gone can no longer be answered.
  if (payload.status === 'pending') return isLiveStatus(sessionStatus) ? 'pending' : 'cancelled';
  if (payload.status === 'answered_in_terminal' && sessionStatus === 'waiting_permission' && open?.id === payload.permissionId) {
    return 'expired';
  }
  return payload.status;
}

// ---------------------------------------------------------------------------------------------
// W1 / W3
// ---------------------------------------------------------------------------------------------

/**
 * W1 suggestions — instructions put in the composer (never sent by themselves). Built from what
 * the project has: its CLAUDE.md, its test command. Nothing about the code is guessed.
 */
export function newSessionSuggestions(input: { hasClaudeMd: boolean; testCommand: string | null }): SessionSuggestion[] {
  const suggestions: SessionSuggestion[] = [{ icon: 'book', label: "Explique la structure du dépôt avant d'y toucher" }];
  if (input.testCommand) suggestions.push({ icon: 'list-checks', label: 'Lance les tests du projet et résume les échecs' });
  if (input.hasClaudeMd) suggestions.push({ icon: 'file', label: 'Résume les règles de CLAUDE.md que tu vas suivre' });
  return suggestions;
}

/** Claude's last message (verbatim), for the W3 summary. */
export function lastAssistantText(items: readonly SessionEventItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.kind === 'assistant') return item.payload.text;
  }
  return null;
}

/** Bullet lines of a message, verbatim (`- x`, `* x`, `• x`, `1. x`). */
export function bulletPoints(message: string | null, max = 12): string[] {
  if (!message) return [];
  const points: string[] = [];
  for (const line of message.split(/\r?\n/)) {
    const match = /^\s{0,3}(?:[-*•]|\d{1,2}[.)])\s+(.+?)\s*$/.exec(line);
    if (match?.[1]) points.push(match[1]);
    if (points.length >= max) break;
  }
  return points;
}

/** Commands allowed in the thread (permission items allowed once or always). */
export function allowedCount(items: readonly SessionEventItem[]): number {
  return items.filter((item) => item.kind === 'permission' && (item.payload.status === 'allowed' || item.payload.status === 'allowed_always')).length;
}

/** Last test result reported by a Claude command (`Bash` tool meta), for the Tests tab. */
export function lastClaudeTestRun(items: readonly SessionEventItem[]) {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.kind === 'tool' && item.payload.meta?.kind === 'command' && item.payload.meta.tests) {
      return { command: item.payload.target, tests: item.payload.meta.tests, at: item.payload.finishedAt ?? item.payload.startedAt, status: item.payload.status };
    }
  }
  return null;
}

/** Tools whose completion can change the worktree (refresh the changes). */
const WRITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']);
export function changesWorktree(item: SessionEventItem): boolean {
  return item.kind === 'tool' && item.payload.status !== 'running' && WRITING_TOOLS.has(item.payload.tool);
}

/** Local instructions waiting to show up in the thread (« · en file »). */
export interface PendingInstruction {
  localId: string;
  text: string;
  at: string;
  /** Accepted by the runner but not typed into the CLI yet (« · en file »). */
  queued: boolean;
  /**
   * Highest thread position when it was sent: only a later instruction item can be its echo
   * (independent of the browser clock, which may differ from the server's).
   */
  afterPosition?: number;
}

/** Drops the local echoes that the thread now contains (same text, recorded after it was sent). */
export function reconcilePending(pending: readonly PendingInstruction[], items: readonly SessionEventItem[]): PendingInstruction[] {
  if (pending.length === 0) return [];
  const used = new Set<number>();
  const kept: PendingInstruction[] = [];
  for (const p of pending) {
    const text = p.text.trim();
    const sentAt = new Date(p.at).getTime() - 5_000;
    const after = p.afterPosition;
    const match = items.find(
      (item) =>
        item.kind === 'instruction' &&
        !used.has(item.id) &&
        item.payload.text.trim() === text &&
        (after !== undefined ? item.position > after : new Date(item.payload.at).getTime() >= sentAt),
    );
    if (match) used.add(match.id);
    else kept.push(p);
  }
  return kept;
}

// ---------------------------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------------------------

/** File size of the tree (`4,1 Ko`, `212 o`, `1,2 Mo`). */
export function formatFileSize(bytes: number | null | undefined): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
  const fmt = (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 1, minimumFractionDigits: 0 }).replace(/[  ]/g, ' ');
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${fmt(bytes / 1024)} Ko`;
  if (bytes < 1024 ** 3) return `${fmt(bytes / 1024 ** 2)} Mo`;
  return `${fmt(bytes / 1024 ** 3)} Go`;
}
