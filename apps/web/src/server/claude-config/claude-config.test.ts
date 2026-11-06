import { auditLog, instanceConfigVersions, projectEnvVars, sessions } from '@nuera/db/schema';
import { CommonConfigPayloadSchema } from '@nuera/shared/runner';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@/server/auth/session';
import { closeWebTestDb, dropWebTestDatabase, prepareWebTestDatabase, useTestEncryptionKey } from '@/server/tenancy/test/db';
import { createTestAccount, createTestResources, truncateTenancy, twoSpaces, type TestAccount } from '@/server/tenancy/test/fixtures';
import { startFakeMcp } from '@/server/mcp/test/fake-mcp';
import { buildZip } from './test/zip';

/*
 * Configuration Claude commune (lot K1) against PostgreSQL (`nuera_k1_claude_config`): versions and
 * rollback, .zip import, what the runner of each server receives (audience by the role of the space's
 * account, choices of the space, files omitted when known), the launch options of a session (merge
 * precedence of permissions, variables, model, MCP), the administrators-only Coolify server never
 * reaching a member (config nor headers), proposals, and the routes (403 for a member, internal route
 * by server token).
 */

const DATABASE = 'nuera_k1_claude_config';
const APP_URL = 'http://localhost:3660';
const RUNNER_TOKEN = 'runner-token-for-k1-tests-0123456789';

const state = vi.hoisted(() => ({ current: null as CurrentUser | null, syncs: [] as string[] }));

vi.mock('@/server/auth/session', async () => {
  const { AppError } = await import('@/server/errors');
  return {
    getCurrentUser: async () => state.current,
    requireUser: async () => state.current,
    requireUserForApi: async () => {
      if (!state.current) throw new AppError('UNAUTHORIZED');
      return state.current;
    },
    isInstanceAdmin: (u: Pick<CurrentUser, 'role'>) => u.role === 'owner' || u.role === 'admin',
  };
});

vi.mock('@/server/runner/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/runner/client')>();
  const status = { hash: null, revision: null, appliedAt: null, checkedAt: null, skills: [], conflicts: [], rules: { defaultFile: false, lockedFile: false, count: 0 }, error: null };
  return {
    ...actual,
    getRunnerForEnvironment: (id: string) => ({
      claudeConfigSync: async () => {
        state.syncs.push(id);
        return status;
      },
      claudeConfigStatus: async () => status,
    }),
  };
});

const k1 = await import('./index');
const { buildLaunchPlan } = await import('@/server/sessions/service');
const { resolveSessionMcpHeaders } = await import('@/server/mcp/headers');
const { db } = await import('@/server/db');
const { rateLimiter } = await import('@/server/security/rate-limit');
const { encryptSecret, SecretScopes } = await import('@/server/security/crypto');
const { applySettingsPatch, getEffectiveSessionPolicy } = await import('@/server/settings');

let a: TestAccount;
let b: TestAccount;
const actor = (account: TestAccount) => ({ id: account.user.id, name: account.user.name, email: account.user.email, role: account.user.role });

const SKILL_MD = '---\nname: revue-pr\ndescription: Relecture des pull requests de Nuera Dev.\n---\n\n# Relecture\n\nVérifie les tests.\n';

type Handler = (request: NextRequest, context: { params: Promise<unknown> }) => Promise<Response>;

async function call(handler: Handler, method: string, path: string, options: { params?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { origin: APP_URL, host: 'localhost:3660', ...(options.headers ?? {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await handler(
    new NextRequest(`${APP_URL}${path}`, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }),
    { params: Promise.resolve(options.params ?? {}) },
  );
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

beforeAll(async () => {
  await prepareWebTestDatabase(DATABASE);
  useTestEncryptionKey();
  process.env.APP_URL = APP_URL;
  process.env.NUERA_RATE_LIMIT_FACTOR = '50';
  process.env.NUERA_CLAUDE_CONFIG_PUSH = 'off';
});

afterAll(async () => {
  await closeWebTestDb();
  await dropWebTestDatabase(DATABASE);
}, 60_000);

beforeEach(async () => {
  vi.stubEnv('RUNNER_TOKEN', RUNNER_TOKEN);
  vi.stubEnv('APP_URL', APP_URL);
  rateLimiter.reset();
  state.syncs.length = 0;
  await truncateTenancy();
  ({ a, b } = await twoSpaces());
  state.current = a.user;
});

describe('règles : versions, différences, retour arrière', () => {
  it('crée, modifie, supprime puis restaure une règle, chaque étape versionnée et journalisée', async () => {
    const rule = await k1.createRule(actor(a), { title: 'Commits', body: 'Messages conventionnels.', enforcement: 'locked' });
    const updated = await k1.updateRule(actor(a), rule.id, { body: 'Messages conventionnels sobres.', expectedVersion: 1 });
    expect(updated.version).toBe(2);
    await expect(k1.updateRule(actor(a), rule.id, { body: 'x', expectedVersion: 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
    const history = await k1.listHistory(actor(a), { kind: 'rule', itemId: rule.id });
    expect(history.items.map((item) => [item.version, item.action])).toEqual([
      [2, 'updated'],
      [1, 'created'],
    ]);
    const detail = await k1.getVersionDetail(actor(a), String(history.items[0]!.id));
    expect(detail.diff.filter((part) => part.added).map((part) => part.value.trim())).toEqual(['Messages conventionnels sobres.']);
    expect(detail.diff.filter((part) => part.removed).map((part) => part.value.trim())).toEqual(['Messages conventionnels.']);

    await k1.deleteRule(actor(a), rule.id);
    expect((await k1.loadClaudeAdminOverview(actor(a))).rows.rules).toEqual([]);
    const restored = await k1.rollbackVersion(actor(a), String(history.items[1]!.id));
    expect(restored).toMatchObject({ kind: 'rule', itemId: rule.id, version: 4 });
    const [back] = (await k1.loadClaudeAdminOverview(actor(a))).rows.rules;
    expect(back).toMatchObject({ id: rule.id, body: 'Messages conventionnels.', enforcement: 'locked', version: 4 });
    const actions = (await db.select({ action: auditLog.action }).from(auditLog)).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(['instance.claude_rule_created', 'instance.claude_rule_updated', 'instance.claude_rule_deleted', 'instance.claude_version_restored']));
    expect((await k1.loadClaudeAdminOverview(actor(a))).rows.policy.revision).toBe(4);
  });

  it("refuse toute écriture à un membre, même en appelant le module directement", async () => {
    await expect(k1.createRule(actor(b), { title: 'x', body: 'y' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(k1.updatePolicy(actor(b), { deny: [] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(k1.importSkillZip(actor(b), buildZip([{ name: 'SKILL.md', content: SKILL_MD }]), {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('skills : import, versions et serveurs', () => {
  it("importe un .zip, ne le remplace qu'à la demande, et sert ses fichiers une seule fois au runner", async () => {
    const zip = buildZip([
      { name: 'revue-pr/SKILL.md', content: SKILL_MD },
      { name: 'revue-pr/references/liste.md', content: '- tests\n' },
    ]);
    const first = await k1.importSkillZip(actor(a), zip, {});
    expect(first).toMatchObject({ created: true, scripts: [], skill: { name: 'revue-pr', version: 1, fileCount: 2 } });
    await expect(k1.importSkillZip(actor(a), zip, {})).rejects.toMatchObject({ code: 'CONFLICT' });
    const withScript = buildZip([
      { name: 'SKILL.md', content: SKILL_MD },
      { name: 'scripts/verifier.sh', content: '#!/bin/sh\necho ok\n' },
    ]);
    await expect(k1.importSkillZip(actor(a), withScript, { replace: true })).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/script/) });
    const second = await k1.importSkillZip(actor(a), withScript, { replace: true, allowScripts: true });
    expect(second).toMatchObject({ created: false, scripts: ['scripts/verifier.sh'], skill: { version: 2, allowScripts: true } });

    const payload = CommonConfigPayloadSchema.parse(await k1.runnerPayload({ spaceId: b.space.id }, { have: [] }));
    expect(payload.skills).toHaveLength(1);
    expect(payload.skills[0]!.files!.map((file) => [file.path, file.executable])).toEqual([
      ['SKILL.md', false],
      ['scripts/verifier.sh', true],
    ]);
    const again = await k1.runnerPayload({ spaceId: b.space.id }, { have: [{ name: 'revue-pr', hash: payload.skills[0]!.hash }] });
    expect(again.skills[0]!.files).toBeNull();
    expect(again.hash).toBe(payload.hash);
    // Rollback to version 1: the reference file comes back, the script goes.
    const versions = await k1.listHistory(actor(a), { kind: 'skill' });
    await k1.rollbackVersion(actor(a), String(versions.items.find((item) => item.version === 1)!.id));
    const detail = await k1.getSkillDetail(actor(a), first.skill.id);
    expect(detail.files.map((file) => file.path)).toEqual(['SKILL.md', 'references/liste.md']);
    expect(detail.skill.version).toBe(3);
    // An unassigned server gets nothing.
    expect((await k1.runnerPayload({ spaceId: null }, { have: [] })).skills).toEqual([]);
  });

  it("la description modifiée est réécrite dans SKILL.md (même texte dans le CLI)", async () => {
    const { skill } = await k1.createSkillFromEditor(actor(a), { name: 'revue-pr', skillMd: SKILL_MD });
    await k1.updateSkillMeta(actor(a), skill.id, { description: 'Nouvelle description.' });
    const detail = await k1.getSkillDetail(actor(a), skill.id);
    expect(detail.files[0]!.content).toContain('description: "Nouvelle description."');
    expect(detail.skill.description).toBe('Nouvelle description.');
    expect(detail.skill.contentHash).not.toBe(skill.contentHash);
  });
});

describe('ce que reçoit chaque compte', () => {
  async function seed() {
    await k1.createRule(actor(a), { title: 'Commits', body: 'Messages conventionnels.' });
    await k1.createRule(actor(a), { title: 'Production', body: 'Demander avant de déployer.', audience: 'admins', enforcement: 'locked' });
    await k1.createSkillFromEditor(actor(a), { name: 'revue-pr', skillMd: SKILL_MD });
    await k1.createSkillFromEditor(actor(a), { name: 'infra', skillMd: SKILL_MD.replace('revue-pr', 'infra'), audience: 'admins' });
    await k1.updatePolicy(actor(a), {
      allow: [{ rule: 'Bash(npm test:*)' }],
      ask: [{ rule: 'Bash(git push:*)', enforcement: 'locked' }],
      deny: [{ rule: 'Bash(rm -rf /*)', enforcement: 'locked' }],
      env: [
        { name: 'PROJET_NORME', value: 'stricte', enforcement: 'locked' },
        { name: 'LANGUE_DOCS', value: 'fr', enforcement: 'default' },
      ],
      defaultModel: 'opus',
    });
  }

  it('le runner du membre ne reçoit que ce qui vise tous les comptes ; celui du propriétaire tout', async () => {
    await seed();
    const member = await k1.runnerPayload({ spaceId: b.space.id }, { have: [] });
    expect(member.rules.items.map((rule) => rule.title)).toEqual(['Commits']);
    expect(member.rules.lockedMarkdown).toBeNull();
    expect(member.rules.defaultMarkdown).toContain('## Commits');
    expect(member.skills.map((skill) => skill.name)).toEqual(['revue-pr']);
    const owner = await k1.runnerPayload({ spaceId: a.space.id }, { have: [] });
    expect(owner.rules.lockedMarkdown).toContain('## Production');
    expect(owner.skills.map((skill) => skill.name)).toEqual(['infra', 'revue-pr']);
    expect(owner.hash).not.toBe(member.hash);
  });

  it("précédence : interdictions et demandes de l'instance, variables du projet au-dessus des variables par défaut, modèle", async () => {
    await seed();
    const resources = await createTestResources(b, 'k1-membre');
    await db.insert(projectEnvVars).values({
      projectId: resources.projectId,
      key: 'LANGUE_DOCS',
      valueEncrypted: encryptSecret('en', SecretScopes.projectEnvVar(resources.projectId, 'LANGUE_DOCS')),
    });
    const plan = await buildLaunchPlan(b.ctx, { projectId: resources.projectId, spaceId: b.space.id });
    expect(plan.launch.denyRules).toContain('Bash(rm -rf /*)');
    expect(plan.launch.askRules).toEqual(['Bash(git push:*)']);
    expect(plan.launch.allowRules).toEqual(['Bash(npm test:*)']);
    expect(plan.launch.settingsEnv).toEqual({ PROJET_NORME: 'stricte' });
    expect(plan.launch.env).toMatchObject({ LANGUE_DOCS: 'en' });
    expect(plan.launch.commonConfig?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.defaultModel).toBe('opus');
    expect(plan.lockedModel).toBeNull();
    expect(plan.common.summary).toBe('1 règle · 1 skill · 0 MCP');

    // The space turns a « Par défaut » item off; an « Imposé » one cannot be.
    const config = await k1.getMyClaudeConfig(b.ctx);
    const allow = config.effective.permissions.find((entry) => entry.list === 'allow')!;
    const deny = config.effective.permissions.find((entry) => entry.list === 'deny')!;
    await k1.setSpaceOverride(b.ctx, { key: allow.key, disabled: true });
    await expect(k1.setSpaceOverride(b.ctx, { key: deny.key, disabled: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // An item outside the member's audience answers like an unknown one.
    const ownerConfig = await k1.getMyClaudeConfig(a.ctx);
    const adminRule = ownerConfig.effective.rules.find((rule) => rule.title === 'Production')!;
    await expect(k1.setSpaceOverride(b.ctx, { key: adminRule.key, disabled: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await buildLaunchPlan(b.ctx, { projectId: resources.projectId, spaceId: b.space.id })).launch.allowRules).toEqual([]);

    // Model « Imposé »: forced at launch, the space setting becomes read-only.
    await k1.updatePolicy(actor(a), { defaultModel: 'sonnet', modelEnforcement: 'locked' });
    expect((await buildLaunchPlan(b.ctx, { projectId: resources.projectId, spaceId: b.space.id })).lockedModel).toBe('sonnet');
    expect((await getEffectiveSessionPolicy(b.space.id)).defaultModel).toBe('sonnet');
    const refused = await applySettingsPatch({ userId: b.user.id, role: 'member', spaceId: b.space.id, environmentId: b.environment!.id }, { defaultModel: 'opus' });
    expect(refused.error?.code).toBe('FORBIDDEN');
  });
});

describe('MCP communs et Coolify (administrateurs)', () => {
  it("un membre ne reçoit jamais le Coolify des administrateurs : ni dans sa configuration, ni ses en-têtes", async () => {
    vi.stubEnv('NUERA_PRIVATE_HOSTS', '127.0.0.1');
    const fake = await startFakeMcp({ expectedAuthorization: 'Bearer coolify-admin-token-0123', tools: ['list_applications', 'deploy', 'get_env_values', 'delete_application'] });
    try {
      const base = fake.url.replace(/\/mcp$/, '');
      const server = await k1.createInstanceMcp(actor(a), { kind: 'coolify', baseUrl: base, token: 'coolify-admin-token-0123', allowWrite: true });
      expect(server).toMatchObject({ name: 'coolify-admin', audience: 'admins', hasSecrets: true, secretKeys: ['Authorization'] });
      expect(JSON.stringify(server)).not.toContain('coolify-admin-token');
      // Not tested yet: never served, even to the owner.
      const before = await buildLaunchPlan(a.ctx, { projectId: (await createTestResources(a, 'k1-proprio')).projectId, spaceId: a.space.id });
      expect(before.launch.mcpConfig?.mcpServers?.['coolify-admin']).toBeUndefined();
      expect(before.common.skipped.map((entry) => entry.name)).toContain('coolify-admin');

      const tested = await k1.testInstanceMcp(actor(a), server.id, { fetchImpl: fetch });
      expect(tested).toMatchObject({ ok: true, tools: ['list_applications', 'deploy', 'get_env_values', 'delete_application'] });
      expect(tested.rules).toEqual({
        allow: ['mcp__coolify-admin__list_applications'],
        ask: ['mcp__coolify-admin__deploy', 'mcp__coolify-admin__get_env_values'],
        deny: ['mcp__coolify-admin__delete_application'],
      });

      const ownerResources = await createTestResources(a, 'k1-proprio-2');
      const ownerPlan = await buildLaunchPlan(a.ctx, { projectId: ownerResources.projectId, spaceId: a.space.id });
      expect(ownerPlan.launch.mcpConfig!.mcpServers['coolify-admin']).toEqual({ type: 'http', url: `${base}/mcp`, headersHelper: 'nuera' });
      expect(JSON.stringify(ownerPlan.launch)).not.toContain('coolify-admin-token');
      expect(ownerPlan.launch.askRules).toEqual(expect.arrayContaining(['mcp__coolify-admin__deploy']));
      expect(ownerPlan.launch.denyRules).toContain('mcp__coolify-admin__delete_application');
      expect(ownerPlan.launch.blockBypassPermissions).toBe(true);
      const headers = await resolveSessionMcpHeaders({ sessionId: ownerResources.sessionId, serverName: 'coolify-admin', environmentId: a.environment!.id, serverUrl: `${base}/mcp` });
      expect(headers.headers).toEqual({ Authorization: 'Bearer coolify-admin-token-0123' });
      await expect(
        resolveSessionMcpHeaders({ sessionId: ownerResources.sessionId, serverName: 'coolify-admin', environmentId: a.environment!.id, serverUrl: 'https://ailleurs.example.test/mcp' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      const memberResources = await createTestResources(b, 'k1-membre-2');
      const memberPlan = await buildLaunchPlan(b.ctx, { projectId: memberResources.projectId, spaceId: b.space.id });
      expect(memberPlan.launch.mcpConfig?.mcpServers?.['coolify-admin']).toBeUndefined();
      expect(JSON.stringify(memberPlan)).not.toContain('coolify');
      await expect(
        resolveSessionMcpHeaders({ sessionId: memberResources.sessionId, serverName: 'coolify-admin', environmentId: b.environment!.id, serverUrl: `${base}/mcp` }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // Even with the audience « all » stored by hand, Coolify stays with the administrators.
      await expect(k1.updateInstanceMcp(actor(a), server.id, { audience: 'all' })).rejects.toMatchObject({ code: 'VALIDATION' });
      expect((await k1.getMyClaudeConfig(b.ctx)).effective.mcp).toEqual([]);

      // Demoted to member: the owner's server would stop receiving it at once (role of the account).
      const admin = await createTestAccount({ role: 'admin', name: 'Admin', email: 'admin@example.test' });
      const adminResources = await createTestResources(admin, 'k1-admin');
      expect((await buildLaunchPlan(admin.ctx, { projectId: adminResources.projectId, spaceId: admin.space.id })).launch.mcpConfig!.mcpServers['coolify-admin']).toBeDefined();
      const { user } = await import('@nuera/db/schema');
      await db.update(user).set({ role: 'member' }).where(eq(user.id, admin.user.id));
      expect((await buildLaunchPlan(admin.ctx, { projectId: adminResources.projectId, spaceId: admin.space.id })).launch.mcpConfig?.mcpServers?.['coolify-admin']).toBeUndefined();
      await expect(
        resolveSessionMcpHeaders({ sessionId: adminResources.sessionId, serverName: 'coolify-admin', environmentId: admin.environment!.id }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      // A new token is unverified until the next test.
      await k1.updateInstanceMcp(actor(a), server.id, { token: 'coolify-admin-token-9999' });
      await expect(
        resolveSessionMcpHeaders({ sessionId: ownerResources.sessionId, serverName: 'coolify-admin', environmentId: a.environment!.id }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/non vérifiés/) });
    } finally {
      await fake.close();
    }
  });

  it("seul le propriétaire propose les outils destructifs, et un serveur commun prend le nom d'un serveur de l'espace", async () => {
    const admin = await createTestAccount({ role: 'admin', name: 'Admin', email: 'admin2@example.test' });
    await expect(
      k1.createInstanceMcp(actor(admin), { kind: 'coolify', baseUrl: 'https://coolify.example.test', token: 'token-0123456789', allowWrite: true, allowDestructive: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const docs = await k1.createInstanceMcp(actor(a), { kind: 'custom', name: 'docs', label: 'Docs', transport: 'http', url: 'https://docs.example.test/mcp', authKind: 'bearer', bearerToken: 'docs-secret', askTools: ['write_page'] });
    const resources = await createTestResources(b, 'k1-docs');
    const plan = await buildLaunchPlan(b.ctx, { projectId: resources.projectId, spaceId: b.space.id });
    expect(plan.launch.mcpConfig!.mcpServers.docs).toEqual({ type: 'http', url: 'https://docs.example.test/mcp', headersHelper: 'nuera' });
    expect(plan.launch.askRules).toContain('mcp__docs__write_page');
    expect((await resolveSessionMcpHeaders({ sessionId: resources.sessionId, serverName: 'docs', environmentId: b.environment!.id })).headers).toEqual({ Authorization: 'Bearer docs-secret' });
    // Admins only: the member loses it, config and headers alike.
    await k1.updateInstanceMcp(actor(a), docs.id, { audience: 'admins' });
    expect((await buildLaunchPlan(b.ctx, { projectId: resources.projectId, spaceId: b.space.id })).launch.mcpConfig?.mcpServers?.docs).toBeUndefined();
    await expect(resolveSessionMcpHeaders({ sessionId: resources.sessionId, serverName: 'docs', environmentId: b.environment!.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Versions of an MCP server never hold a secret.
    const versions = await db.select({ snapshot: instanceConfigVersions.snapshot }).from(instanceConfigVersions).where(eq(instanceConfigVersions.itemKind, 'mcp'));
    expect(JSON.stringify(versions)).not.toContain('docs-secret');
  });
});

describe('propositions des membres', () => {
  it("une proposition n'agit qu'une fois approuvée ; un refus ne laisse rien", async () => {
    const proposal = await k1.createProposal(b.user, { kind: 'rule', title: 'Revue', body: 'Toujours relire le diff.', note: 'Vu en revue.' });
    expect((await k1.runnerPayload({ spaceId: b.space.id }, { have: [] })).rules.items).toEqual([]);
    expect(await k1.listMyProposals(b.user)).toHaveLength(1);
    await expect(k1.decideProposal(actor(b), proposal.id, { decision: 'approve' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const approved = await k1.decideProposal(actor(a), proposal.id, { decision: 'approve', note: 'Merci.' });
    expect(approved).toMatchObject({ status: 'approved', appliedItemId: expect.any(String) });
    await expect(k1.decideProposal(actor(a), proposal.id, { decision: 'reject' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await k1.runnerPayload({ spaceId: b.space.id }, { have: [] })).rules.items.map((rule) => rule.title)).toEqual(['Revue']);

    const skill = await k1.createProposal(b.user, { kind: 'skill', name: 'tests-e2e', skillMd: SKILL_MD.replace('revue-pr', 'tests-e2e') });
    await k1.decideProposal(actor(a), skill.id, { decision: 'reject', note: 'Doublon.' });
    expect((await k1.loadClaudeAdminOverview(actor(a))).rows.skills).toEqual([]);
    await expect(k1.createProposal(b.user, { kind: 'skill', name: 'autre', skillMd: SKILL_MD })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('routes', () => {
  it("un membre reçoit 403 sur chaque route d'administration, la route interne répond par serveur", async () => {
    const overview = await import('@/app/api/admin/claude/route');
    const rules = await import('@/app/api/admin/claude/rules/route');
    const policy = await import('@/app/api/admin/claude/policy/route');
    const mine = await import('@/app/api/claude/config/route');
    const internal = await import('@/app/api/internal/claude-config/route');
    state.current = b.user;
    expect((await call(overview.GET, 'GET', '/api/admin/claude')).status).toBe(403);
    expect((await call(rules.POST, 'POST', '/api/admin/claude/rules', { body: { title: 'x', body: 'y' } })).status).toBe(403);
    expect((await call(policy.PATCH, 'PATCH', '/api/admin/claude/policy', { body: { deny: [] } })).status).toBe(403);
    state.current = a.user;
    // Origin check on mutations.
    expect((await call(rules.POST, 'POST', '/api/admin/claude/rules', { body: { title: 'x', body: 'y' }, headers: { origin: 'https://ailleurs.example.test' } })).status).toBe(403);
    const created = await call(rules.POST, 'POST', '/api/admin/claude/rules', { body: { title: 'Commits', body: 'Sobres.' } });
    expect(created.status).toBe(200);
    expect((await call(rules.POST, 'POST', '/api/admin/claude/rules', { body: { title: '', body: '' } })).status).toBe(422);
    state.current = b.user;
    const read = await call(mine.GET, 'GET', '/api/claude/config');
    expect(read.status).toBe(200);
    expect((read.body!.config as { summary: string }).summary).toBe('1 règle · 0 skill · 0 MCP');
    // Internal route: by server token only.
    expect((await call(internal.POST, 'POST', '/api/internal/claude-config', { body: { have: [] } })).status).toBe(401);
    const payload = await call(internal.POST, 'POST', '/api/internal/claude-config', { body: { have: [] }, headers: { authorization: `Bearer ${b.token}` } });
    expect(payload.status).toBe(200);
    expect(CommonConfigPayloadSchema.parse(payload.body).rules.items.map((rule) => rule.title)).toEqual(['Commits']);
  });

  it('enregistre ce que la session a reçu et signale un changement depuis', async () => {
    const resources = await createTestResources(b, 'k1-instantane');
    const plan = await buildLaunchPlan(b.ctx, { projectId: resources.projectId, spaceId: b.space.id });
    await k1.recordSessionConfig(resources.sessionId, b.space.id, plan.common);
    expect((await k1.sessionConfigView(b.space.id, resources.sessionId)).changedSince).toBe(false);
    await k1.createRule(actor(a), { title: 'Nouvelle', body: 'Règle.' });
    const view = await k1.sessionConfigView(b.space.id, resources.sessionId);
    expect(view.changedSince).toBe(true);
    expect(view.applied?.summary).toBe('0 règle · 0 skill · 0 MCP');
    // Another space never reads it.
    expect((await k1.sessionConfigView(a.space.id, resources.sessionId)).applied).toBeNull();
    await db.delete(sessions).where(eq(sessions.id, resources.sessionId));
  });

  it('synchronise les serveurs en service', async () => {
    const results = await k1.syncServers('manual');
    expect(results.map((result) => result.environmentId).sort()).toEqual([a.environment!.id, b.environment!.id].sort());
    expect(state.syncs.sort()).toEqual([a.environment!.id, b.environment!.id].sort());
  });
});
