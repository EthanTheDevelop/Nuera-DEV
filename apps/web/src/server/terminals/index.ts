import 'server-only';
import { projects, worktrees } from '@nuera/db/schema';
import type { TerminalDto, TerminalInputRequestSchema, TerminalResizeRequestSchema } from '@nuera/shared/runner';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { AppError, formatZodIssues } from '@/server/errors';
import { RunnerError, type RunnerClient } from '@/server/runner/client';
import { assertRateLimit, type RateLimitRule } from '@/server/security/rate-limit';
import { getGitIdentity } from '@/server/sessions';
import { requireEnvironment, type EnvironmentRef, type RequestContext } from '@/server/tenancy/context';
import {
  auditIn,
  invalidateTerminalScope,
  NOT_FOUND_MESSAGES,
  ofSpace,
  scopeOfTerminal,
  scopeOfTerminalInput,
  scopeOfWorktree,
  TERMINAL_ID_PATTERN,
} from '@/server/tenancy/scope';

/**
 * Browser terminals (xterm.js in `@/components/terminal`) opened through the runner of a server —
 * the web never spawns anything itself (docs/MULTICOMPTE.md §5, §11).
 *
 *   const terminal = await openTerminal(ctx, { kind: 'shell', worktreeId });
 *   const terminal = await openTerminal(ctx, { kind: 'claude-login' });   // `claude auth login`
 *   const terminal = await openTerminal(ctx, { kind: 'claude-status' });  // interactive CLI, /status
 *   const terminal = await getTerminal(ctx, id);
 *   await sendTerminalInput(ctx, id, { data });  await resizeTerminal(ctx, id, { cols, rows });
 *   await closeTerminal(ctx, id);
 *
 * - A shell opens in a worktree of the space, on the server holding it (which must be the space's
 *   server: the terminal is then reached through it). It carries the account (`actorUserId`, kept
 *   by the runner as the terminal's owner) and its Git identity (GIT_AUTHOR_* / GIT_COMMITTER_*).
 * - Login and /status terminals open on the space's server, for the owner of the space only (one
 *   server = one person = one Claude connection, §1.2). `mcp-login` stays in `startMcpLogin`
 *   (`@/server/mcp`), which applies the same check (`requireMcpLoginServer`, same copy, suspended
 *   server refused); `session` terminals belong to
 *   the session manager (GET /v1/sessions/:id/terminal).
 * - Reading, typing, resizing and closing go through `scopeOfTerminal()`: a terminal of another
 *   account answers exactly like an unknown one (« Terminal introuvable ou fermé. »).
 * - Login and /status terminals are private on the runner: output never logged nor persisted,
 *   scrollback dropped on close. Nothing typed or shown in them reaches the database or the audit.
 * - Every opening is audited in the space (`terminal.open`, French summary, kind in metadata) and
 *   rate limited per account and kind (login terminals the strictest).
 */

/** Terminal ids issued by the runner (random base64url, see `TerminalParamsSchema`). */
export { TERMINAL_ID_PATTERN };
export const terminalIdSchema = z.string().regex(TERMINAL_ID_PATTERN, 'identifiant de terminal invalide');

const sizeFields = {
  cols: z.number().int().min(10).max(500).optional(),
  rows: z.number().int().min(4).max(300).optional(),
};

/** Body of POST /api/terminals — the kinds an account may open from the web. */
export const openTerminalInputSchema = z.discriminatedUnion(
  'kind',
  [
    z.object({ kind: z.literal('shell'), worktreeId: z.uuid('worktree invalide'), ...sizeFields }).strict(),
    z.object({ kind: z.literal('claude-login'), ...sizeFields }).strict(),
    z.object({ kind: z.literal('claude-status'), ...sizeFields }).strict(),
  ],
  { error: 'type de terminal non pris en charge (shell, claude-login ou claude-status ; les connexions MCP passent par Intégrations)' },
);
export type OpenTerminalInput = z.input<typeof openTerminalInputSchema>;
export type OpenTerminalKind = OpenTerminalInput['kind'];

/** Per account and kind: login terminals are the strictest (each one starts the CLI login procedure). */
export const TERMINAL_RATE_LIMITS: Readonly<Record<OpenTerminalKind, RateLimitRule>> = {
  shell: { limit: 30, windowMs: 10 * 60_000 },
  'claude-login': { limit: 5, windowMs: 10 * 60_000 },
  'claude-status': { limit: 10, windowMs: 10 * 60_000 },
};

export const TERMINAL_AUDIT_ACTION = 'terminal.open';

/** Copy of an unknown, foreign or removed worktree (kept byte for byte). */
const SHELL_NOT_FOUND = 'Worktree introuvable : il a peut-être été supprimé.';
const SHELL_UNTOUCHED = 'Aucun terminal ouvert.';

/** Refusal of a login terminal to a member who does not own the space (FORBIDDEN). */
export const LOGIN_TERMINAL_OWNER_ONLY = "Seul le propriétaire de l'espace peut connecter Claude Code sur son serveur.";

type TerminalCtx = Pick<RequestContext, 'user' | 'space' | 'environment'>;
type TerminalInputRequest = z.input<typeof TerminalInputRequestSchema>;
type TerminalResizeRequest = z.input<typeof TerminalResizeRequestSchema>;

interface ShellTarget {
  worktreeId: string;
  worktreeName: string;
  projectId: string;
  projectName: string;
  environmentId: string;
  runner: RunnerClient;
}

/**
 * The worktree must be one of the space (same NOT_FOUND as an unknown id otherwise), of a project
 * that is not archived, not removed, and live on the space's server.
 */
async function resolveShellTarget(ctx: TerminalCtx, worktreeId: string): Promise<ShellTarget> {
  const notFound = () => new AppError('NOT_FOUND', SHELL_NOT_FOUND, { untouched: SHELL_UNTOUCHED });
  const scope = await scopeOfWorktree(ctx, worktreeId, { notFound: SHELL_NOT_FOUND, untouched: SHELL_UNTOUCHED });
  const [row] = await db
    .select({
      worktreeId: worktrees.id,
      worktreeName: worktrees.name,
      status: worktrees.status,
      removedAt: worktrees.removedAt,
      projectId: projects.id,
      projectName: projects.name,
      projectArchivedAt: projects.archivedAt,
    })
    .from(worktrees)
    .innerJoin(projects, and(eq(projects.id, worktrees.projectId), eq(projects.environmentId, worktrees.environmentId)))
    .where(ofSpace(ctx, eq(worktrees.id, scope.worktreeId)))
    .limit(1);
  // `missing` is left to the runner: it checks the disk again (the folder may be back).
  if (!row || row.status === 'removed' || row.removedAt !== null || row.projectArchivedAt !== null) throw notFound();
  // The terminal is then reached through the space's server: none yet → « Aucun serveur attribué ».
  const { environment } = requireEnvironment(ctx);
  if (environment.id !== scope.environmentId) {
    throw new AppError('CONFLICT', `Ce worktree est sur ${scope.environmentName}, qui n'est plus le serveur de votre espace.`, {
      untouched: SHELL_UNTOUCHED,
    });
  }
  return {
    worktreeId: row.worktreeId,
    worktreeName: row.worktreeName,
    projectId: row.projectId,
    projectName: row.projectName,
    environmentId: scope.environmentId,
    runner: scope.runner,
  };
}

/**
 * Server of the space for a login terminal (`claude auth login`, /status, `claude mcp login`):
 * AppError CONFLICT NO_ENVIRONMENT without a server, FORBIDDEN for anyone but the space's owner.
 */
export function requireLoginTerminalServer(ctx: Pick<RequestContext, 'space' | 'environment'>): { environment: EnvironmentRef; runner: RunnerClient } {
  const server = requireEnvironment(ctx);
  if (ctx.space.role !== 'owner') throw new AppError('FORBIDDEN', LOGIN_TERMINAL_OWNER_ONLY, { untouched: SHELL_UNTOUCHED });
  return server;
}

function parseInput(input: OpenTerminalInput): z.output<typeof openTerminalInputSchema> {
  const result = openTerminalInputSchema.safeParse(input);
  if (!result.success) throw new AppError('VALIDATION', 'Données invalides.', { detail: formatZodIssues(result.error) });
  return result.data;
}

function sizeOf(input: { cols?: number | undefined; rows?: number | undefined }): { cols?: number; rows?: number } {
  return { ...(input.cols !== undefined ? { cols: input.cols } : {}), ...(input.rows !== undefined ? { rows: input.rows } : {}) };
}

/**
 * Opens a terminal (runner `POST /v1/terminals`) and audits it. Throws AppError VALIDATION /
 * NOT_FOUND (worktree) / CONFLICT NO_ENVIRONMENT / FORBIDDEN / RATE_LIMITED, or the RunnerError of
 * the runner (`RUNNER_UNAVAILABLE`, `CONFLICT` « CLI introuvable » / « Trop de terminaux »,
 * `ENVIRONMENT_DISABLED`…).
 */
export async function openTerminal(ctx: TerminalCtx, input: OpenTerminalInput): Promise<TerminalDto> {
  const parsed = parseInput(input);
  assertRateLimit(`terminal:${parsed.kind}`, ctx.user.id, TERMINAL_RATE_LIMITS[parsed.kind]);
  const size = sizeOf(parsed);

  switch (parsed.kind) {
    case 'shell': {
      const target = await resolveShellTarget(ctx, parsed.worktreeId);
      const gitIdentity = await getGitIdentity(ctx.user);
      const terminal = await target.runner.createTerminal({
        body: { kind: 'shell', worktreeId: target.worktreeId, ...size, actorUserId: ctx.user.id, ...(gitIdentity ? { gitIdentity } : {}) },
      });
      await auditIn(ctx, {
        action: TERMINAL_AUDIT_ACTION,
        summary: `terminal ouvert dans le worktree « ${target.worktreeName} » · ${target.projectName}`,
        targetType: 'worktree',
        targetId: target.worktreeId,
        environmentId: target.environmentId,
        metadata: { kind: 'shell', terminalId: terminal.id, projectId: target.projectId },
      });
      return terminal;
    }
    case 'claude-login': {
      const { environment, runner } = requireLoginTerminalServer(ctx);
      const terminal = await runner.createTerminal({ body: { kind: 'claude-login', ...size, actorUserId: ctx.user.id } });
      await auditIn(ctx, {
        action: TERMINAL_AUDIT_ACTION,
        summary: 'terminal de connexion à Claude Code ouvert (claude auth login)',
        targetType: 'terminal',
        targetId: terminal.id,
        environmentId: environment.id,
        metadata: { kind: 'claude-login' },
      });
      return terminal;
    }
    case 'claude-status': {
      const { environment, runner } = requireLoginTerminalServer(ctx);
      const terminal = await runner.createTerminal({ body: { kind: 'claude-status', ...size, actorUserId: ctx.user.id } });
      await auditIn(ctx, {
        action: TERMINAL_AUDIT_ACTION,
        summary: 'terminal Claude Code ouvert pour /status',
        targetType: 'terminal',
        targetId: terminal.id,
        environmentId: environment.id,
        metadata: { kind: 'claude-status' },
      });
      return terminal;
    }
  }
}

function parseId(id: string): string {
  const result = terminalIdSchema.safeParse(id);
  if (!result.success) throw new AppError('VALIDATION', 'Terminal invalide.', { detail: formatZodIssues(result.error) });
  return result.data;
}

const isNotFound = (error: unknown): boolean => error instanceof AppError && error.code === 'NOT_FOUND';

/**
 * Current state of a terminal of this account on the space's server (any kind, including a
 * session's). NOT_FOUND « Terminal introuvable ou fermé. » once closed, forgotten or not its own.
 */
export async function getTerminal(ctx: TerminalCtx, id: string): Promise<TerminalDto> {
  const scope = await scopeOfTerminal(ctx, parseId(id));
  return scope.terminal;
}

/**
 * Closes a terminal of this account (shell, login, /status, MCP login). Idempotent: an already
 * closed, forgotten — or someone else's — terminal resolves `{ closed: false }`, without touching
 * it. A session terminal is refused by the runner (CONFLICT): stop the session instead. Login
 * terminals drop their scrollback on close.
 */
export async function closeTerminal(ctx: TerminalCtx, id: string): Promise<{ closed: boolean }> {
  const terminalId = parseId(id);
  let runner: RunnerClient;
  try {
    ({ runner } = await scopeOfTerminal(ctx, terminalId));
  } catch (error) {
    if (isNotFound(error)) return { closed: false };
    throw error;
  }
  try {
    await runner.closeTerminal({ params: { terminalId } });
    return { closed: true };
  } catch (error) {
    if (error instanceof RunnerError && error.code === 'NOT_FOUND') return { closed: false };
    throw error;
  } finally {
    invalidateTerminalScope(terminalId);
  }
}

/** Keystrokes into a terminal of this account (cheap scope check reused for 60 s). */
export async function sendTerminalInput(ctx: TerminalCtx, id: string, body: TerminalInputRequest): Promise<void> {
  const terminalId = parseId(id);
  const scope = await scopeOfTerminalInput(ctx, terminalId);
  try {
    await scope.runner.terminalInput({ params: { terminalId }, body });
  } catch (error) {
    throw forgetClosed(terminalId, error);
  }
}

/** New size of a terminal of this account (same check as the keystrokes). */
export async function resizeTerminal(ctx: TerminalCtx, id: string, body: TerminalResizeRequest): Promise<void> {
  const terminalId = parseId(id);
  const scope = await scopeOfTerminalInput(ctx, terminalId);
  try {
    await scope.runner.terminalResize({ params: { terminalId }, body });
  } catch (error) {
    throw forgetClosed(terminalId, error);
  }
}

/** A terminal the runner no longer knows loses its cached verdict (same 404 copy as the scope). */
function forgetClosed(terminalId: string, error: unknown): unknown {
  if (!isNotFound(error)) return error;
  invalidateTerminalScope(terminalId);
  return new AppError('NOT_FOUND', NOT_FOUND_MESSAGES.terminal);
}

export interface ShellWorktree {
  id: string;
  name: string;
  branch: string;
  projectId: string;
  projectName: string;
}

/**
 * Worktrees of the space where a shell can be opened (active, project not archived, on the space's
 * server), most recently used first. Empty without a server.
 */
export async function listShellWorktrees(ctx: Pick<RequestContext, 'space' | 'environment'>, limit = 20): Promise<ShellWorktree[]> {
  if (!ctx.environment) return [];
  const rows = await db
    .select({
      id: worktrees.id,
      name: worktrees.name,
      branch: worktrees.branch,
      projectId: projects.id,
      projectName: projects.name,
    })
    .from(worktrees)
    .innerJoin(projects, and(eq(projects.id, worktrees.projectId), eq(projects.environmentId, worktrees.environmentId)))
    .where(
      ofSpace(
        ctx,
        eq(worktrees.environmentId, ctx.environment.id),
        eq(worktrees.status, 'active'),
        isNull(worktrees.removedAt),
        isNull(projects.archivedAt),
        ne(projects.status, 'archived'),
      ),
    )
    .orderBy(sql`${worktrees.lastUsedAt} desc nulls last`, desc(worktrees.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));
  return rows;
}
