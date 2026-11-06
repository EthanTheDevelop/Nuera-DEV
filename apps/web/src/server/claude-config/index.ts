import 'server-only';
import { environments, instanceConfigProposals } from '@nuera/db/schema';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { assertAdmin, type AdminActor } from '@/server/admin/common';
import { db } from '@/server/db';
import { effectiveForSpace } from './effective';
import type { InstanceConfigRows } from './model';
import { loadInstanceRows } from './store';
import { serverSyncStatus, syncServers, type ServerSyncResult } from './sync';

/**
 * Configuration Claude commune (lot K1, docs/MULTICOMPTE.md §15) — instance rules, skills, MCP servers
 * and permission policy shared by every account, server and session.
 *
 *   loadClaudeAdminOverview(actor)            → everything the « Claude » tab of the administration shows
 *   launchCommonParts(spaceId)                → what a session of this space receives (launch options)
 *   runnerPayload(environment, { have })      → rules + skills the runner of a server writes
 *   getMyClaudeConfig(ctx) / setSpaceOverride → Paramètres › Claude Code
 */

export * from './model';
export {
  createRule,
  updateRule,
  deleteRule,
  reorderRules,
  importSkillZip,
  createSkillFromEditor,
  updateSkillContent,
  updateSkillMeta,
  deleteSkill,
  getSkillDetail,
  updatePolicy,
  listHistory,
  getVersionDetail,
  rollbackVersion,
  historyQuerySchema,
  importOptionsSchema,
  type VersionView,
  type VersionDetail,
  type SkillWriteResult,
} from './store';
export { createInstanceMcp, updateInstanceMcp, deleteInstanceMcp, testInstanceMcp, createInstanceMcpSchema, updateInstanceMcpSchema, type McpTestResult } from './instance-mcp';
export {
  effectiveForSpace,
  getMyClaudeConfig,
  launchCommonParts,
  recordSessionConfig,
  runnerPayload,
  sessionConfigView,
  setSpaceOverride,
  type LaunchCommonParts,
  type MyClaudeConfigView,
  type SessionConfigSnapshot,
  type SessionConfigView,
} from './effective';
export { createProposal, decideProposal, listMyProposals, listProposals, withdrawProposal, type ProposalView } from './proposals';
export { syncServers, scheduleCommonConfigSync, type ServerSyncResult } from './sync';
export { SKILL_ZIP_MAX_BYTES } from './skill-files';

export interface ClaudeAdminOverview {
  rows: InstanceConfigRows;
  pendingProposals: number;
  /** Servers in service, with the copy each one holds (read on demand: `servers`). */
  servers: Array<{ id: string; name: string; spaceId: string }>;
  isOwner: boolean;
}

export async function loadClaudeAdminOverview(actor: AdminActor): Promise<ClaudeAdminOverview> {
  assertAdmin(actor);
  const [rows, [pending], servers] = await Promise.all([
    loadInstanceRows(),
    db.select({ n: sql<number>`count(*)::int` }).from(instanceConfigProposals).where(eq(instanceConfigProposals.status, 'pending')),
    db
      .select({ id: environments.id, name: environments.name, spaceId: environments.spaceId })
      .from(environments)
      .where(and(eq(environments.status, 'active'), isNotNull(environments.spaceId))),
  ]);
  return { rows, pendingProposals: pending?.n ?? 0, servers: servers.map((server) => ({ ...server, spaceId: server.spaceId! })), isOwner: actor.role === 'owner' };
}

export interface ServerCopyView {
  id: string;
  name: string;
  /** Configuration expected for the account of that server's space. */
  expectedHash: string;
  appliedRevision: number | null;
  appliedAt: string | null;
  upToDate: boolean;
  conflicts: Array<{ name: string; reason: string }>;
  error: string | null;
}

/**
 * Copy held by each server in service compared with what its account should have. Administrators
 * see servers of every space but never their content: only revision, date, conflicts by skill name.
 */
export async function listServerCopies(actor: AdminActor, options: { sync?: boolean } = {}): Promise<ServerCopyView[]> {
  assertAdmin(actor);
  const overview = await loadClaudeAdminOverview(actor);
  const synced: Map<string, ServerSyncResult> = options.sync ? new Map((await syncServers('manual')).map((result) => [result.environmentId, result])) : new Map();
  return Promise.all(
    overview.servers.map(async (server): Promise<ServerCopyView> => {
      const expected = await effectiveForSpace(server.spaceId);
      const result = synced.get(server.id);
      const status = result ? result.status : await serverSyncStatus(server.id);
      return {
        id: server.id,
        name: server.name,
        expectedHash: expected.hash,
        appliedRevision: status?.revision ?? null,
        appliedAt: status?.appliedAt ?? null,
        upToDate: status?.hash === expected.hash,
        conflicts: status?.conflicts ?? [],
        error: result?.error ?? status?.error ?? (status ? null : `${server.name} n'a pas donné l'état de sa copie.`),
      };
    }),
  );
}
