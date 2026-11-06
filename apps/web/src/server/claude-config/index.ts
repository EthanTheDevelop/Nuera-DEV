import 'server-only';
import { environmentSpaces, environments, instanceConfigProposals, spaces } from '@nuera/db/schema';
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
  /**
   * Servers in service, one row per account they work for (lot P1: a shared server writes one copy
   * per account), with the copy each one holds (read on demand: `servers`).
   */
  servers: Array<{ id: string; name: string; spaceId: string; spaceName: string; primary: boolean; shared: boolean }>;
  isOwner: boolean;
}

export async function loadClaudeAdminOverview(actor: AdminActor): Promise<ClaudeAdminOverview> {
  assertAdmin(actor);
  const [rows, [pending], servers] = await Promise.all([
    loadInstanceRows(),
    db.select({ n: sql<number>`count(*)::int` }).from(instanceConfigProposals).where(eq(instanceConfigProposals.status, 'pending')),
    db
      .select({
        id: environments.id,
        name: environments.name,
        primarySpaceId: environments.spaceId,
        spaceId: environmentSpaces.spaceId,
        spaceName: spaces.name,
      })
      .from(environmentSpaces)
      .innerJoin(environments, eq(environments.id, environmentSpaces.environmentId))
      .innerJoin(spaces, eq(spaces.id, environmentSpaces.spaceId))
      .where(and(eq(environments.status, 'active'), isNotNull(environments.spaceId)))
      .orderBy(environments.name, environmentSpaces.createdAt),
  ]);
  const counts = new Map<string, number>();
  for (const row of servers) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  return {
    rows,
    pendingProposals: pending?.n ?? 0,
    servers: servers.map((row) => ({
      id: row.id,
      name: row.name,
      spaceId: row.spaceId,
      spaceName: row.spaceName,
      primary: row.primarySpaceId === row.spaceId,
      shared: (counts.get(row.id) ?? 0) > 1,
    })),
    isOwner: actor.role === 'owner',
  };
}

export interface ServerCopyView {
  id: string;
  /** `<server id>:<space id>` (a shared server has one copy per account). */
  key: string;
  /** « VPS-3 », or « VPS-3 · Espace d'Hugo » for an account of a shared server. */
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
      // The synchronisation answers for the server's first account: the others are read afterwards.
      const status = result && server.primary ? result.status : await serverSyncStatus(server.id, server.spaceId);
      return {
        id: server.id,
        key: `${server.id}:${server.spaceId}`,
        name: server.shared ? `${server.name} · ${server.spaceName}` : server.name,
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
