import 'server-only';
import { environmentSpaces, sessionClaudeConfig, spaceClaudeOverrides, spaces, user, type InstanceRole } from '@nuera/db/schema';
import { CommonConfigPayloadSchema, type CommonConfigPayload, type CommonConfigRequest } from '@nuera/shared/runner';
import { and, eq } from 'drizzle-orm';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import type { CallerEnvironment } from '@/server/security/runner-token';
import type { RequestContext } from '@/server/tenancy/context';
import { auditIn } from '@/server/tenancy/scope';
import { instanceMcpSessionParts, type InstanceMcpSessionParts } from './instance-mcp';
import {
  commonConfigHash,
  computeEffective,
  overrideSchema,
  policyEnv,
  policyPermissionRules,
  renderRules,
  summaryLine,
  type EffectiveClaudeConfig,
  type InstanceConfigRows,
  type McpPermissionRules,
} from './model';
import { loadInstanceRows, parseInput, readSkillFiles } from './store';
import { scheduleCommonConfigSync, serverSyncStatus } from './sync';

/**
 * What applies where (lot K1). The account of a space is its owner (v1: personal spaces, one server
 * per space): its ROLE decides the audience (« Administrateurs seulement »), the choices of the space
 * (`space_claude_overrides`) turn « Par défaut » items off. The same computation feeds the runner of
 * the server (rules, skills), the launch options of each session (permissions, variables, MCP, model)
 * and what the account sees (Paramètres › Claude Code, the Workspace).
 */

export interface SpaceAccount {
  userId: string | null;
  /** Role of the account (`member` when the space has no owner yet: the narrowest audience). */
  role: InstanceRole;
}

export async function accountOfSpace(spaceId: string): Promise<SpaceAccount> {
  const [row] = await db
    .select({ userId: spaces.ownerUserId, role: user.role, deletedAt: user.deletedAt, disabledAt: user.disabledAt })
    .from(spaces)
    .leftJoin(user, eq(user.id, spaces.ownerUserId))
    .where(eq(spaces.id, spaceId))
    .limit(1);
  if (!row) throw new AppError('NOT_FOUND', 'Espace introuvable.');
  // A deleted or disabled account never counts as an administrator.
  const role: InstanceRole = row.userId && row.role && !row.deletedAt && !row.disabledAt ? row.role : 'member';
  return { userId: row.userId, role };
}

export async function loadOverrides(spaceId: string): Promise<Set<string>> {
  const rows = await db
    .select({ key: spaceClaudeOverrides.itemKey })
    .from(spaceClaudeOverrides)
    .where(and(eq(spaceClaudeOverrides.spaceId, spaceId), eq(spaceClaudeOverrides.disabled, true)));
  return new Set(rows.map((row) => row.key));
}

export interface SpaceEffective {
  rows: InstanceConfigRows;
  account: SpaceAccount;
  effective: EffectiveClaudeConfig;
  defaultMarkdown: string | null;
  lockedMarkdown: string | null;
  /** What the runner of the space's server must hold (rules + skills). */
  hash: string;
}

export async function effectiveForSpace(spaceId: string): Promise<SpaceEffective> {
  const [rows, account, overrides] = await Promise.all([loadInstanceRows(), accountOfSpace(spaceId), loadOverrides(spaceId)]);
  const effective = computeEffective(rows, account.role, overrides);
  const defaultMarkdown = renderRules(effective.rules, 'default');
  const lockedMarkdown = renderRules(effective.rules, 'locked');
  const hash = commonConfigHash({
    defaultMarkdown,
    lockedMarkdown,
    skills: effective.skills.filter((skill) => skill.applied).map((skill) => ({ name: skill.name, hash: skill.hash, version: skill.version })),
  });
  return { rows, account, effective, defaultMarkdown, lockedMarkdown, hash };
}

// ---------------------------------------------------------------------------------------------
// Runner of a server: rules and skills to write
// ---------------------------------------------------------------------------------------------

/** An empty configuration (server not assigned: nobody's sessions run there). */
function emptyPayload(revision: number): CommonConfigPayload {
  const hash = commonConfigHash({ defaultMarkdown: null, lockedMarkdown: null, skills: [] });
  return { hash, revision, generatedAt: new Date().toISOString(), rules: { defaultMarkdown: null, lockedMarkdown: null, items: [] }, skills: [] };
}

/**
 * `POST /api/internal/claude-config` for the calling server: the configuration of one of its accounts
 * (`request.spaceId`, lot P1; omitted: its first account). An account that does not work on the
 * caller's server answers like an unknown one (NOT_FOUND). Files of the skills the runner already
 * holds with the same hash are omitted.
 */
export async function runnerPayload(environment: Pick<CallerEnvironment, 'spaceId'> & { id?: string }, request: CommonConfigRequest): Promise<CommonConfigPayload> {
  let spaceId = environment.spaceId;
  if (request.spaceId && request.spaceId !== environment.spaceId) {
    if (!environment.id) throw new AppError('NOT_FOUND', 'Compte introuvable sur ce serveur.');
    const [link] = await db
      .select({ spaceId: environmentSpaces.spaceId })
      .from(environmentSpaces)
      .where(and(eq(environmentSpaces.environmentId, environment.id), eq(environmentSpaces.spaceId, request.spaceId)))
      .limit(1);
    if (!link) throw new AppError('NOT_FOUND', 'Compte introuvable sur ce serveur.');
    spaceId = link.spaceId;
  }
  if (!spaceId) {
    const rows = await loadInstanceRows();
    return emptyPayload(rows.policy.revision);
  }
  const resolved = await effectiveForSpace(spaceId);
  const applied = resolved.effective.skills.filter((skill) => skill.applied);
  const have = new Map((request.have ?? []).map((entry) => [entry.name, entry.hash]));
  const needed = applied.filter((skill) => have.get(skill.name) !== skill.hash).map((skill) => skill.id);
  const files = await readSkillFiles(needed);
  return CommonConfigPayloadSchema.parse({
    hash: resolved.hash,
    revision: resolved.effective.revision,
    generatedAt: new Date().toISOString(),
    rules: {
      defaultMarkdown: resolved.defaultMarkdown,
      lockedMarkdown: resolved.lockedMarkdown,
      items: resolved.effective.rules.filter((rule) => rule.applied).map((rule) => ({ id: rule.id, title: rule.title, version: rule.version, locked: rule.locked })),
    },
    skills: applied.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description.slice(0, 1024),
      version: skill.version,
      hash: skill.hash,
      locked: skill.locked,
      files: needed.includes(skill.id) ? (files.get(skill.id) ?? []) : null,
    })),
  });
}

// ---------------------------------------------------------------------------------------------
// Launch options of a session
// ---------------------------------------------------------------------------------------------

export interface SessionConfigSnapshot {
  revision: number;
  hash: string;
  summary: string;
  rules: Array<{ id: string; title: string; version: number; locked: boolean }>;
  skills: Array<{ id: string; name: string; version: number; locked: boolean }>;
  mcp: Array<{ id: string; name: string; label: string; admins: boolean; locked: boolean }>;
  permissions: { allow: number; ask: number; deny: number };
  env: string[];
  model: { value: string | null; locked: boolean };
  skipped: Array<{ name: string; reason: string }>;
}

export interface LaunchCommonParts {
  hash: string;
  revision: number;
  rules: McpPermissionRules;
  env: { locked: Record<string, string>; defaults: Record<string, string> };
  mcp: InstanceMcpSessionParts;
  model: { value: string | null; locked: boolean };
  snapshot: SessionConfigSnapshot;
}

/** Everything a session of this space receives from the common configuration. */
export async function launchCommonParts(spaceId: string): Promise<LaunchCommonParts> {
  const resolved = await effectiveForSpace(spaceId);
  const { effective } = resolved;
  const rules = policyPermissionRules(effective);
  const env = policyEnv(effective);
  const mcp = instanceMcpSessionParts(effective, resolved.rows.mcp);
  const appliedMcp = effective.mcp.filter((server) => server.applied && !server.unavailable);
  const snapshot: SessionConfigSnapshot = {
    revision: effective.revision,
    hash: resolved.hash,
    summary: summaryLine({ rules: effective.counts.rules, skills: effective.counts.skills, mcp: appliedMcp.length }),
    rules: effective.rules.filter((rule) => rule.applied).map((rule) => ({ id: rule.id, title: rule.title, version: rule.version, locked: rule.locked })),
    skills: effective.skills.filter((skill) => skill.applied).map((skill) => ({ id: skill.id, name: skill.name, version: skill.version, locked: skill.locked })),
    mcp: appliedMcp.map((server) => ({ id: server.id, name: server.name, label: server.label, admins: server.audience === 'admins', locked: server.locked })),
    permissions: {
      allow: rules.allow.length + mcp.rules.allow.length,
      ask: rules.ask.length + mcp.rules.ask.length,
      deny: rules.deny.length + mcp.rules.deny.length,
    },
    env: [...Object.keys(env.locked), ...Object.keys(env.defaults)].sort(),
    model: effective.model,
    skipped: mcp.skipped,
  };
  return { hash: resolved.hash, revision: effective.revision, rules, env, mcp, model: effective.model, snapshot };
}

/** What a session received at its last start / resume (Workspace « Configuration commune »). */
export async function recordSessionConfig(sessionId: string, spaceId: string, snapshot: SessionConfigSnapshot): Promise<void> {
  try {
    await db
      .insert(sessionClaudeConfig)
      .values({ sessionId, spaceId, snapshot: snapshot as unknown as Record<string, unknown>, appliedAt: new Date() })
      .onConflictDoUpdate({ target: sessionClaudeConfig.sessionId, set: { snapshot: snapshot as unknown as Record<string, unknown>, appliedAt: new Date(), spaceId } });
  } catch (error) {
    // Display only: a failure never fails the launch.
    console.warn('[configuration commune] instantané de session non enregistré', error);
  }
}

export interface SessionConfigView {
  applied: (SessionConfigSnapshot & { appliedAt: string }) | null;
  /** The common configuration changed since the session started (applies at its next resume). */
  changedSince: boolean;
  currentRevision: number;
}

/** Workspace: the session's snapshot (the caller checked the session belongs to the space). */
export async function sessionConfigView(spaceId: string, sessionId: string): Promise<SessionConfigView> {
  const [[row], resolved] = await Promise.all([
    db
      .select({ snapshot: sessionClaudeConfig.snapshot, appliedAt: sessionClaudeConfig.appliedAt })
      .from(sessionClaudeConfig)
      .where(and(eq(sessionClaudeConfig.sessionId, sessionId), eq(sessionClaudeConfig.spaceId, spaceId)))
      .limit(1),
    launchCommonParts(spaceId),
  ]);
  const snapshot = row ? (row.snapshot as unknown as SessionConfigSnapshot) : null;
  return {
    applied: snapshot ? { ...snapshot, appliedAt: row!.appliedAt.toISOString() } : null,
    // (jsonb reorders object keys: compare the counts one by one, never as JSON text.)
    changedSince: snapshot
      ? snapshot.hash !== resolved.hash ||
        snapshot.revision !== resolved.revision ||
        (['allow', 'ask', 'deny'] as const).some((list) => snapshot.permissions?.[list] !== resolved.snapshot.permissions[list])
      : false,
    currentRevision: resolved.revision,
  };
}

// ---------------------------------------------------------------------------------------------
// What the account sees and chooses (Paramètres › Claude Code)
// ---------------------------------------------------------------------------------------------

export interface MyClaudeConfigView {
  effective: EffectiveClaudeConfig;
  summary: string;
  /** The owner of the space may turn « Par défaut » items off. */
  canChoose: boolean;
  /** Copy written on the space's server (null: no server, unreachable runner or older runner). */
  server: { name: string; appliedRevision: number | null; appliedAt: string | null; upToDate: boolean; conflicts: Array<{ name: string; reason: string }>; error: string | null } | null;
  hash: string;
}

export async function getMyClaudeConfig(ctx: Pick<RequestContext, 'space' | 'environment'>): Promise<MyClaudeConfigView> {
  const resolved = await effectiveForSpace(ctx.space.id);
  const status = ctx.environment ? await serverSyncStatus(ctx.environment.id, ctx.space.id) : null;
  return {
    effective: resolved.effective,
    summary: summaryLine({ rules: resolved.effective.counts.rules, skills: resolved.effective.counts.skills, mcp: resolved.effective.counts.mcp }),
    canChoose: ctx.space.role === 'owner',
    server: ctx.environment
      ? {
          name: ctx.environment.name,
          appliedRevision: status?.revision ?? null,
          appliedAt: status?.appliedAt ?? null,
          upToDate: status?.hash === resolved.hash,
          conflicts: status?.conflicts ?? [],
          error: status ? status.error : `${ctx.environment.name} n'a pas donné l'état de sa copie.`,
        }
      : null,
    hash: resolved.hash,
  };
}

/** « Ne pas appliquer à mon espace » on a « Par défaut » item (owner of the space only). */
export async function setSpaceOverride(ctx: Pick<RequestContext, 'user' | 'space' | 'environment'>, input: unknown): Promise<MyClaudeConfigView> {
  if (ctx.space.role !== 'owner') throw new AppError('FORBIDDEN', "Seul le propriétaire de l'espace choisit ce qui s'y applique.");
  const data = parseInput(overrideSchema, input, 'Choix invalide.');
  const resolved = await effectiveForSpace(ctx.space.id);
  const all = [...resolved.effective.rules, ...resolved.effective.skills, ...resolved.effective.mcp, ...resolved.effective.permissions, ...resolved.effective.env];
  const item = all.find((entry) => entry.key === data.key);
  // An item outside the account's audience answers like an unknown one.
  if (!item) throw new AppError('NOT_FOUND', 'Élément de la configuration commune introuvable.');
  if (item.locked) throw new AppError('FORBIDDEN', "Cet élément est imposé par l'administration : il s'applique à toutes les sessions.");
  await db
    .insert(spaceClaudeOverrides)
    .values({ spaceId: ctx.space.id, itemKey: data.key, disabled: data.disabled, updatedByUserId: ctx.user.id, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [spaceClaudeOverrides.spaceId, spaceClaudeOverrides.itemKey],
      set: { disabled: data.disabled, updatedByUserId: ctx.user.id, updatedAt: new Date() },
    });
  await auditIn(ctx, {
    action: 'settings.updated',
    summary: `configuration commune : élément ${data.disabled ? 'désactivé' : 'réactivé'} pour l'espace (${data.key.split(':')[0]})`,
    targetType: 'space',
    targetId: ctx.space.id,
    metadata: { scope: 'claude_config', key: data.key, disabled: data.disabled },
  });
  if (ctx.environment) scheduleCommonConfigSync([ctx.environment.id]);
  return getMyClaudeConfig(ctx);
}
