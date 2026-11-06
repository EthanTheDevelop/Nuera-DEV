import { createHash, randomBytes } from 'node:crypto';
import type {
  ClaudeConfigAudience,
  ClaudeConfigEnforcement,
  ClaudePolicyEnvVar,
  ClaudePolicyRule,
  InstanceMcpConfig,
  InstanceMcpKind,
  InstanceRole,
} from '@nuera/db/schema';
import { isRejectedSessionEnvName } from '@nuera/shared/env';
import { COMMON_SKILL_NAME } from '@nuera/shared/runner';
import { z } from 'zod';
import type { McpPermissionRules } from '@/lib/claude-coolify';

/**
 * Configuration Claude commune — pure model (lot K1, docs/MULTICOMPTE.md §15): validation, the merge
 * that decides what applies to one account, the Markdown given to the CLI and the hashes compared by
 * the runners. No database, no `server-only`: unit tests and type imports of the UI use it directly.
 *
 * Precedence (from the strongest):
 *   1. « Imposé » items of the instance — never turned off by a space: rules appended to the system
 *      prompt (`--append-system-prompt-file`), permission rules and variables in the session's
 *      `--settings`, model forced at launch;
 *   2. the space: its owner turns « Par défaut » items off for the space, chooses its default model;
 *   3. the project: its CLAUDE.md (loaded after the common rules), its `.claude/settings.json` (an
 *      `allow` there never lifts an instance `ask` / `deny`: the CLI applies deny > ask > allow), its
 *      variables (they override the « Par défaut » variables of the instance);
 *   4. « Par défaut » items of the instance.
 */

export type Audience = ClaudeConfigAudience;
export type Enforcement = ClaudeConfigEnforcement;

export const AUDIENCE_LABELS: Record<Audience, string> = { all: 'Tous les comptes', admins: 'Administrateurs seulement' };
export const ENFORCEMENT_LABELS: Record<Enforcement, string> = { locked: 'Imposé', default: 'Par défaut' };

/** Name of the instance Coolify server in Claude Code (`mcp__coolify-admin__<tool>`). */
export const COOLIFY_ADMIN_MCP_NAME = 'coolify-admin';

/** Built-in MCP names of the spaces (figma, github, coolify, playwright): refused for an instance server. */
export const RESERVED_MCP_NAMES = new Set(['figma', 'github', 'coolify', 'playwright', COOLIFY_ADMIN_MCP_NAME]);

export function isInstanceAdminRole(role: InstanceRole | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/** Whether an item of this audience reaches an account of this role. */
export function inAudience(audience: Audience, role: InstanceRole | null | undefined): boolean {
  return audience === 'all' || isInstanceAdminRole(role);
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

export const audienceSchema = z.enum(['all', 'admins']);
export const enforcementSchema = z.enum(['locked', 'default']);

const markdown = (max: number) => z.string().max(max).refine((value) => !value.includes('\0'), 'caractère nul refusé');

export const ruleInputSchema = z.object({
  title: z.string().trim().min(1, 'titre requis').max(120),
  body: markdown(20_000).refine((value) => value.trim().length > 0, 'texte requis'),
  enabled: z.boolean().default(true),
  audience: audienceSchema.default('all'),
  enforcement: enforcementSchema.default('default'),
});
export type RuleInput = z.input<typeof ruleInputSchema>;

/** Every field optional and WITHOUT default (an absent field is left as it is). */
export const ruleUpdateSchema = z.object({
  title: z.string().trim().min(1, 'titre requis').max(120).optional(),
  body: markdown(20_000)
    .refine((value) => value.trim().length > 0, 'texte requis')
    .optional(),
  enabled: z.boolean().optional(),
  audience: audienceSchema.optional(),
  enforcement: enforcementSchema.optional(),
  /** Version the editor started from: a newer one answers 409 (someone else saved in between). */
  expectedVersion: z.number().int().positive().optional(),
});
export type RuleUpdate = z.input<typeof ruleUpdateSchema>;

export const reorderSchema = z.object({ ids: z.array(z.uuid()).min(1).max(500) });

/**
 * A Claude Code permission rule: `Tool`, `Tool(specifier)` or `mcp__server__tool`. Kept strict (one
 * line, bounded) so that the settings file stays what an administrator read.
 */
export const PERMISSION_RULE = /^(?:[A-Z][A-Za-z0-9]*(?:\((?:[^()\r\n]|\([^()\r\n]*\)){1,400}\))?|mcp__[A-Za-z0-9_-]{1,64}(?:__[A-Za-z0-9_.*-]{1,128})?)$/;

export const policyRuleSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{6,40}$/).optional(),
  rule: z.string().trim().regex(PERMISSION_RULE, 'règle invalide : Outil, Outil(motif) ou mcp__serveur__outil'),
  enforcement: enforcementSchema.default('default'),
  note: z.string().trim().max(200).nullish(),
});

/** Names that hold a secret (refused: a secret belongs in the encrypted variables of a project). */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|AUTH)/i;

export const policyEnvSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{6,40}$/).optional(),
  name: z
    .string()
    .trim()
    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'nom de variable invalide')
    .refine((name) => !isRejectedSessionEnvName(name), 'variable réservée : le runner la refuse pour une session')
    .refine((name) => !SECRET_NAME.test(name), 'variable secrète : définissez-la dans les variables chiffrées du projet'),
  value: z.string().max(2000).regex(/^[^\r\n\0]*$/, 'valeur sur une ligne attendue'),
  enforcement: enforcementSchema.default('default'),
});

export const policyUpdateSchema = z
  .object({
    allow: z.array(policyRuleSchema).max(200).optional(),
    ask: z.array(policyRuleSchema).max(200).optional(),
    deny: z.array(policyRuleSchema).max(200).optional(),
    env: z.array(policyEnvSchema).max(100).optional(),
    defaultModel: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._[\]-]{1,80}$/, 'modèle invalide')
      .nullable()
      .optional(),
    modelEnforcement: enforcementSchema.optional(),
    expectedVersion: z.number().int().nonnegative().optional(),
  })
  .refine((value) => {
    const names = (value.env ?? []).map((entry) => entry.name);
    return new Set(names).size === names.length;
  }, 'une variable apparaît deux fois');
export type PolicyUpdate = z.input<typeof policyUpdateSchema>;

export const skillMetaSchema = z.object({
  description: z.string().trim().min(1).max(1024).optional(),
  enabled: z.boolean().optional(),
  audience: audienceSchema.optional(),
  enforcement: enforcementSchema.optional(),
  allowScripts: z.boolean().optional(),
  expectedVersion: z.number().int().positive().optional(),
});

export const skillNameSchema = z.string().trim().regex(COMMON_SKILL_NAME, 'nom en minuscules, chiffres et tirets (64 caractères au plus)');

/** Editor of a skill: its SKILL.md (front matter included) and optional extra text files. */
export const skillEditorSchema = z.object({
  name: skillNameSchema,
  skillMd: markdown(512 * 1024),
  files: z.array(z.object({ path: z.string().min(1).max(200), content: z.string().max(512 * 1024) })).max(99).default([]),
  enabled: z.boolean().default(true),
  audience: audienceSchema.default('all'),
  enforcement: enforcementSchema.default('default'),
  allowScripts: z.boolean().default(false),
});
export type SkillEditorInput = z.input<typeof skillEditorSchema>;

export const skillContentUpdateSchema = z.object({
  skillMd: markdown(512 * 1024),
  /** Extra files; absent: the current ones are kept. */
  files: z.array(z.object({ path: z.string().min(1).max(200), content: z.string().max(512 * 1024) })).max(99).optional(),
  allowScripts: z.boolean().optional(),
  expectedVersion: z.number().int().positive().optional(),
});

export const overrideSchema = z.object({
  key: z.string().regex(/^(rule|skill|mcp|perm|env):[A-Za-z0-9_-]{6,64}$/, 'élément inconnu'),
  disabled: z.boolean(),
});

export const proposalInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('rule'),
    targetId: z.uuid().nullish(),
    title: z.string().trim().min(1).max(120),
    body: markdown(20_000).refine((value) => value.trim().length > 0, 'texte requis'),
    note: z.string().trim().max(1000).nullish(),
  }),
  z.object({
    kind: z.literal('skill'),
    targetId: z.uuid().nullish(),
    name: skillNameSchema,
    skillMd: markdown(512 * 1024),
    note: z.string().trim().max(1000).nullish(),
  }),
]);
export type ProposalInput = z.input<typeof proposalInputSchema>;

export const proposalDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().max(1000).nullish(),
});

// ---------------------------------------------------------------------------------------------
// Rows (what the merge needs)
// ---------------------------------------------------------------------------------------------

export interface RuleItem {
  id: string;
  title: string;
  body: string;
  enabled: boolean;
  position: number;
  audience: Audience;
  enforcement: Enforcement;
  version: number;
  updatedAt: string;
}

export interface SkillItem {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  audience: Audience;
  enforcement: Enforcement;
  allowScripts: boolean;
  version: number;
  contentHash: string;
  totalBytes: number;
  fileCount: number;
  updatedAt: string;
}

export interface McpItem {
  id: string;
  name: string;
  label: string;
  description: string | null;
  kind: InstanceMcpKind;
  transport: 'http' | 'sse' | 'stdio';
  url: string | null;
  command: string | null;
  args: string[];
  authKind: 'none' | 'bearer' | 'header' | 'env' | 'oauth';
  hasSecrets: boolean;
  secretKeys: string[];
  config: InstanceMcpConfig;
  audience: Audience;
  enforcement: Enforcement;
  enabled: boolean;
  status: string;
  lastCheckedAt: string | null;
  lastError: string | null;
  lastTools: string[];
  abilities: string[];
  abilitiesSource: string | null;
  version: number;
}

export interface PolicyItem {
  allow: ClaudePolicyRule[];
  ask: ClaudePolicyRule[];
  deny: ClaudePolicyRule[];
  env: ClaudePolicyEnvVar[];
  defaultModel: string | null;
  modelEnforcement: Enforcement;
  version: number;
  revision: number;
  updatedAt: string | null;
}

export interface InstanceConfigRows {
  rules: RuleItem[];
  skills: SkillItem[];
  mcp: McpItem[];
  policy: PolicyItem;
}

// ---------------------------------------------------------------------------------------------
// Coolify (administrators only)
// ---------------------------------------------------------------------------------------------

export { classifyCoolifyTool, coolifyPermissionRules, type CoolifyToolClass, type McpPermissionRules } from '@/lib/claude-coolify';

/**
 * Why the instance Coolify server must not reach Claude, or null. Adapts `coolifyTokenRefusal` of the
 * space integration: abilities must have been read from the tools the Coolify MCP server listed for
 * the token (a successful test); a token that can write is served only when an administrator chose
 * to offer write tools (always behind a permission request).
 */
export function instanceCoolifyRefusal(item: Pick<McpItem, 'abilities' | 'abilitiesSource' | 'lastTools' | 'config' | 'hasSecrets' | 'url'>): string | null {
  if (!item.url) return "Adresse de Coolify absente.";
  if (!item.hasSecrets) return 'Jeton Coolify absent.';
  if (item.abilitiesSource !== 'mcp_tools' || item.lastTools.length === 0) {
    return 'Droits du jeton Coolify non vérifiés : testez la connexion depuis Administration › Claude › MCP.';
  }
  if (item.abilities.includes('write') && !item.config.allowWrite) {
    return "Ce jeton Coolify peut modifier Coolify (droit write) : cochez « Proposer les outils d'écriture » (chaque appel demandera votre autorisation) ou utilisez un jeton limité à read.";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Effective configuration of one account
// ---------------------------------------------------------------------------------------------

export interface EffectiveState {
  /** Item key in `space_claude_overrides` (`rule:<id>`…). */
  key: string;
  locked: boolean;
  /** Turned off by the space (only possible for « Par défaut » items). */
  disabledBySpace: boolean;
  /** Applied to the next sessions of this account. */
  applied: boolean;
}

export interface EffectiveRule extends EffectiveState {
  id: string;
  title: string;
  body: string;
  version: number;
  audience: Audience;
}
export interface EffectiveSkill extends EffectiveState {
  id: string;
  name: string;
  description: string;
  version: number;
  hash: string;
  audience: Audience;
  allowScripts: boolean;
  fileCount: number;
}
export interface EffectiveMcp extends EffectiveState {
  id: string;
  name: string;
  label: string;
  kind: InstanceMcpKind;
  audience: Audience;
  /** Why it is left out of the sessions even though it applies (Coolify not verified…). */
  unavailable: string | null;
}
export interface EffectivePermission extends EffectiveState {
  id: string;
  rule: string;
  list: 'allow' | 'ask' | 'deny';
  note: string | null;
}
export interface EffectiveEnv extends EffectiveState {
  id: string;
  name: string;
  value: string;
}

export interface EffectiveClaudeConfig {
  revision: number;
  role: InstanceRole;
  rules: EffectiveRule[];
  skills: EffectiveSkill[];
  mcp: EffectiveMcp[];
  permissions: EffectivePermission[];
  env: EffectiveEnv[];
  model: { value: string | null; locked: boolean };
  counts: { rules: number; skills: number; mcp: number; permissions: number; env: number };
}

function state(key: string, enforcement: Enforcement, overrides: ReadonlySet<string>, enabled = true): EffectiveState {
  const locked = enforcement === 'locked';
  const disabledBySpace = !locked && overrides.has(key);
  return { key, locked, disabledBySpace, applied: enabled && !disabledBySpace };
}

/**
 * What applies to an account (its role) in a space (its overrides). Items outside the account's
 * audience are left out entirely (a member never learns about an administrators-only MCP server);
 * disabled items are left out too. `applied` says whether the next sessions receive the item.
 */
export function computeEffective(rows: InstanceConfigRows, role: InstanceRole, overrides: ReadonlySet<string>): EffectiveClaudeConfig {
  const rules = rows.rules
    .filter((rule) => rule.enabled && inAudience(rule.audience, role))
    .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title))
    .map((rule) => ({
      ...state(`rule:${rule.id}`, rule.enforcement, overrides),
      id: rule.id,
      title: rule.title,
      body: rule.body,
      version: rule.version,
      audience: rule.audience,
    }));
  const skills = rows.skills
    .filter((skill) => skill.enabled && inAudience(skill.audience, role))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((skill) => ({
      ...state(`skill:${skill.id}`, skill.enforcement, overrides),
      id: skill.id,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      hash: skill.contentHash,
      audience: skill.audience,
      allowScripts: skill.allowScripts,
      fileCount: skill.fileCount,
    }));
  const mcp = rows.mcp
    // Coolify is never offered outside the administrators, whatever the stored audience says.
    .filter((server) => server.enabled && inAudience(server.kind === 'coolify' ? 'admins' : server.audience, role))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((server) => ({
      ...state(`mcp:${server.id}`, server.enforcement, overrides),
      id: server.id,
      name: server.name,
      label: server.label,
      kind: server.kind,
      audience: server.kind === 'coolify' ? ('admins' as const) : server.audience,
      unavailable: mcpUnavailable(server),
    }));
  const permissions: EffectivePermission[] = [];
  for (const list of ['allow', 'ask', 'deny'] as const) {
    for (const entry of rows.policy[list]) {
      permissions.push({ ...state(`perm:${entry.id}`, entry.enforcement, overrides), id: entry.id, rule: entry.rule, list, note: entry.note ?? null });
    }
  }
  const env = rows.policy.env.map((entry) => ({ ...state(`env:${entry.id}`, entry.enforcement, overrides), id: entry.id, name: entry.name, value: entry.value }));
  const count = (items: EffectiveState[]) => items.filter((item) => item.applied).length;
  return {
    revision: rows.policy.revision,
    role,
    rules,
    skills,
    mcp,
    permissions,
    env,
    model: { value: rows.policy.defaultModel, locked: rows.policy.modelEnforcement === 'locked' && rows.policy.defaultModel !== null },
    counts: {
      rules: count(rules),
      skills: count(skills),
      mcp: mcp.filter((server) => server.applied && !server.unavailable).length,
      permissions: count(permissions),
      env: count(env),
    },
  };
}

/** Why an instance MCP server is not handed to the sessions, or null. */
export function mcpUnavailable(server: McpItem): string | null {
  if (server.kind === 'coolify') return instanceCoolifyRefusal(server);
  if (server.transport === 'stdio') return server.command ? null : 'Commande absente.';
  if (!server.url) return 'Adresse absente.';
  if ((server.authKind === 'bearer' || server.authKind === 'header') && !server.hasSecrets) return 'En-têtes secrets absents.';
  return null;
}

// ---------------------------------------------------------------------------------------------
// What the CLI receives
// ---------------------------------------------------------------------------------------------

const RULES_HEADER = {
  default:
    "<!-- Nuera Dev · règles communes de l'instance (« Par défaut »). Fichier réécrit par le runner : modifiez-les dans Administration › Claude. -->",
  locked:
    "<!-- Nuera Dev · règles imposées par l'administration de l'instance. Fichier réécrit par le runner : modifiez-les dans Administration › Claude. -->",
};

/** Markdown of the applied rules of one enforcement, or null when none applies. */
export function renderRules(rules: readonly EffectiveRule[], enforcement: Enforcement): string | null {
  const selected = rules.filter((rule) => rule.applied && rule.locked === (enforcement === 'locked'));
  if (selected.length === 0) return null;
  const title =
    enforcement === 'locked'
      ? "# Règles imposées par l'administration de Nuera Dev\n\nCes règles s'appliquent à toutes les sessions de l'instance et priment sur les instructions du projet."
      : "# Règles communes de Nuera Dev\n\nNormes partagées par tous les développeurs de l'instance. Le CLAUDE.md du projet peut les préciser.";
  const sections = selected.map((rule) => `## ${rule.title.replace(/[\r\n]+/g, ' ')}\n\n${rule.body.trim()}`);
  return `${RULES_HEADER[enforcement]}\n\n${title}\n\n${sections.join('\n\n')}\n`;
}

export const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** Hash of the files of a skill (paths, execute bits, contents): what a runner compares. */
export function skillContentHash(files: ReadonlyArray<{ path: string; content: string; executable: boolean }>): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((file) => [file.path, file.executable, file.content]);
  return sha256(JSON.stringify(sorted));
}

/** Hash of what a runner writes (rules + skills): carried by the launch options of each session. */
export function commonConfigHash(input: { defaultMarkdown: string | null; lockedMarkdown: string | null; skills: ReadonlyArray<{ name: string; hash: string; version: number }> }): string {
  return sha256(
    JSON.stringify({
      defaultMarkdown: input.defaultMarkdown,
      lockedMarkdown: input.lockedMarkdown,
      skills: [...input.skills].sort((a, b) => a.name.localeCompare(b.name)).map((skill) => [skill.name, skill.hash, skill.version]),
    }),
  );
}

/** Applied « Imposé » / « Par défaut » permission rules of the policy, per list. */
export function policyPermissionRules(effective: Pick<EffectiveClaudeConfig, 'permissions'>): McpPermissionRules {
  const rules: McpPermissionRules = { allow: [], ask: [], deny: [] };
  for (const entry of effective.permissions) if (entry.applied) rules[entry.list].push(entry.rule);
  return rules;
}

/** Applied variables: « Imposé » ones go to the session settings, « Par défaut » ones to the process env. */
export function policyEnv(effective: Pick<EffectiveClaudeConfig, 'env'>): { locked: Record<string, string>; defaults: Record<string, string> } {
  const locked: Record<string, string> = {};
  const defaults: Record<string, string> = {};
  for (const entry of effective.env) if (entry.applied) (entry.locked ? locked : defaults)[entry.name] = entry.value;
  return { locked, defaults };
}

/** Short summary shown on a session (« 3 règles · 4 skills · 2 MCP »). */
export function summaryLine(counts: Pick<EffectiveClaudeConfig['counts'], 'rules' | 'skills' | 'mcp'>): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
  return [plural(counts.rules, 'règle', 'règles'), plural(counts.skills, 'skill', 'skills'), `${counts.mcp} MCP`].join(' · ');
}

/** New stable id of a policy entry. */
export function newEntryId(): string {
  return randomBytes(12).toString('base64url');
}
