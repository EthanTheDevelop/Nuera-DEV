import 'server-only';
import { projects, worktrees } from '@nuera/db/schema';
import type { TerminalDto } from '@nuera/shared/runner';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { AppError, formatZodIssues } from '@/server/errors';
import { RunnerError, runner } from '@/server/runner/client';
import { audit } from '@/server/security/audit';
import { assertRateLimit, type RateLimitRule } from '@/server/security/rate-limit';

/**
 * Browser terminals (xterm.js in `@/components/terminal`) opened by the owner on VPS-3, through the
 * runner — the web never spawns anything itself.
 *
 *   const terminal = await openTerminal({ kind: 'shell', worktreeId }, user);
 *   const terminal = await openTerminal({ kind: 'claude-login' }, user);   // `claude auth login`
 *   const terminal = await openTerminal({ kind: 'claude-status' }, user);  // interactive CLI, the owner types /status
 *   const terminal = await getTerminal(id);
 *   await closeTerminal(id);
 *
 * - `mcp-login` stays in `startMcpLogin` (`@/server/mcp`, POST /api/integrations/mcp/[server]/login);
 *   `session` terminals belong to the session manager (GET /v1/sessions/:id/terminal).
 * - Login and /status terminals are private on the runner: output never logged nor persisted,
 *   scrollback dropped on close. Nothing typed or shown in them reaches the database or the audit.
 * - Every opening is audited (`terminal.open`, French summary, kind in metadata) and rate limited
 *   per kind (login terminals the strictest).
 */

/** Terminal ids issued by the runner (random base64url, see `TerminalParamsSchema`). */
export const TERMINAL_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const terminalIdSchema = z.string().regex(TERMINAL_ID_PATTERN, 'identifiant de terminal invalide');

const sizeFields = {
  cols: z.number().int().min(10).max(500).optional(),
  rows: z.number().int().min(4).max(300).optional(),
};

/** Body of POST /api/terminals — the kinds the owner may open from the web. */
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

/** Who opens the terminal (the signed-in owner, `CurrentUser` fits). */
export interface TerminalActor {
  id: string;
}

/** Per owner and kind: login terminals are the strictest (each one starts the CLI login procedure). */
export const TERMINAL_RATE_LIMITS: Readonly<Record<OpenTerminalKind, RateLimitRule>> = {
  shell: { limit: 30, windowMs: 10 * 60_000 },
  'claude-login': { limit: 5, windowMs: 10 * 60_000 },
  'claude-status': { limit: 10, windowMs: 10 * 60_000 },
};

export const TERMINAL_AUDIT_ACTION = 'terminal.open';

interface ShellTarget {
  worktreeId: string;
  worktreeName: string;
  projectId: string;
  projectName: string;
}

/** The worktree must exist in the database, belong to a project and not be removed. */
async function resolveShellTarget(worktreeId: string): Promise<ShellTarget> {
  const [row] = await db
    .select({
      worktreeId: worktrees.id,
      worktreeName: worktrees.name,
      status: worktrees.status,
      removedAt: worktrees.removedAt,
      projectId: projects.id,
      projectName: projects.name,
    })
    .from(worktrees)
    .innerJoin(projects, eq(projects.id, worktrees.projectId))
    .where(eq(worktrees.id, worktreeId))
    .limit(1);
  // `missing` is left to the runner: it checks the disk again (the folder may be back).
  if (!row || row.status === 'removed' || row.removedAt !== null) {
    throw new AppError('NOT_FOUND', 'Worktree introuvable : il a peut-être été supprimé.', { untouched: 'Aucun terminal ouvert.' });
  }
  return { worktreeId: row.worktreeId, worktreeName: row.worktreeName, projectId: row.projectId, projectName: row.projectName };
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
 * Opens a terminal on VPS-3 (runner `POST /v1/terminals`) and audits it. Throws AppError
 * VALIDATION / NOT_FOUND (worktree) / RATE_LIMITED, or the RunnerError of the runner
 * (`RUNNER_UNAVAILABLE`, `CONFLICT` « CLI introuvable » / « Trop de terminaux »…).
 */
export async function openTerminal(input: OpenTerminalInput, actor: TerminalActor): Promise<TerminalDto> {
  const parsed = parseInput(input);
  assertRateLimit(`terminal:${parsed.kind}`, actor.id, TERMINAL_RATE_LIMITS[parsed.kind]);
  const size = sizeOf(parsed);

  switch (parsed.kind) {
    case 'shell': {
      const target = await resolveShellTarget(parsed.worktreeId);
      const terminal = await runner.createTerminal({ body: { kind: 'shell', worktreeId: target.worktreeId, ...size } });
      await audit({
        action: TERMINAL_AUDIT_ACTION,
        summary: `terminal ouvert dans le worktree « ${target.worktreeName} » · ${target.projectName}`,
        targetType: 'worktree',
        targetId: target.worktreeId,
        metadata: { kind: 'shell', terminalId: terminal.id, projectId: target.projectId },
        actorUserId: actor.id,
      });
      return terminal;
    }
    case 'claude-login': {
      const terminal = await runner.createTerminal({ body: { kind: 'claude-login', ...size } });
      await audit({
        action: TERMINAL_AUDIT_ACTION,
        summary: 'terminal de connexion à Claude Code ouvert (claude auth login)',
        targetType: 'terminal',
        targetId: terminal.id,
        metadata: { kind: 'claude-login' },
        actorUserId: actor.id,
      });
      return terminal;
    }
    case 'claude-status': {
      const terminal = await runner.createTerminal({ body: { kind: 'claude-status', ...size } });
      await audit({
        action: TERMINAL_AUDIT_ACTION,
        summary: 'terminal Claude Code ouvert pour /status',
        targetType: 'terminal',
        targetId: terminal.id,
        metadata: { kind: 'claude-status' },
        actorUserId: actor.id,
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

/** Current state of a terminal (any kind, including a session's). NOT_FOUND once closed or forgotten. */
export async function getTerminal(id: string): Promise<TerminalDto> {
  return runner.getTerminal({ params: { terminalId: parseId(id) } });
}

/**
 * Closes a terminal (shell, login, /status, MCP login). Idempotent: an already closed or forgotten
 * terminal resolves `{ closed: false }`. A session terminal is refused by the runner (CONFLICT):
 * stop the session instead. Login terminals drop their scrollback on close.
 */
export async function closeTerminal(id: string): Promise<{ closed: boolean }> {
  try {
    await runner.closeTerminal({ params: { terminalId: parseId(id) } });
    return { closed: true };
  } catch (error) {
    if (error instanceof RunnerError && error.code === 'NOT_FOUND') return { closed: false };
    throw error;
  }
}

export interface ShellWorktree {
  id: string;
  name: string;
  branch: string;
  projectId: string;
  projectName: string;
}

/** Worktrees where a shell can be opened (active, project not archived), most recently used first. */
export async function listShellWorktrees(limit = 20): Promise<ShellWorktree[]> {
  const rows = await db
    .select({
      id: worktrees.id,
      name: worktrees.name,
      branch: worktrees.branch,
      projectId: projects.id,
      projectName: projects.name,
    })
    .from(worktrees)
    .innerJoin(projects, eq(projects.id, worktrees.projectId))
    .where(and(eq(worktrees.status, 'active'), isNull(worktrees.removedAt), isNull(projects.archivedAt), ne(projects.status, 'archived')))
    .orderBy(sql`${worktrees.lastUsedAt} desc nulls last`, desc(worktrees.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));
  return rows;
}
