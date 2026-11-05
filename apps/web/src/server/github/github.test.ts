import { integrations, notifications, projects } from '@nuera/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, dumpIntegrationTables, prepareTestDatabase, resetTables, TEST_USER_ID, useTestEncryptionKey } from '@/server/integrations/test/db';
import { addInstallation, startFakeGithub, type FakeGithub } from './test/fake-github';

let fake: FakeGithub;

beforeAll(async () => {
  await prepareTestDatabase('github');
  useTestEncryptionKey();
  fake = await startFakeGithub();
  process.env.GITHUB_API_URL = fake.url;
  process.env.GITHUB_WEB_URL = 'https://github.example.test';
  process.env.APP_URL = 'http://localhost:3104';
  delete process.env.GITHUB_FALLBACK_TOKEN;
});

afterAll(async () => {
  await fake?.close();
  await closeTestDb();
});

beforeEach(async () => {
  await resetTables();
  const { clearGithubTokenCache } = await import('./tokens');
  clearGithubTokenCache();
  fake.requests.length = 0;
  fake.tokens.length = 0;
  fake.installations.length = 0;
  fake.repos.length = 0;
  fake.pulls.length = 0;
  fake.rejectJwt = false;
  fake.conversionCodes = new Set(['valid-code']);
  (globalThis as { __nueraGithubLastManualCheck?: number }).__nueraGithubLastManualCheck = 0;
});

const ORG = { login: 'nuera-studio', id: 1001, type: 'Organization' as const };
const USER = { login: 'ethanthedevelop', id: 2002, type: 'User' as const };
const FULL_PERMISSIONS = { contents: 'write', pull_requests: 'write', metadata: 'read', checks: 'read', statuses: 'read', issues: 'read' };

async function connectApp() {
  const { completeManifestConversion } = await import('./manifest');
  return completeManifestConversion({ code: 'valid-code', userId: TEST_USER_ID });
}

async function installOn(account: typeof ORG | typeof USER, id: number, repos: string[], stateValid = true) {
  addInstallation(
    fake,
    { id, account, permissions: FULL_PERMISSIONS, repos },
    repos.map((name, index) => ({ id: id * 100 + index, name, pushedAt: new Date(Date.now() - index * 86_400_000).toISOString() })),
  );
  const { handleInstallationSetup } = await import('./manifest');
  return handleInstallationSetup({ installationId: id, setupAction: 'install', userId: TEST_USER_ID, stateValid });
}

describe('manifest', () => {
  it('builds the App manifest from APP_URL (name, URLs, permissions, inactive webhook, public)', async () => {
    const { buildAppManifest } = await import('./manifest');
    const manifest = buildAppManifest({ appUrl: 'https://dev.nuera.studio' });
    expect(manifest.name).toBe('Nuera Dev · dev.nuera.studio');
    expect(manifest.name.length).toBeLessThanOrEqual(34);
    expect(manifest.redirect_url).toBe('https://dev.nuera.studio/api/integrations/github/callback');
    expect(manifest.callback_urls).toEqual(['https://dev.nuera.studio/api/integrations/github/callback']);
    expect(manifest.setup_url).toBe('https://dev.nuera.studio/api/integrations/github/setup');
    expect(manifest.hook_attributes.active).toBe(false);
    expect(manifest.public).toBe(true);
    expect(manifest.default_permissions).toEqual(FULL_PERMISSIONS);
  });

  it('signs a state bound to the user and the browser, valid one hour', async () => {
    const { createGithubState, verifyGithubState } = await import('./manifest');
    const { state, nonce } = createGithubState({ purpose: 'manifest', userId: TEST_USER_ID });
    expect(verifyGithubState({ state, purpose: 'manifest', userId: TEST_USER_ID, cookieNonce: nonce }).nonce).toBe(nonce);
    expect(() => verifyGithubState({ state, purpose: 'manifest', userId: 'other', cookieNonce: nonce })).toThrow();
    expect(() => verifyGithubState({ state, purpose: 'manifest', userId: TEST_USER_ID, cookieNonce: 'x'.repeat(32) })).toThrow();
    expect(() => verifyGithubState({ state, purpose: 'install', userId: TEST_USER_ID, cookieNonce: nonce })).toThrow();
    expect(() => verifyGithubState({ state: `${state.slice(0, -4)}AAAA`, purpose: 'manifest', userId: TEST_USER_ID, cookieNonce: nonce })).toThrow();
    const old = createGithubState({ purpose: 'manifest', userId: TEST_USER_ID, now: Date.now() - 61 * 60_000 });
    expect(() => verifyGithubState({ state: old.state, purpose: 'manifest', userId: TEST_USER_ID, cookieNonce: old.nonce })).toThrow(/expiré/);
  });

  it('renders an auto-submitting form towards github.com with the escaped manifest', async () => {
    const { renderManifestFormPage, startManifestFlow } = await import('./manifest');
    const form = await startManifestFlow({ userId: TEST_USER_ID, organization: 'nuera-studio' });
    expect(form.action.startsWith('https://github.example.test/organizations/nuera-studio/settings/apps/new?state=')).toBe(true);
    const html = renderManifestFormPage(form);
    expect(html).toContain('method="post"');
    expect(html).toContain('&quot;redirect_url&quot;:&quot;http://localhost:3104/api/integrations/github/callback&quot;');
    expect(html).not.toContain('"redirect_url"');
  });

  it('converts the code, stores the credentials encrypted and redirects to the installation page', async () => {
    const result = await connectApp();
    expect(result.installUrl.startsWith(`https://github.example.test/apps/${fake.slug}/installations/new?state=`)).toBe(true);
    const conversion = fake.requests.find((request) => request.path === '/app-manifests/valid-code/conversions');
    expect(conversion?.method).toBe('POST');
    expect(conversion?.authorization).toBeNull();

    const { db } = await import('@/server/db');
    const [row] = await db.select().from(integrations).where(eq(integrations.kind, 'github'));
    expect(row?.status).toBe('pending');
    expect(row?.secretsEncrypted?.startsWith('v1:')).toBe(true);
    const dump = await dumpIntegrationTables();
    expect(dump).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(dump).not.toContain('fake-client-secret');
    expect(dump).not.toContain('fake-webhook-secret');
    expect(dump).toContain('integration.github.app_created');

    const { completeManifestConversion } = await import('./manifest');
    await expect(completeManifestConversion({ code: 'valid-code', userId: TEST_USER_ID })).rejects.toThrow(/déjà/);
  });

  it('refuses an unknown or replayed code', async () => {
    const { completeManifestConversion } = await import('./manifest');
    await expect(completeManifestConversion({ code: 'unknown-code', userId: TEST_USER_ID })).rejects.toThrow(/refusé/);
  });
});

describe('installations', () => {
  it('allow-lists an account only with a valid state, and ignores foreign installations', async () => {
    await connectApp();
    expect((await installOn(ORG, 11, ['nuera-os', 'roux-conseil'])).outcome).toBe('installed');
    expect((await installOn(USER, 22, ['nuera-studio'], false)).outcome).toBe('unknown_installation');
    expect((await installOn(USER, 23, ['nuera-studio'], true)).outcome).toBe('installed');
    const { getStoredGithubApp } = await import('./store');
    const stored = await getStoredGithubApp();
    expect(stored?.config.allowedAccountIds.sort()).toEqual([1001, 2002]);
    const jwtCalls = fake.requests.filter((request) => request.path.startsWith('/app/installations/'));
    expect(jwtCalls.every((request) => /^bearer /i.test(request.authorization ?? ''))).toBe(true);
  });

  it('lists accessible repositories grouped by account with the « Déjà cloné » flag', async () => {
    await connectApp();
    await installOn(ORG, 11, ['nuera-os', 'roux-conseil', 'bistrot-du-port']);
    await installOn(USER, 23, ['nuera-studio']);
    const { db } = await import('@/server/db');
    await db.insert(projects).values({
      slug: 'nuera-studio',
      name: 'Site Nuera Studio',
      githubFullName: 'ethanthedevelop/nuera-studio',
      githubRepoId: 2300,
      cloneUrl: 'https://github.com/ethanthedevelop/nuera-studio.git',
      path: '/srv/dev/nuera-studio',
      status: 'ready',
    });
    const { listAccessibleRepos } = await import('./repos');
    const result = await listAccessibleRepos();
    expect(result.total).toBe(4);
    expect(result.accounts.map((account) => [account.login, account.count])).toEqual([
      ['nuera-studio', 3],
      ['ethanthedevelop', 1],
    ]);
    expect(result.repos.find((repo) => repo.fullName === 'ethanthedevelop/nuera-studio')?.clonedProject?.name).toBe('Site Nuera Studio');
    expect(result.repos.find((repo) => repo.fullName === 'nuera-studio/nuera-os')?.clonedProject).toBeNull();
    // Listing used metadata-only tokens.
    expect(fake.tokens.every((token) => JSON.stringify(token.permissions) === JSON.stringify({ metadata: 'read' }))).toBe(true);
  });

  it('follows every page of every installation (counts are per installation)', async () => {
    await connectApp();
    const names = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(3, '0')}`);
    await installOn(ORG, 11, names('org', 150));
    await installOn(USER, 23, names('perso', 120));
    const { listAccessibleRepos } = await import('./repos');
    const result = await listAccessibleRepos();
    expect(result.total).toBe(270);
    expect(result.accounts.map((account) => [account.login, account.count])).toEqual([
      ['nuera-studio', 150],
      ['ethanthedevelop', 120],
    ]);
    expect(new Set(result.repos.map((repo) => repo.fullName)).size).toBe(270);
  });
});

describe('tokens', () => {
  it('mints tokens down-scoped to one repository and one operation, cached until 5 min before expiry', async () => {
    await connectApp();
    await installOn(ORG, 11, ['nuera-os', 'roux-conseil']);
    const { getGitAuthForRepo } = await import('./access');
    const write = await getGitAuthForRepo('nuera-studio/nuera-os', 'write');
    const issued = fake.tokens.at(-1)!;
    expect(issued.repositories).toEqual(['nuera-os']);
    expect(issued.permissions).toEqual({ metadata: 'read', contents: 'write' });
    expect(write.extraHeader).toBe(`AUTHORIZATION: basic ${Buffer.from(`x-access-token:${issued.token}`).toString('base64')}`);
    expect(Date.parse(write.expiresAt)).toBeGreaterThan(Date.now() + 50 * 60_000);

    const count = fake.tokens.length;
    const again = await getGitAuthForRepo('nuera-studio/nuera-os', 'write');
    expect(again.extraHeader).toBe(write.extraHeader);
    expect(fake.tokens.length).toBe(count);

    const read = await getGitAuthForRepo('nuera-studio/nuera-os', 'read');
    expect(read.extraHeader).not.toBe(write.extraHeader);
    expect(fake.tokens.at(-1)?.permissions).toEqual({ metadata: 'read', contents: 'read' });

    await expect(getGitAuthForRepo('nuera-studio/unknown-repo', 'read')).rejects.toThrow(/n'est pas accordé/);
    await expect(getGitAuthForRepo('someone-else/repo', 'read')).rejects.toThrow();
  });

  it('sends X-GitHub-Api-Version: 2026-03-10 on every REST call', async () => {
    await connectApp();
    await installOn(ORG, 11, ['nuera-os']);
    const { getRepo } = await import('./repos');
    await getRepo('nuera-studio/nuera-os');
    expect(fake.requests.length).toBeGreaterThan(2);
    expect(fake.requests.every((request) => request.apiVersion === '2026-03-10')).toBe(true);
  });
});

describe('pull requests', () => {
  it('creates a pull request with a pull_requests:write token and reads it with its checks', async () => {
    await connectApp();
    await installOn(ORG, 11, ['nuera-os']);
    const { createPullRequest, getPullRequest } = await import('./pulls');
    const pull = await createPullRequest({ fullName: 'nuera-studio/nuera-os', title: 'crm : colonnes glissables', head: 'feature/crm-core', base: 'main' });
    expect(pull).toMatchObject({ number: 57, state: 'open', headRef: 'feature/crm-core', baseRef: 'main', url: 'https://github.com/nuera-studio/nuera-os/pull/57' });
    const token = fake.tokens.at(-1)!;
    expect(token.permissions).toEqual({ metadata: 'read', pull_requests: 'write' });
    expect(token.repositories).toEqual(['nuera-os']);

    await expect(
      createPullRequest({ fullName: 'nuera-studio/nuera-os', title: 'bis', head: 'feature/crm-core', base: 'main' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    fake.checkRuns.push({ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'test', status: 'in_progress', conclusion: null });
    fake.reviews.push({ user: 'nezar', state: 'APPROVED', submittedAt: new Date().toISOString() });
    const detail = await getPullRequest('nuera-studio/nuera-os', 57);
    expect(detail.checks.state).toBe('pending');
    expect(detail.reviews.state).toBe('approved');
    fake.checkRuns[1] = { name: 'test', status: 'completed', conclusion: 'failure' };
    expect((await getPullRequest('nuera-studio/nuera-os', 57)).checks.state).toBe('failure');
  });

  it('derives CI and review states', async () => {
    const { deriveChecksState, deriveReviewsState } = await import('./pulls');
    expect(deriveChecksState([], { state: 'pending', total: 0 })).toBe('none');
    expect(deriveChecksState([{ status: 'completed', conclusion: 'skipped' }], null)).toBe('success');
    expect(deriveReviewsState([{ user: 'a', state: 'APPROVED', submittedAt: '2026-01-01' }, { user: 'a', state: 'CHANGES_REQUESTED', submittedAt: '2026-01-02' }], []).state).toBe('changes_requested');
    expect(deriveReviewsState([{ user: 'a', state: 'COMMENTED', submittedAt: '2026-01-01' }], ['b']).state).toBe('pending');
  });
});

describe('status', () => {
  it('reports connected with accounts, repository count and permissions', async () => {
    await connectApp();
    await installOn(ORG, 11, ['nuera-os', 'roux-conseil']);
    await installOn(USER, 23, ['nuera-studio']);
    const { checkGithub } = await import('./status');
    const status = await checkGithub({ trigger: 'schedule' });
    expect(status.mode).toBe('app');
    expect(status.status).toBe('connected');
    expect(status.repoCount).toBe(3);
    expect(status.accounts.map((account) => account.login).sort()).toEqual(['ethanthedevelop', 'nuera-studio']);
    expect(status.permissions.title).toBe('Contenu · pull requests');
    expect(status.permissions.detail).toBe('lecture et écriture ; issues, checks et statuts en lecture');
    expect(status.lastCheck?.steps.map((step) => step.name)).toContain('GET /app');
    expect(JSON.stringify(status)).not.toMatch(/ghs_|PRIVATE KEY|fake-client-secret/);
  });

  it('moves to « expiré » when GitHub refuses the private key, and notifies once (T7 après)', async () => {
    await connectApp();
    await installOn(ORG, 11, ['nuera-os']);
    const { checkGithub } = await import('./status');
    expect((await checkGithub({ trigger: 'schedule' })).status).toBe('connected');
    fake.rejectJwt = true;
    const status = await checkGithub({ trigger: 'schedule' });
    expect(status.status).toBe('expired');
    expect(status.reason).toMatch(/clé privée/);
    await checkGithub({ trigger: 'schedule' });
    const { db } = await import('@/server/db');
    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'integration_expired', severity: 'danger', title: "L'accès GitHub a été retiré", dedupKey: 'integration:github:expired' });
    expect(rows[0]?.body).toContain('Synchronisation, push et pull requests suspendus. Le travail local continue.');

    fake.rejectJwt = false;
    expect((await checkGithub({ trigger: 'schedule' })).status).toBe('connected');
    const after = await db.select().from(notifications);
    expect(after[0]?.readAt).not.toBeNull();
  });

  it('uses the documented fallback PAT from the environment when no app is stored', async () => {
    fake.pat = { token: 'github_pat_fallbacktoken0123456789', login: 'ethanthedevelop', expiration: '2026-11-07 10:00:00 UTC' };
    process.env.GITHUB_FALLBACK_TOKEN = fake.pat.token;
    try {
      const { checkGithub } = await import('./status');
      const status = await checkGithub({ trigger: 'schedule' });
      expect(status.mode).toBe('fallback_token');
      expect(status.expiresAt).toBe('2026-11-07T10:00:00.000Z');
      expect(JSON.stringify(status)).not.toContain('github_pat_');
    } finally {
      delete process.env.GITHUB_FALLBACK_TOKEN;
      fake.pat = null;
    }
  });

  it('disconnects: deletes the credentials and audits', async () => {
    await connectApp();
    const { disconnectGithub, getGithubStatus } = await import('./status');
    expect((await disconnectGithub({ actorUserId: TEST_USER_ID })).deleted).toBe(true);
    expect((await getGithubStatus()).mode).toBe('none');
    const dump = await dumpIntegrationTables();
    expect(dump).toContain('integration.github.disconnected');
  });
});
