/**
 * Browser calls of the project routes (same origin, session cookie). Errors carry the French
 * message of the API body plus the runner `reason` / `data` the A4, T4 and T8 states need.
 */
import type {
  AddReposResult,
  ArchivePreviewView,
  BranchesView,
  ClaudeMdView,
  CreateProjectResult,
  DestinationView,
  EnvVarView,
  ProjectErrorBody,
  ProjectListItem,
  ProjectMcpToolView,
  RepoPreview,
  RunView,
  WorktreeRemovalPreview,
} from '@/server/projects/types';

export class ProjectApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly detail?: string;
  readonly raw?: string;
  readonly untouched?: string;
  readonly reason?: string;
  readonly data?: Record<string, unknown>;

  constructor(status: number, code: string | null, message: string, extra: Omit<ProjectErrorBody['error'], 'code' | 'message'> = {}) {
    super(message);
    this.name = 'ProjectApiError';
    this.status = status;
    this.code = code;
    if (extra.detail) this.detail = extra.detail;
    if (extra.raw) this.raw = extra.raw;
    if (extra.untouched) this.untouched = extra.untouched;
    if (extra.reason) this.reason = extra.reason;
    if (extra.data) this.data = extra.data;
  }

  /** VPS-3 (the runner) does not answer. */
  get unavailable(): boolean {
    return this.code === 'RUNNER_UNAVAILABLE';
  }
}

export const NETWORK_MESSAGE = 'Le serveur web ne répond pas : vérifiez la connexion, puis réessayez.';

const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

export async function projectFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    });
  } catch {
    throw new ProjectApiError(0, 'NETWORK', NETWORK_MESSAGE);
  }
  if (!response.ok) {
    let body: Partial<ProjectErrorBody> | null = null;
    try {
      body = (await response.json()) as Partial<ProjectErrorBody>;
    } catch {
      body = null;
    }
    const error = body?.error;
    throw new ProjectApiError(response.status, str(error?.code) ?? null, str(error?.message) ?? `Erreur ${response.status}.`, {
      ...(str(error?.detail) ? { detail: error!.detail } : {}),
      ...(str(error?.raw) ? { raw: error!.raw } : {}),
      ...(str(error?.untouched) ? { untouched: error!.untouched } : {}),
      ...(str(error?.reason) ? { reason: error!.reason } : {}),
      ...(error?.data && typeof error.data === 'object' ? { data: error.data } : {}),
    });
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const p = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;

export const projectsApi = {
  repos: () => projectFetch<AddReposResult>('/api/projects/repos'),
  preview: (fullName: string) => projectFetch<RepoPreview>(`/api/projects/repos/preview?depot=${encodeURIComponent(fullName)}`),
  checkDestination: (path: string, fullName?: string, signal?: AbortSignal) =>
    projectFetch<DestinationView>(
      `/api/projects/destination-check?chemin=${encodeURIComponent(path)}${fullName ? `&depot=${encodeURIComponent(fullName)}` : ''}`,
      signal ? { signal } : {},
    ),
  create: (input: {
    fullName: string;
    branch?: string;
    name: string;
    destination: string;
    installDeps: boolean;
    worktreePerSession: boolean;
    readClaudeMd: boolean;
    commands: Partial<Record<'install' | 'dev' | 'build' | 'test' | 'lint', string | null>>;
  }) => projectFetch<CreateProjectResult>('/api/projects', json('POST', input)),
  retryClone: (projectId: string, destination?: string) =>
    projectFetch<CreateProjectResult>(`${p(projectId)}/clone`, json('POST', destination ? { destination } : {})),
  discard: (projectId: string) => projectFetch<void>(`${p(projectId)}/clone`, json('DELETE')),
  patch: (projectId: string, body: Record<string, unknown>) => projectFetch<ProjectListItem>(p(projectId), json('PATCH', body)),
  archivePreview: (projectId: string) => projectFetch<ArchivePreviewView>(`${p(projectId)}/archive`),
  archive: (projectId: string) => projectFetch<{ archivedSessions: number }>(p(projectId), json('DELETE')),
  restore: (projectId: string) => projectFetch<ProjectListItem>(`${p(projectId)}/restore`, json('POST')),
  sync: (projectId: string) =>
    projectFetch<{ outcome: string; commits: number; project: ProjectListItem }>(`${p(projectId)}/sync`, json('POST')),
  branches: (projectId: string) => projectFetch<BranchesView>(`${p(projectId)}/branches`),
  createBranch: (projectId: string, body: { name: string; from?: string; checkout?: boolean }) =>
    projectFetch<{ branch: string }>(`${p(projectId)}/branches`, json('POST', body)),
  checkout: (projectId: string, branch: string) => projectFetch<{ branch: string }>(`${p(projectId)}/checkout`, json('POST', { branch })),
  worktreePreview: (projectId: string, worktreeId: string) =>
    projectFetch<WorktreeRemovalPreview>(`${p(projectId)}/worktrees/${encodeURIComponent(worktreeId)}`),
  removeWorktree: (projectId: string, worktreeId: string, options: { force: boolean; deleteBranch: boolean }) =>
    projectFetch<{ removed: boolean; branchDeleted: boolean }>(
      `${p(projectId)}/worktrees/${encodeURIComponent(worktreeId)}?force=${options.force ? 1 : 0}&deleteBranch=${options.deleteBranch ? 1 : 0}`,
      json('DELETE'),
    ),
  claudeMd: (projectId: string) => projectFetch<ClaudeMdView>(`${p(projectId)}/claude-md`),
  writeClaudeMd: (projectId: string, body: { content: string; commit: boolean; message?: string }) =>
    projectFetch<{ lines: number; commitSha: string | null }>(`${p(projectId)}/claude-md`, json('PUT', body)),
  createEnv: (projectId: string, body: { key: string; value: string; secret: boolean }) =>
    projectFetch<{ variable: EnvVarView }>(`${p(projectId)}/env`, json('POST', body)),
  updateEnv: (projectId: string, body: { id: string; value?: string; secret?: boolean }) =>
    projectFetch<{ variable: EnvVarView }>(`${p(projectId)}/env`, json('PATCH', body)),
  deleteEnv: (projectId: string, id: string) => projectFetch<{ deleted: boolean }>(`${p(projectId)}/env`, json('DELETE', { id })),
  setMcp: (projectId: string, server: string, enabled: boolean) =>
    projectFetch<ProjectMcpToolView>(`${p(projectId)}/mcp/${encodeURIComponent(server)}`, json('PUT', { enabled })),
  startRun: (body: { projectId: string; worktreeId?: string; kind: string; command?: string }) =>
    projectFetch<{ runId: string }>('/api/runs', json('POST', body)),
  stopRun: (runId: string) => projectFetch<void>(`/api/runs/${encodeURIComponent(runId)}`, json('DELETE')),
  run: (runId: string) =>
    projectFetch<{ run: RunView; live: boolean; outputTail: string | null; projectId: string }>(`/api/runs/${encodeURIComponent(runId)}`),
};

/** Message + extras of any thrown value, for Banner / ErrorPanel. */
export function failureOf(error: unknown, fallback: string): { message: string; detail?: string; untouched?: string; raw?: string; reason?: string } {
  if (error instanceof ProjectApiError) {
    return {
      message: error.message,
      ...(error.detail ? { detail: error.detail } : {}),
      ...(error.untouched ? { untouched: error.untouched } : {}),
      ...(error.raw ? { raw: error.raw } : {}),
      ...(error.reason ? { reason: error.reason } : {}),
    };
  }
  return { message: error instanceof Error && error.message ? error.message : fallback };
}
