import 'server-only';
import {
  instanceClaudePolicy,
  instanceConfigVersions,
  instanceMcpServers,
  instanceRules,
  instanceSkillFiles,
  instanceSkills,
  type ClaudeConfigItemKind,
  type ClaudeConfigVersionAction,
  type ClaudePolicyEnvVar,
  type ClaudePolicyRule,
} from '@nuera/db/schema';
import type { Database } from '@nuera/db';
import { and, asc, desc, eq, lt, sql } from 'drizzle-orm';
import { diffLines } from 'diff';
import { z } from 'zod';
import type { AdminActor } from '@/server/admin/common';
import { assertAdmin } from '@/server/admin/common';
import { db } from '@/server/db';
import { AppError, formatZodIssues } from '@/server/errors';
import { audit } from '@/server/security/audit';
import { assertRateLimit } from '@/server/security/rate-limit';
import {
  newEntryId,
  policyUpdateSchema,
  reorderSchema,
  skillContentHash,
  ruleInputSchema,
  ruleUpdateSchema,
  skillContentUpdateSchema,
  skillEditorSchema,
  skillMetaSchema,
  type InstanceConfigRows,
  type McpItem,
  type PolicyItem,
  type RuleItem,
  type SkillItem,
} from './model';
import { parseFrontmatter, skillFromZip, validateSkillFiles, type ValidatedSkill } from './skill-files';
import { scheduleCommonConfigSync } from './sync';

/**
 * Configuration Claude commune — database side (lot K1). Every write: owner or administrator
 * (`assertConfigWriter`, re-checked here whatever the caller), rate limited, in ONE transaction that
 * bumps the global revision and records a version (snapshot without any secret), then journaled in the
 * instance journal (`instance.claude_*`) and pushed to the runners (`scheduleCommonConfigSync`). The
 * runners never read these tables.
 */

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Database | Tx;

export const NOT_FOUND = { rule: 'Règle introuvable.', skill: 'Skill introuvable.', mcp: 'Serveur MCP introuvable.', version: 'Version introuvable.' } as const;
export const STALE_ITEM = "Cet élément vient d'être modifié par quelqu'un d'autre : rouvrez-le, puis réessayez.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mutations of the common configuration, per administrator (an editor saves often). */
export const CONFIG_MUTATION_LIMIT = { limit: 120, windowMs: 10 * 60_000 } as const;

export function assertConfigWriter(actor: AdminActor): void {
  assertAdmin(actor);
  assertRateLimit('claude-config:mutation', actor.id, CONFIG_MUTATION_LIMIT);
}

export function parseInput<T extends z.ZodType>(schema: T, value: unknown, what = 'Données invalides.'): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError('VALIDATION', what, { detail: formatZodIssues(parsed.error) });
  return parsed.data;
}

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

type RuleRow = typeof instanceRules.$inferSelect;
type SkillRow = typeof instanceSkills.$inferSelect;
type McpRow = typeof instanceMcpServers.$inferSelect;
type PolicyRow = typeof instanceClaudePolicy.$inferSelect;

export function ruleItem(row: RuleRow): RuleItem {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    enabled: row.enabled,
    position: row.position,
    audience: row.audience,
    enforcement: row.enforcement,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function skillItem(row: SkillRow, fileCount: number): SkillItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    audience: row.audience,
    enforcement: row.enforcement,
    allowScripts: row.allowScripts,
    version: row.version,
    contentHash: row.contentHash,
    totalBytes: row.totalBytes,
    fileCount,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function mcpItem(row: McpRow): McpItem {
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    description: row.description,
    kind: row.kind,
    transport: row.transport,
    url: row.url,
    command: row.command,
    args: row.args ?? [],
    authKind: row.authKind,
    hasSecrets: Boolean(row.secretsEncrypted),
    secretKeys: row.secretKeys ?? [],
    config: row.config ?? {},
    audience: row.kind === 'coolify' ? 'admins' : row.audience,
    enforcement: row.enforcement,
    enabled: row.enabled,
    status: row.status,
    lastCheckedAt: iso(row.lastCheckedAt),
    lastError: row.lastError,
    lastTools: row.lastTools ?? [],
    abilities: row.abilities ?? [],
    abilitiesSource: row.abilitiesSource,
    version: row.version,
  };
}

function policyItem(row: PolicyRow): PolicyItem {
  return {
    allow: row.allowRules ?? [],
    ask: row.askRules ?? [],
    deny: row.denyRules ?? [],
    env: row.env ?? [],
    defaultModel: row.defaultModel,
    modelEnforcement: row.modelEnforcement,
    version: row.version,
    revision: row.revision,
    updatedAt: iso(row.updatedAt),
  };
}

/** The single policy row (created by 0007; recreated if someone removed it). */
export async function readPolicyRow(executor: Executor = db): Promise<PolicyRow> {
  const [row] = await executor.select().from(instanceClaudePolicy).where(eq(instanceClaudePolicy.id, 'instance')).limit(1);
  if (row) return row;
  await executor.insert(instanceClaudePolicy).values({ id: 'instance' }).onConflictDoNothing();
  const [created] = await executor.select().from(instanceClaudePolicy).where(eq(instanceClaudePolicy.id, 'instance')).limit(1);
  return created!;
}

/** Every instance item (skill contents excluded): the input of `computeEffective`. */
export async function loadInstanceRows(): Promise<InstanceConfigRows> {
  const [policy, rules, skills, counts, mcp] = await Promise.all([
    readPolicyRow(),
    db.select().from(instanceRules).orderBy(asc(instanceRules.position), asc(instanceRules.createdAt)),
    db.select().from(instanceSkills).orderBy(asc(instanceSkills.name)),
    db
      .select({ skillId: instanceSkillFiles.skillId, n: sql<number>`count(*)::int` })
      .from(instanceSkillFiles)
      .groupBy(instanceSkillFiles.skillId),
    db.select().from(instanceMcpServers).orderBy(asc(instanceMcpServers.name)),
  ]);
  const fileCount = new Map(counts.map((row) => [row.skillId, row.n]));
  return {
    policy: policyItem(policy),
    rules: rules.map(ruleItem),
    skills: skills.map((row) => skillItem(row, fileCount.get(row.id) ?? 0)),
    mcp: mcp.map(mcpItem),
  };
}

export async function readSkillFiles(skillIds: string[]): Promise<Map<string, Array<{ path: string; content: string; executable: boolean }>>> {
  const result = new Map<string, Array<{ path: string; content: string; executable: boolean }>>();
  if (skillIds.length === 0) return result;
  const rows = await db
    .select({ skillId: instanceSkillFiles.skillId, path: instanceSkillFiles.path, content: instanceSkillFiles.content, executable: instanceSkillFiles.executable })
    .from(instanceSkillFiles)
    .where(sql`${instanceSkillFiles.skillId} in ${skillIds}`)
    .orderBy(asc(instanceSkillFiles.path));
  for (const row of rows) {
    const list = result.get(row.skillId) ?? [];
    list.push({ path: row.path, content: row.content, executable: row.executable });
    result.set(row.skillId, list);
  }
  return result;
}

/** A skill with its files (administrators: editor, versions). */
export async function getSkillDetail(actor: AdminActor, id: string) {
  assertAdmin(actor);
  const row = await findSkill(db, id);
  const files = (await readSkillFiles([row.id])).get(row.id) ?? [];
  return { skill: skillItem(row, files.length), files };
}

async function findRule(executor: Executor, id: string, lock = false): Promise<RuleRow> {
  if (!UUID.test(id)) throw new AppError('NOT_FOUND', NOT_FOUND.rule);
  const query = executor.select().from(instanceRules).where(eq(instanceRules.id, id)).limit(1);
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw new AppError('NOT_FOUND', NOT_FOUND.rule);
  return row;
}

async function findSkill(executor: Executor, id: string, lock = false): Promise<SkillRow> {
  if (!UUID.test(id)) throw new AppError('NOT_FOUND', NOT_FOUND.skill);
  const query = executor.select().from(instanceSkills).where(eq(instanceSkills.id, id)).limit(1);
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw new AppError('NOT_FOUND', NOT_FOUND.skill);
  return row;
}

// ---------------------------------------------------------------------------------------------
// Versions and revision
// ---------------------------------------------------------------------------------------------

/** +1 on the global revision (« révision N »), inside the transaction of the change. */
export async function bumpRevision(tx: Tx, actor: AdminActor | null): Promise<number> {
  await readPolicyRow(tx);
  const [row] = await tx
    .update(instanceClaudePolicy)
    .set({ revision: sql`${instanceClaudePolicy.revision} + 1`, ...(actor ? { updatedByUserId: actor.id } : {}) })
    .where(eq(instanceClaudePolicy.id, 'instance'))
    .returning({ revision: instanceClaudePolicy.revision });
  return row!.revision;
}

export async function recordVersion(
  tx: Tx,
  actor: Pick<AdminActor, 'id' | 'email'> | null,
  entry: { kind: ClaudeConfigItemKind; itemId: string; label: string; version: number; action: ClaudeConfigVersionAction; snapshot: Record<string, unknown> },
): Promise<void> {
  await tx.insert(instanceConfigVersions).values({
    itemKind: entry.kind,
    itemId: entry.itemId,
    itemLabel: entry.label.slice(0, 200),
    version: entry.version,
    action: entry.action,
    snapshot: entry.snapshot,
    authorUserId: actor?.id ?? null,
    authorLabel: actor?.email ?? null,
  });
}

const ruleSnapshot = (row: RuleRow) => ({
  title: row.title,
  body: row.body,
  enabled: row.enabled,
  position: row.position,
  audience: row.audience,
  enforcement: row.enforcement,
});

const skillSnapshot = (row: SkillRow, files: Array<{ path: string; content: string; executable: boolean }>) => ({
  name: row.name,
  description: row.description,
  enabled: row.enabled,
  audience: row.audience,
  enforcement: row.enforcement,
  allowScripts: row.allowScripts,
  files,
});

const policySnapshot = (row: PolicyRow) => ({
  allow: row.allowRules,
  ask: row.askRules,
  deny: row.denyRules,
  env: row.env,
  defaultModel: row.defaultModel,
  modelEnforcement: row.modelEnforcement,
});

/** Journal entry of the instance (`instance.claude_*`), after the commit. */
async function journal(actor: AdminActor, action: string, summary: string, target: { type: string; id: string }, metadata: Record<string, unknown>): Promise<void> {
  await audit({ action: `instance.claude_${action}`, summary, actorUserId: actor.id, targetType: target.type, targetId: target.id, metadata });
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

export async function createRule(actor: AdminActor, input: unknown): Promise<RuleItem> {
  assertConfigWriter(actor);
  const data = parseInput(ruleInputSchema, input, 'Règle invalide.');
  const { row, revision } = await db.transaction(async (tx) => {
    const [last] = await tx.select({ position: sql<number>`coalesce(max(${instanceRules.position}), -1)::int` }).from(instanceRules);
    const [created] = await tx
      .insert(instanceRules)
      .values({ ...data, position: (last?.position ?? -1) + 1, createdByUserId: actor.id, updatedByUserId: actor.id })
      .returning();
    await recordVersion(tx, actor, { kind: 'rule', itemId: created!.id, label: created!.title, version: 1, action: 'created', snapshot: ruleSnapshot(created!) });
    return { row: created!, revision: await bumpRevision(tx, actor) };
  });
  await journal(actor, 'rule_created', `règle commune créée : « ${row.title} »`, { type: 'claude_rule', id: row.id }, {
    version: 1,
    revision,
    audience: row.audience,
    enforcement: row.enforcement,
  });
  scheduleCommonConfigSync();
  return ruleItem(row);
}

export async function updateRule(actor: AdminActor, id: string, input: unknown): Promise<RuleItem> {
  assertConfigWriter(actor);
  const data = parseInput(ruleUpdateSchema, input, 'Règle invalide.');
  const { expectedVersion, ...patch } = data;
  const { row, revision, changed } = await db.transaction(async (tx) => {
    const current = await findRule(tx, id, true);
    if (expectedVersion !== undefined && current.version !== expectedVersion) throw new AppError('CONFLICT', STALE_ITEM);
    const keys = (Object.keys(patch) as Array<keyof typeof patch>).filter((key) => patch[key] !== undefined && patch[key] !== current[key]);
    if (keys.length === 0) return { row: current, revision: null, changed: keys };
    const [updated] = await tx
      .update(instanceRules)
      .set({ ...patch, version: current.version + 1, updatedByUserId: actor.id })
      .where(eq(instanceRules.id, current.id))
      .returning();
    await recordVersion(tx, actor, { kind: 'rule', itemId: id, label: updated!.title, version: updated!.version, action: 'updated', snapshot: ruleSnapshot(updated!) });
    return { row: updated!, revision: await bumpRevision(tx, actor), changed: keys };
  });
  if (revision !== null) {
    await journal(actor, 'rule_updated', `règle commune modifiée : « ${row.title} » (version ${row.version})`, { type: 'claude_rule', id: row.id }, {
      version: row.version,
      revision,
      changed,
    });
    scheduleCommonConfigSync();
  }
  return ruleItem(row);
}

export async function deleteRule(actor: AdminActor, id: string): Promise<void> {
  assertConfigWriter(actor);
  const { row, revision } = await db.transaction(async (tx) => {
    const current = await findRule(tx, id, true);
    await tx.delete(instanceRules).where(eq(instanceRules.id, current.id));
    await recordVersion(tx, actor, { kind: 'rule', itemId: id, label: current.title, version: current.version + 1, action: 'deleted', snapshot: ruleSnapshot(current) });
    return { row: current, revision: await bumpRevision(tx, actor) };
  });
  await journal(actor, 'rule_deleted', `règle commune supprimée : « ${row.title} »`, { type: 'claude_rule', id }, { revision });
  scheduleCommonConfigSync();
}

export async function reorderRules(actor: AdminActor, input: unknown): Promise<RuleItem[]> {
  assertConfigWriter(actor);
  const { ids } = parseInput(reorderSchema, input, 'Ordre invalide.');
  const revision = await db.transaction(async (tx) => {
    const rows = await tx.select({ id: instanceRules.id }).from(instanceRules).for('update');
    const known = new Set(rows.map((row) => row.id));
    if (ids.length !== known.size || ids.some((ruleId) => !known.has(ruleId)) || new Set(ids).size !== ids.length) {
      throw new AppError('CONFLICT', 'La liste des règles vient de changer : rechargez la page, puis réessayez.');
    }
    for (const [position, ruleId] of ids.entries()) await tx.update(instanceRules).set({ position }).where(eq(instanceRules.id, ruleId));
    return bumpRevision(tx, actor);
  });
  await journal(actor, 'rules_reordered', 'ordre des règles communes modifié', { type: 'claude_rule', id: 'ordre' }, { revision, count: ids.length });
  scheduleCommonConfigSync();
  return (await db.select().from(instanceRules).orderBy(asc(instanceRules.position))).map(ruleItem);
}

// ---------------------------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------------------------

async function replaceFiles(tx: Tx, skillId: string, files: ValidatedSkill['files']): Promise<void> {
  await tx.delete(instanceSkillFiles).where(eq(instanceSkillFiles.skillId, skillId));
  if (files.length) {
    await tx.insert(instanceSkillFiles).values(
      files.map((file) => ({ skillId, path: file.path, content: file.content, executable: file.executable, sizeBytes: Buffer.byteLength(file.content, 'utf8') })),
    );
  }
}

export interface SkillWriteResult {
  skill: SkillItem;
  /** Scripts the skill carries (shown with the warning). */
  scripts: string[];
  created: boolean;
}

/**
 * Creates a skill, or replaces the files of the skill of that name when `replace` is set (an import of
 * a new version). Without `replace`, an existing name answers 409.
 */
export async function writeSkill(
  actor: AdminActor,
  skill: ValidatedSkill,
  options: { enabled?: boolean; audience?: 'all' | 'admins'; enforcement?: 'locked' | 'default'; allowScripts: boolean; replace?: boolean; source: 'import' | 'editor' | 'proposal' },
): Promise<SkillWriteResult> {
  const outcome = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(instanceSkills).where(eq(instanceSkills.name, skill.name)).limit(1).for('update');
    if (existing && !options.replace) {
      throw new AppError('CONFLICT', `Un skill commun s'appelle déjà « ${skill.name} ».`, {
        detail: 'Cochez « Remplacer la version actuelle » pour en importer une nouvelle version, ou changez le champ name de SKILL.md.',
      });
    }
    if (existing) {
      const [updated] = await tx
        .update(instanceSkills)
        .set({
          description: skill.description,
          allowScripts: options.allowScripts,
          contentHash: skill.hash,
          totalBytes: skill.totalBytes,
          version: existing.version + 1,
          updatedByUserId: actor.id,
          ...(options.audience ? { audience: options.audience } : {}),
          ...(options.enforcement ? { enforcement: options.enforcement } : {}),
          ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
        })
        .where(eq(instanceSkills.id, existing.id))
        .returning();
      await replaceFiles(tx, existing.id, skill.files);
      await recordVersion(tx, actor, { kind: 'skill', itemId: existing.id, label: skill.name, version: updated!.version, action: 'updated', snapshot: skillSnapshot(updated!, skill.files) });
      return { row: updated!, created: false, revision: await bumpRevision(tx, actor) };
    }
    const [created] = await tx
      .insert(instanceSkills)
      .values({
        name: skill.name,
        description: skill.description,
        enabled: options.enabled ?? true,
        audience: options.audience ?? 'all',
        enforcement: options.enforcement ?? 'default',
        allowScripts: options.allowScripts,
        contentHash: skill.hash,
        totalBytes: skill.totalBytes,
        createdByUserId: actor.id,
        updatedByUserId: actor.id,
      })
      .returning();
    await replaceFiles(tx, created!.id, skill.files);
    await recordVersion(tx, actor, { kind: 'skill', itemId: created!.id, label: skill.name, version: 1, action: 'created', snapshot: skillSnapshot(created!, skill.files) });
    return { row: created!, created: true, revision: await bumpRevision(tx, actor) };
  });
  await journal(
    actor,
    outcome.created ? 'skill_created' : 'skill_updated',
    `${outcome.created ? 'skill commun ajouté' : 'skill commun mis à jour'} : « ${skill.name} » (version ${outcome.row.version})${skill.scripts.length ? ` · ${skill.scripts.length} script(s)` : ''}`,
    { type: 'claude_skill', id: outcome.row.id },
    { version: outcome.row.version, revision: outcome.revision, source: options.source, files: skill.files.length, bytes: skill.totalBytes, scripts: skill.scripts },
  );
  scheduleCommonConfigSync();
  return { skill: skillItem(outcome.row, skill.files.length), scripts: skill.scripts, created: outcome.created };
}

export const importOptionsSchema = z.object({
  allowScripts: z.boolean().default(false),
  replace: z.boolean().default(false),
  audience: z.enum(['all', 'admins']).default('all'),
  enforcement: z.enum(['locked', 'default']).default('default'),
});

/** « Importer un skill (.zip) ». */
export async function importSkillZip(actor: AdminActor, buffer: Buffer, input: unknown): Promise<SkillWriteResult> {
  assertConfigWriter(actor);
  const options = parseInput(importOptionsSchema, input, 'Options invalides.');
  const skill = skillFromZip(buffer, { allowScripts: options.allowScripts });
  return writeSkill(actor, skill, {
    allowScripts: options.allowScripts,
    replace: options.replace,
    // A replacement keeps the audience and enforcement already chosen.
    ...(options.replace ? {} : { audience: options.audience, enforcement: options.enforcement }),
    source: 'import',
  });
}

/** « Nouveau skill » from the editor (SKILL.md + optional text files). */
export async function createSkillFromEditor(actor: AdminActor, input: unknown): Promise<SkillWriteResult> {
  assertConfigWriter(actor);
  const data = parseInput(skillEditorSchema, input, 'Skill invalide.');
  const skill = validateSkillFiles([{ path: 'SKILL.md', content: data.skillMd }, ...data.files], { allowScripts: data.allowScripts, expectedName: data.name });
  return writeSkill(actor, skill, { enabled: data.enabled, audience: data.audience, enforcement: data.enforcement, allowScripts: data.allowScripts, source: 'editor' });
}

/** New SKILL.md (and optionally files) of an existing skill. */
export async function updateSkillContent(actor: AdminActor, id: string, input: unknown): Promise<SkillWriteResult> {
  assertConfigWriter(actor);
  const data = parseInput(skillContentUpdateSchema, input, 'Skill invalide.');
  const current = await findSkill(db, id);
  if (data.expectedVersion !== undefined && current.version !== data.expectedVersion) throw new AppError('CONFLICT', STALE_ITEM);
  const others =
    data.files ??
    ((await readSkillFiles([current.id])).get(current.id) ?? []).filter((file) => file.path !== 'SKILL.md').map(({ path, content }) => ({ path, content }));
  const allowScripts = data.allowScripts ?? current.allowScripts;
  const skill = validateSkillFiles([{ path: 'SKILL.md', content: data.skillMd }, ...others], { allowScripts, expectedName: current.name });
  return writeSkill(actor, skill, { allowScripts, replace: true, source: 'editor' });
}

/** Description, activation, audience, « Imposé », scripts allowed (without touching the files). */
export async function updateSkillMeta(actor: AdminActor, id: string, input: unknown): Promise<SkillItem> {
  assertConfigWriter(actor);
  const data = parseInput(skillMetaSchema, input, 'Skill invalide.');
  const { expectedVersion, ...patch } = data;
  const result = await db.transaction(async (tx) => {
    const current = await findSkill(tx, id, true);
    if (expectedVersion !== undefined && current.version !== expectedVersion) throw new AppError('CONFLICT', STALE_ITEM);
    const files = (await tx.select().from(instanceSkillFiles).where(eq(instanceSkillFiles.skillId, current.id)).orderBy(asc(instanceSkillFiles.path))).map(
      (file) => ({ path: file.path, content: file.content, executable: file.executable }),
    );
    if (patch.allowScripts === false && current.allowScripts) {
      // Turning scripts off is refused while the skill carries some (they would be left half-allowed).
      const validated = (() => {
        try {
          return validateSkillFiles(files, { allowScripts: false, expectedName: current.name });
        } catch (error) {
          return error as AppError;
        }
      })();
      if (validated instanceof AppError) throw new AppError('CONFLICT', 'Ce skill contient des scripts : retirez-les (nouvelle version) avant de les interdire.');
    }
    const changed = (Object.keys(patch) as Array<keyof typeof patch>).filter((key) => patch[key] !== undefined && patch[key] !== current[key]);
    if (changed.length === 0) return { row: current, files, revision: null, changed };
    let description = patch.description ?? current.description;
    let contentHash = current.contentHash;
    if (patch.description !== undefined && patch.description !== current.description) {
      // The description lives in SKILL.md: rewritten there too, so that the CLI shows the same text.
      const skillMd = files.find((file) => file.path === 'SKILL.md');
      if (skillMd) {
        skillMd.content = rewriteDescription(skillMd.content, patch.description);
        description = parseFrontmatter(skillMd.content).description ?? patch.description;
        await tx.update(instanceSkillFiles).set({ content: skillMd.content, sizeBytes: Buffer.byteLength(skillMd.content, 'utf8') }).where(and(eq(instanceSkillFiles.skillId, current.id), eq(instanceSkillFiles.path, 'SKILL.md')));
        contentHash = skillContentHash(files);
      }
    }
    const [updated] = await tx
      .update(instanceSkills)
      .set({ ...patch, description, contentHash, version: current.version + 1, updatedByUserId: actor.id })
      .where(eq(instanceSkills.id, current.id))
      .returning();
    await recordVersion(tx, actor, { kind: 'skill', itemId: current.id, label: updated!.name, version: updated!.version, action: 'updated', snapshot: skillSnapshot(updated!, files) });
    return { row: updated!, files, revision: await bumpRevision(tx, actor), changed };
  });
  if (result.revision !== null) {
    await journal(actor, 'skill_updated', `skill commun modifié : « ${result.row.name} » (version ${result.row.version})`, { type: 'claude_skill', id: result.row.id }, {
      version: result.row.version,
      revision: result.revision,
      changed: result.changed,
    });
    scheduleCommonConfigSync();
  }
  return skillItem(result.row, result.files.length);
}

/** `description: …` of a SKILL.md front matter replaced (one line). */
export function rewriteDescription(skillMd: string, description: string): string {
  const clean = description.replace(/[\r\n]+/g, ' ').trim();
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
  if (!match) return skillMd;
  const lines = match[1]!.split(/\r?\n/);
  const out: string[] = [];
  let replaced = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^description:/i.test(line)) {
      out.push(`description: ${JSON.stringify(clean)}`);
      replaced = true;
      // Skip a folded block that followed.
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) i += 1;
      continue;
    }
    out.push(line);
  }
  if (!replaced) out.push(`description: ${JSON.stringify(clean)}`);
  return skillMd.replace(match[0], `---\n${out.join('\n')}\n---`);
}

export async function deleteSkill(actor: AdminActor, id: string): Promise<void> {
  assertConfigWriter(actor);
  const result = await db.transaction(async (tx) => {
    const current = await findSkill(tx, id, true);
    const files = (await tx.select().from(instanceSkillFiles).where(eq(instanceSkillFiles.skillId, current.id))).map((file) => ({
      path: file.path,
      content: file.content,
      executable: file.executable,
    }));
    await tx.delete(instanceSkills).where(eq(instanceSkills.id, current.id));
    await recordVersion(tx, actor, { kind: 'skill', itemId: id, label: current.name, version: current.version + 1, action: 'deleted', snapshot: skillSnapshot(current, files) });
    return { row: current, revision: await bumpRevision(tx, actor) };
  });
  await journal(actor, 'skill_deleted', `skill commun supprimé : « ${result.row.name} »`, { type: 'claude_skill', id }, { revision: result.revision });
  scheduleCommonConfigSync();
}

// ---------------------------------------------------------------------------------------------
// Policy (permissions, environment, model)
// ---------------------------------------------------------------------------------------------

export async function updatePolicy(actor: AdminActor, input: unknown): Promise<PolicyItem> {
  assertConfigWriter(actor);
  const data = parseInput(policyUpdateSchema, input, 'Réglages communs invalides.');
  const withIds = <T extends { id?: string | undefined }>(entries: T[] | undefined) => entries?.map((entry) => ({ ...entry, id: entry.id ?? newEntryId() }));
  const result = await db.transaction(async (tx) => {
    const current = await readPolicyRow(tx);
    await tx.select({ id: instanceClaudePolicy.id }).from(instanceClaudePolicy).where(eq(instanceClaudePolicy.id, 'instance')).for('update');
    if (data.expectedVersion !== undefined && current.version !== data.expectedVersion) throw new AppError('CONFLICT', STALE_ITEM);
    const patch = {
      ...(data.allow ? { allowRules: withIds(data.allow) as ClaudePolicyRule[] } : {}),
      ...(data.ask ? { askRules: withIds(data.ask) as ClaudePolicyRule[] } : {}),
      ...(data.deny ? { denyRules: withIds(data.deny) as ClaudePolicyRule[] } : {}),
      ...(data.env ? { env: withIds(data.env) as ClaudePolicyEnvVar[] } : {}),
      ...(data.defaultModel !== undefined ? { defaultModel: data.defaultModel } : {}),
      ...(data.modelEnforcement ? { modelEnforcement: data.modelEnforcement } : {}),
    };
    const [updated] = await tx
      .update(instanceClaudePolicy)
      .set({ ...patch, version: current.version + 1, revision: current.revision + 1, updatedByUserId: actor.id, updatedAt: new Date() })
      .where(eq(instanceClaudePolicy.id, 'instance'))
      .returning();
    await recordVersion(tx, actor, { kind: 'policy', itemId: 'instance', label: 'Permissions et réglages', version: updated!.version, action: 'updated', snapshot: policySnapshot(updated!) });
    return updated!;
  });
  await journal(actor, 'policy_updated', `permissions et réglages communs modifiés (version ${result.version})`, { type: 'claude_policy', id: 'instance' }, {
    version: result.version,
    revision: result.revision,
    allow: result.allowRules.length,
    ask: result.askRules.length,
    deny: result.denyRules.length,
    env: result.env.map((entry) => entry.name),
    model: result.defaultModel,
    modelEnforcement: result.modelEnforcement,
  });
  scheduleCommonConfigSync();
  return policyItem(result);
}

// ---------------------------------------------------------------------------------------------
// Versions: list, diff, rollback; history
// ---------------------------------------------------------------------------------------------

export interface VersionView {
  id: number;
  kind: ClaudeConfigItemKind;
  itemId: string;
  label: string;
  version: number;
  action: ClaudeConfigVersionAction;
  author: string | null;
  createdAt: string;
}

const versionView = (row: typeof instanceConfigVersions.$inferSelect): VersionView => ({
  id: row.id,
  kind: row.itemKind,
  itemId: row.itemId,
  label: row.itemLabel,
  version: row.version,
  action: row.action,
  author: row.authorLabel,
  createdAt: row.createdAt.toISOString(),
});

export const historyQuerySchema = z.object({
  kind: z.enum(['rule', 'skill', 'mcp', 'policy']).optional(),
  itemId: z.string().max(64).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function listHistory(actor: AdminActor, input: unknown): Promise<{ items: VersionView[]; nextBefore: number | null }> {
  assertAdmin(actor);
  const query = parseInput(historyQuerySchema, input ?? {}, 'Paramètres invalides.');
  const conditions = [
    ...(query.kind ? [eq(instanceConfigVersions.itemKind, query.kind)] : []),
    ...(query.itemId ? [eq(instanceConfigVersions.itemId, query.itemId)] : []),
    ...(query.before ? [lt(instanceConfigVersions.id, query.before)] : []),
  ];
  const rows = await db
    .select()
    .from(instanceConfigVersions)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(instanceConfigVersions.id))
    .limit(query.limit + 1);
  const items = rows.slice(0, query.limit).map(versionView);
  return { items, nextBefore: rows.length > query.limit ? items.at(-1)!.id : null };
}

/** Text of a snapshot for the diff (a rule: its Markdown; a skill: its files; the policy: its lines). */
export function snapshotText(kind: ClaudeConfigItemKind, snapshot: Record<string, unknown>): string {
  const lines: string[] = [];
  const meta = (key: string, label: string) => {
    if (snapshot[key] !== undefined) lines.push(`${label} : ${String(snapshot[key])}`);
  };
  switch (kind) {
    case 'rule':
      meta('title', 'Titre');
      meta('enforcement', 'Application');
      meta('audience', 'Pour');
      meta('enabled', 'Active');
      lines.push('', String(snapshot.body ?? ''));
      break;
    case 'skill': {
      meta('name', 'Nom');
      meta('description', 'Description');
      meta('enforcement', 'Application');
      meta('audience', 'Pour');
      meta('enabled', 'Actif');
      meta('allowScripts', 'Scripts autorisés');
      for (const file of (snapshot.files as Array<{ path: string; content: string; executable: boolean }> | undefined) ?? []) {
        lines.push('', `=== ${file.path}${file.executable ? ' (exécutable)' : ''} ===`, file.content);
      }
      break;
    }
    case 'policy': {
      for (const list of ['allow', 'ask', 'deny'] as const) {
        for (const entry of (snapshot[list] as ClaudePolicyRule[] | undefined) ?? []) lines.push(`${list} · ${entry.rule} · ${entry.enforcement}`);
      }
      for (const entry of (snapshot.env as ClaudePolicyEnvVar[] | undefined) ?? []) lines.push(`env · ${entry.name}=${entry.value} · ${entry.enforcement}`);
      meta('defaultModel', 'Modèle');
      meta('modelEnforcement', 'Modèle appliqué');
      break;
    }
    case 'mcp':
      for (const key of ['name', 'label', 'description', 'kind', 'transport', 'url', 'command', 'audience', 'enforcement', 'enabled', 'authKind']) meta(key, key);
      if (snapshot.args) lines.push(`args : ${JSON.stringify(snapshot.args)}`);
      if (snapshot.config) lines.push(`config : ${JSON.stringify(snapshot.config)}`);
      if (snapshot.secretKeys) lines.push(`en-têtes secrets : ${(snapshot.secretKeys as string[]).join(', ') || 'aucun'}`);
      break;
  }
  return lines.join('\n');
}

export interface VersionDetail {
  version: VersionView;
  previous: VersionView | null;
  text: string;
  /** Lines added / removed since the previous version (`diff` package). */
  diff: Array<{ value: string; added: boolean; removed: boolean }>;
}

async function findVersion(id: number): Promise<typeof instanceConfigVersions.$inferSelect> {
  const [row] = await db.select().from(instanceConfigVersions).where(eq(instanceConfigVersions.id, id)).limit(1);
  if (!row) throw new AppError('NOT_FOUND', NOT_FOUND.version);
  return row;
}

export async function getVersionDetail(actor: AdminActor, rawId: string): Promise<VersionDetail> {
  assertAdmin(actor);
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError('NOT_FOUND', NOT_FOUND.version);
  const row = await findVersion(id);
  const [previous] = await db
    .select()
    .from(instanceConfigVersions)
    .where(and(eq(instanceConfigVersions.itemKind, row.itemKind), eq(instanceConfigVersions.itemId, row.itemId), lt(instanceConfigVersions.id, row.id)))
    .orderBy(desc(instanceConfigVersions.id))
    .limit(1);
  const text = snapshotText(row.itemKind, row.snapshot);
  const before = previous ? snapshotText(previous.itemKind, previous.snapshot) : '';
  const diff = diffLines(row.action === 'deleted' ? text : before, row.action === 'deleted' ? '' : text).map((part) => ({
    value: part.value,
    added: Boolean(part.added),
    removed: Boolean(part.removed),
  }));
  return { version: versionView(row), previous: previous ? versionView(previous) : null, text, diff };
}

/**
 * « Revenir à cette version »: the snapshot becomes a NEW version (history is never rewritten). A
 * deleted rule or skill is recreated with its id. MCP servers keep their current secrets (snapshots
 * never hold any).
 */
export async function rollbackVersion(actor: AdminActor, rawId: string): Promise<{ kind: ClaudeConfigItemKind; itemId: string; version: number }> {
  assertConfigWriter(actor);
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError('NOT_FOUND', NOT_FOUND.version);
  const target = await findVersion(id);
  const snapshot = target.snapshot;
  const result = await db.transaction(async (tx) => {
    switch (target.itemKind) {
      case 'rule': {
        const data = parseInput(ruleInputSchema.extend({ position: z.number().int().nonnegative().default(0) }), snapshot, 'Version illisible.');
        const [current] = await tx.select().from(instanceRules).where(eq(instanceRules.id, target.itemId)).limit(1).for('update');
        const [lastVersion] = await tx
          .select({ v: sql<number>`coalesce(max(${instanceConfigVersions.version}), 0)::int` })
          .from(instanceConfigVersions)
          .where(and(eq(instanceConfigVersions.itemKind, 'rule'), eq(instanceConfigVersions.itemId, target.itemId)));
        const version = Math.max(current?.version ?? 0, lastVersion?.v ?? 0) + 1;
        const [row] = current
          ? await tx.update(instanceRules).set({ ...data, version, updatedByUserId: actor.id }).where(eq(instanceRules.id, current.id)).returning()
          : await tx.insert(instanceRules).values({ id: target.itemId, ...data, version, createdByUserId: actor.id, updatedByUserId: actor.id }).returning();
        await recordVersion(tx, actor, { kind: 'rule', itemId: row!.id, label: row!.title, version, action: 'rolled_back', snapshot: { ...ruleSnapshot(row!), fromVersion: target.version } });
        return { kind: 'rule' as const, itemId: row!.id, version, label: row!.title, revision: await bumpRevision(tx, actor) };
      }
      case 'skill': {
        const files = z.array(z.object({ path: z.string(), content: z.string(), executable: z.boolean() })).parse(snapshot.files ?? []);
        const allowScripts = snapshot.allowScripts === true;
        const validated = validateSkillFiles(
          files.map(({ path, content }) => ({ path, content })),
          { allowScripts, expectedName: String(snapshot.name ?? '') },
        );
        const meta = z
          .object({ enabled: z.boolean().default(true), audience: z.enum(['all', 'admins']).default('all'), enforcement: z.enum(['locked', 'default']).default('default') })
          .parse(snapshot);
        const [current] = await tx.select().from(instanceSkills).where(eq(instanceSkills.id, target.itemId)).limit(1).for('update');
        const [sameName] = await tx.select({ id: instanceSkills.id }).from(instanceSkills).where(eq(instanceSkills.name, validated.name)).limit(1);
        if (sameName && sameName.id !== target.itemId) throw new AppError('CONFLICT', `Un autre skill commun s'appelle déjà « ${validated.name} ».`);
        const [lastVersion] = await tx
          .select({ v: sql<number>`coalesce(max(${instanceConfigVersions.version}), 0)::int` })
          .from(instanceConfigVersions)
          .where(and(eq(instanceConfigVersions.itemKind, 'skill'), eq(instanceConfigVersions.itemId, target.itemId)));
        const version = Math.max(current?.version ?? 0, lastVersion?.v ?? 0) + 1;
        const values = {
          name: validated.name,
          description: validated.description,
          ...meta,
          allowScripts,
          contentHash: validated.hash,
          totalBytes: validated.totalBytes,
          version,
          updatedByUserId: actor.id,
        };
        const [row] = current
          ? await tx.update(instanceSkills).set(values).where(eq(instanceSkills.id, current.id)).returning()
          : await tx.insert(instanceSkills).values({ id: target.itemId, ...values, createdByUserId: actor.id }).returning();
        await replaceFiles(tx, row!.id, validated.files);
        await recordVersion(tx, actor, { kind: 'skill', itemId: row!.id, label: row!.name, version, action: 'rolled_back', snapshot: { ...skillSnapshot(row!, validated.files), fromVersion: target.version } });
        return { kind: 'skill' as const, itemId: row!.id, version, label: row!.name, revision: await bumpRevision(tx, actor) };
      }
      case 'policy': {
        const current = await readPolicyRow(tx);
        const data = parseInput(policyUpdateSchema, snapshot, 'Version illisible.');
        const [row] = await tx
          .update(instanceClaudePolicy)
          .set({
            allowRules: (data.allow ?? []) as ClaudePolicyRule[],
            askRules: (data.ask ?? []) as ClaudePolicyRule[],
            denyRules: (data.deny ?? []) as ClaudePolicyRule[],
            env: (data.env ?? []) as ClaudePolicyEnvVar[],
            defaultModel: data.defaultModel ?? null,
            modelEnforcement: data.modelEnforcement ?? 'default',
            version: current.version + 1,
            revision: current.revision + 1,
            updatedByUserId: actor.id,
            updatedAt: new Date(),
          })
          .where(eq(instanceClaudePolicy.id, 'instance'))
          .returning();
        await recordVersion(tx, actor, { kind: 'policy', itemId: 'instance', label: 'Permissions et réglages', version: row!.version, action: 'rolled_back', snapshot: { ...policySnapshot(row!), fromVersion: target.version } });
        return { kind: 'policy' as const, itemId: 'instance', version: row!.version, label: 'Permissions et réglages', revision: row!.revision };
      }
      case 'mcp': {
        const { rollbackMcpSnapshot } = await import('./instance-mcp');
        const restored = await rollbackMcpSnapshot(tx, actor, target.itemId, snapshot, target.version);
        return { kind: 'mcp' as const, ...restored, revision: await bumpRevision(tx, actor) };
      }
    }
  });
  await journal(actor, 'version_restored', `configuration commune : « ${result.label} » revient à la version ${target.version} (nouvelle version ${result.version})`, {
    type: `claude_${result.kind}`,
    id: result.itemId,
  }, { fromVersion: target.version, version: result.version, revision: result.revision });
  scheduleCommonConfigSync();
  return { kind: result.kind, itemId: result.itemId, version: result.version };
}
