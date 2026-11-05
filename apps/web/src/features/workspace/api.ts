/**
 * Browser calls of the Workspace routes (same origin, session cookie). Errors carry the French
 * message of the body (`{ error: { code, message, detail?, raw?, untouched?, reason? } }`) for the
 * inline T4 panels; `reason` is the runner sub-code (SESSION_BUSY_PERMISSION, BRANCH_PROTECTED…).
 */
import type { ChangesResponse, FileContent, FileDiff, TreeEntry } from '@nuera/shared/runner';
import type {
  CommitInput,
  CommitResultView,
  InstructionResult,
  PermissionDecisionInput,
  PermissionRequestDto,
  PullRequestInput,
  PushResultView,
  TerminalResult,
  WorkspaceEventsPage,
  WorkspacePullRequest,
  WorktreeStatusView,
} from './lib/contract';

export class WorkspaceApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly reason: string | null;
  readonly detail?: string;
  readonly raw?: string;
  readonly untouched?: string;

  constructor(
    status: number,
    code: string | null,
    message: string,
    extra: { reason?: string | null; detail?: string; raw?: string; untouched?: string } = {},
  ) {
    super(message);
    this.name = 'WorkspaceApiError';
    this.status = status;
    this.code = code;
    this.reason = extra.reason ?? null;
    if (extra.detail) this.detail = extra.detail;
    if (extra.raw) this.raw = extra.raw;
    if (extra.untouched) this.untouched = extra.untouched;
  }

  /** The browser could not reach the web app (W7 territory). */
  get offline(): boolean {
    return this.code === 'NETWORK';
  }
}

export const NETWORK_MESSAGE = 'Le serveur web ne répond pas : vérifiez la connexion, puis réessayez.';

const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

async function call<T>(url: string, init: RequestInit, fallbackMessage: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
    throw new WorkspaceApiError(0, 'NETWORK', NETWORK_MESSAGE);
  }
  if (!response.ok) {
    let body: { error?: Record<string, unknown> } | null = null;
    try {
      body = (await response.json()) as { error?: Record<string, unknown> } | null;
    } catch {
      body = null;
    }
    const error = body?.error ?? {};
    throw new WorkspaceApiError(response.status, str(error.code) ?? null, str(error.message) ?? fallbackMessage, {
      reason: str(error.reason) ?? null,
      ...(str(error.detail) ? { detail: str(error.detail) } : {}),
      ...(str(error.raw) ? { raw: str(error.raw) } : {}),
      ...(str(error.untouched) ? { untouched: str(error.untouched) } : {}),
    });
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const enc = encodeURIComponent;
const sessionUrl = (id: string) => `/api/sessions/${enc(id)}`;
const worktreeUrl = (id: string) => `/api/worktrees/${enc(id)}`;
const post = (body?: unknown): RequestInit => ({ method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const get = (signal?: AbortSignal): RequestInit => ({ method: 'GET', ...(signal ? { signal } : {}) });

export function sendInstructionRequest(sessionId: string, text: string): Promise<InstructionResult> {
  return call(`${sessionUrl(sessionId)}/instruction`, post({ text }), "L'instruction n'a pas pu être envoyée.");
}

export function interruptRequest(sessionId: string): Promise<{ status: string }> {
  return call(`${sessionUrl(sessionId)}/interrupt`, post(), "Échap n'a pas pu être transmis au CLI.");
}

export function fetchEvents(sessionId: string, afterVersion: number, signal?: AbortSignal): Promise<WorkspaceEventsPage> {
  return call(`${sessionUrl(sessionId)}/events?afterVersion=${afterVersion}`, get(signal), "Le fil de la session n'a pas pu être rechargé.");
}

export function fetchSessionTerminal(sessionId: string, signal?: AbortSignal): Promise<TerminalResult> {
  return call(`${sessionUrl(sessionId)}/terminal`, get(signal), 'Le terminal de la session est indisponible.');
}

export function decidePermissionRequest(permissionId: string, input: PermissionDecisionInput): Promise<PermissionRequestDto> {
  return call(`/api/permissions/${enc(permissionId)}/decision`, post(input), "La réponse n'a pas pu être transmise au CLI.");
}

export function fetchTree(worktreeId: string, path: string, signal?: AbortSignal): Promise<{ path: string; entries: TreeEntry[]; truncated: boolean }> {
  return call(`${worktreeUrl(worktreeId)}/tree?path=${enc(path)}`, get(signal), "Le dossier n'a pas pu être lu.");
}

export function fetchFile(worktreeId: string, path: string, signal?: AbortSignal): Promise<FileContent> {
  return call(`${worktreeUrl(worktreeId)}/file?path=${enc(path)}`, get(signal), "Le fichier n'a pas pu être lu.");
}

export function fetchChanges(worktreeId: string, signal?: AbortSignal): Promise<ChangesResponse> {
  return call(`${worktreeUrl(worktreeId)}/changes`, get(signal), 'Les modifications du worktree sont indisponibles.');
}

export function fetchDiff(worktreeId: string, path: string, signal?: AbortSignal): Promise<FileDiff> {
  return call(`${worktreeUrl(worktreeId)}/diff?path=${enc(path)}`, get(signal), "Le diff de ce fichier n'a pas pu être lu.");
}

export function fetchWorktreeStatus(worktreeId: string, signal?: AbortSignal): Promise<WorktreeStatusView> {
  return call(`${worktreeUrl(worktreeId)}/status`, get(signal), "L'état Git du worktree est indisponible.");
}

export function stageRequest(worktreeId: string, paths: string[]): Promise<unknown> {
  return call(`${worktreeUrl(worktreeId)}/stage`, post({ paths }), "Le fichier n'a pas pu être indexé.");
}

export function unstageRequest(worktreeId: string, paths: string[]): Promise<unknown> {
  return call(`${worktreeUrl(worktreeId)}/unstage`, post({ paths }), "Le fichier n'a pas pu être retiré de l'index.");
}

export function commitRequest(worktreeId: string, input: CommitInput): Promise<CommitResultView> {
  return call(`${worktreeUrl(worktreeId)}/commit`, post(input), "Le commit n'a pas pu être créé.");
}

export function pushRequest(worktreeId: string, sessionId?: string): Promise<PushResultView> {
  return call(`${worktreeUrl(worktreeId)}/push`, post(sessionId ? { sessionId } : {}), "Le push vers GitHub n'a pas abouti.");
}

export function pullRequestRequest(worktreeId: string, input: PullRequestInput): Promise<WorkspacePullRequest> {
  return call(`${worktreeUrl(worktreeId)}/pull-request`, post(input), "La pull request n'a pas pu être ouverte.");
}

// --- PROJECTS lot routes (tests of the worktree) -------------------------------------------------

export interface RunListItem {
  id: string;
  kind: string;
  command: string;
  status: 'running' | 'succeeded' | 'failed' | 'stopped';
  exitCode: number | null;
  summary: string | null;
  worktreeId: string | null;
  startedAt: string;
  finishedAt: string | null;
  tests: { passed: number; failed: number; skipped: number; total: number } | null;
}

export interface RunDetailView {
  run: RunListItem;
  live: boolean;
  outputTail: string | null;
  tests: {
    counts: { passed: number; failed: number; skipped: number; running: number; total: number; durationMs: number | null };
    tests: Array<{ name: string; status: 'passed' | 'failed' | 'running' | 'skipped'; durationMs: number | null; location: string | null }>;
    failures: Array<{ name: string; location: string | null; excerpt: string }>;
  } | null;
}

export function fetchRuns(projectId: string, worktreeId: string, signal?: AbortSignal): Promise<{ runs: RunListItem[] }> {
  return call(
    `/api/runs?projectId=${enc(projectId)}&worktreeId=${enc(worktreeId)}&limit=10`,
    get(signal),
    'Les dernières exécutions sont indisponibles.',
  );
}

export function fetchRun(runId: string, signal?: AbortSignal): Promise<RunDetailView> {
  return call(`/api/runs/${enc(runId)}`, get(signal), "L'exécution n'a pas pu être lue.");
}

export function startTestsRequest(projectId: string, worktreeId: string): Promise<{ runId: string }> {
  return call('/api/runs', post({ projectId, worktreeId, kind: 'test' }), "Les tests n'ont pas pu être lancés.");
}
