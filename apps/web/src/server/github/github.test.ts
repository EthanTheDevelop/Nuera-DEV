import { auditLog, githubSources, notifications, projects } from '@nuera/db/schema';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closeTestDb,
  dumpIntegrationTables,
  prepareTestDatabase,
  resetTables,
  TEST_ENVIRONMENT_ID,
  TEST_SPACE_ID,
  TEST_USER_ID,
  useTestEncryptionKey,
} from '@/server/integrations/test/db';
import { createTestAccount, type TestAccount } from '@/server/tenancy/test/fixtures';
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
  fake.requests.length = 0;
  fake.tokens.length = 0;
  fake.installations.length = 0;
  fake.repos.length = 0;
  fake.pulls.length = 0;
  fake.apps.splice(1);
  fake.appCodes.clear();
  fake.rejectJwt = false;
  fake.conversionCodes = new Set(['valid-code']);
});

const ORG = { login: 'nuera-studio', id: 1001, type: 'Organization' as const };
const USER = { login: 'ethanthedevelop', id: 2002, type: 'User' as const };
const OTHER = { login: 'camille-dev', id: 3003, type: 'User' as const };
const FULL_PERMISSIONS = { contents: 'write', pull_requests: 'write', metadata: 'read', checks: 'read', statuses: 'read', issues: 'read' };

const { db } = await import('@/server/db');

/** Manifest flow of a space up to the stored source (code: the default app, or one of `fake.appCodes`). */
async function connectApp(options: { spaceId?: string; userId?: string; code?: string } = {}) {
  const { completeManifestConversion, startManifestFlow } = await import('./manifest');
  const spaceId = options.spaceId ?? TEST_SPACE_ID;
  const userId = options.userId ?? TEST_USER_ID;
  const form = await startManifestFlow({ userId, spaceId });
  return completeManifestConversion({ code: options.code ?? 'valid-code', userId, spaceId, sourceId: form.sourceId });
}

/** A second app (own key pair) converted for a space. */
async function connectSecondApp(options: { spaceId?: string; userId?: string; appId?: number; owner?: typeof USER } = {}) {
  const appId = options.appId ?? 5151;
  fake.appCodes.set(`code-${appId}`, { appId, slug: `nuera-dev-${appId}`, name: `Nuera Dev ${appId}`, owner: options.owner ?? USER });
  return connectApp({ ...options, code: `code-${appId}` });
}

async function installOn(
  sourceId: string,
  account: typeof ORG | typeof USER | typeof OTHER,
  id: number,
  repos: string[],
  options: { stateValid?: boolean; appId?: number; spaceId?: string; userId?: string } = {},
) {
  addInstallation(
    fake,
    { id, account, permissions: FULL_PERMISSIONS, repos, ...(options.appId ? { appId: options.appId } : {}) },
    repos.map((name, index) => ({ id: id * 100 + index, name, pushedAt: new Date(Date.now() - index * 86_400_000).toISOString() })),
  );
  const { handleInstallationSetup } = await import('./manifest');
  return handleInstallationSetup({
    installationId: id,
    setupAction: 'install',
    userId: options.userId ?? TEST_USER_ID,
    spaceId: options.spaceId ?? TEST_SPACE_ID,
    sourceId,
    stateValid: options.stateValid ?? true,
  });
}

async function insertProject(values: { slug: string; githubFullName: string; spaceId?: string; environmentId?: string; githubSourceId?: string | null; githubRepoId?: number; archived?: boolean }) {
  const [row] = await db
    .insert(projects)
    .values({
      spaceId: values.spaceId ?? TEST_SPACE_ID,
      environmentId: values.environmentId ?? TEST_ENVIRONMENT_ID,
      githubSourceId: values.githubSourceId ?? null,
      slug: values.slug,
      name: `Projet ${values.slug}`,
      githubFullName: values.githubFullName,
      ...(values.githubRepoId ? { githubRepoId: values.githubRepoId } : {}),
      cloneUrl: `https://github.com/${values.githubFullName}.git`,
      path: `/srv/dev/${values.slug}`,
      status: 'ready',
      ...(values.archived ? { archivedAt: new Date() } : {}),
    })
    .returning();
  return row!;
}

async function memberOfOwnSpace(): Promise<TestAccount> {
  return createTestAccount({ role: 'member', name: 'Camille Laurent', email: 'camille@example.test', environment: { configSource: 'db', name: 'VPS-4' } });
}

describe('manifest', () => {
  it('builds a private App manifest by default, with a unique name of at most 34 characters', async () => {
    const { appNameForHost, buildAppManifest } = await import('./manifest');
    const manifest = buildAppManifest({ appUrl: 'https://dev.nuera.studio', suffix: '7f3a' });
    expect(manifest.name).toBe('Nuera Dev 7f3a · dev.nuera.studio');
    expect(manifest.name.length).toBeLessThanOrEqual(34);
    expect(manifest.redirect_url).toBe('https://dev.nuera.studio/api/integrations/github/callback');
    expect(manifest.callback_urls).toEqual(['https://dev.nuera.studio/api/integrations/github/callback']);
    expect(manifest.setup_url).toBe('https://dev.nuera.studio/api/integrations/github/setup');
    expect(manifest.hook_attributes.active).toBe(false);
    expect(manifest.public).toBe(false);
    expect(buildAppManifest({ appUrl: 'https://dev.nuera.studio', public: true }).public).toBe(true);
    expect(manifest.default_permissions).toEqual(FULL_PERMISSIONS);
    // A long host is cut, never the suffix.
    const long = appNameForHost('a-very-long-host-name.nuera.studio', 'beef');
    expect(long.length).toBeLessThanOrEqual(34);
    expect(long.startsWith('Nuera Dev beef · ')).toBe(true);
  });

  it('signs a state v2 bound to the account, its space and the source, valid one hour', async () => {
    const { createGithubState, verifyGithubState } = await import('./manifest');
    const sourceId = crypto.randomUUID();
    const { state, nonce } = createGithubState({ purpose: 'manifest', userId: TEST_USER_ID, spaceId: TEST_SPACE_ID, sourceId });
    const payload = verifyGithubState({ state, purpose: 'manifest', userId: TEST_USER_ID, cookieNonce: nonce });
    expect(payload).toMatchObject({ v: 2, nonce, spaceId: TEST_SPACE_ID, sourceId });
    // Another account cannot even decrypt it (bound to the account).
    expect(() => verifyGithubState({ state, purpose: 'manifest', userId: 'other', cookieNonce: nonce })).toThrow();
    expect(() => verifyGithubState({ state, purpose: 'manifest', userId: TEST_USER_ID, cookieNonce: 'x'.repeat(32) })).toThrow();
    expect(() => verifyGithubState({ state, purpose: 'install', userId: TEST_USER_ID, cookieNonce: nonce })).toThrow();
    expect(() => verifyGithubState({ state: `${state.slice(0, -4)}AAAA`, purpose: 'manifest', userId: TEST_USER_ID, cookieNonce: nonce })).toThrow();
    const old = createGithubState({ purpose: 'manifest', userId: TEST_USER_ID, spaceId: TEST_SPACE_ID, now: Date.now() - 61 * 60_000 });
    expect(() => verifyGithubState({ state: old.state, purpose: 'manifest', userId: TEST_USER_ID, cookieNonce: old.nonce })).toThrow(/expiré/);
  });

  it('gives each account its own state cookie', async () => {
    const { readStateCookie, stateCookie, stateCookieName } = await import('./manifest');
    expect(stateCookieName('a')).not.toBe(stateCookieName('b'));
    expect(stateCookie('n0nce', 'a')).toContain(`${stateCookieName('a')}=n0nce`);
    expect(readStateCookie(`${stateCookieName('b')}=other; ${stateCookieName('a')}=mine`, 'a')).toBe('mine');
    expect(readStateCookie(`${stateCookieName('b')}=other`, 'a')).toBeNull();
  });

  it('renders an auto-submitting form towards github.com and allocates the source id', async () => {
    const { renderManifestFormPage, startManifestFlow } = await import('./manifest');
    const form = await startManifestFlow({ userId: TEST_USER_ID, spaceId: TEST_SPACE_ID, organization: 'nuera-studio' });
    expect(form.action.startsWith('https://github.example.test/organizations/nuera-studio/settings/apps/new?state=')).toBe(true);
    expect(form.sourceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(form.manifest.public).toBe(false);
    const html = renderManifestFormPage(form);
    expect(html).toContain('method="post"');
    expect(html).toContain('&quot;redirect_url&quot;:&quot;http://localhost:3104/api/integrations/github/callback&quot;');
    expect(html).not.toContain('"redirect_url"');
    // Two flows: two different names (GitHub App names are global).
    const second = await startManifestFlow({ userId: TEST_USER_ID, spaceId: TEST_SPACE_ID });
    expect(second.manifest.name).not.toBe(form.manifest.name);
  });

  it('converts the code into a source of the space, credentials encrypted and bound to it', async () => {
    const result = await connectApp();
    expect(result.installUrl.startsWith(`https://github.example.test/apps/${fake.slug}/installations/new?state=`)).toBe(true);
    const conversion = fake.requests.find((request) => request.path === '/app-manifests/valid-code/conversions');
    expect(conversion?.method).toBe('POST');
    expect(conversion?.authorization).toBeNull();

    const [row] = await db.select().from(githubSources).where(eq(githubSources.id, result.sourceId));
    expect(row).toMatchObject({ spaceId: TEST_SPACE_ID, status: 'pending', appId: fake.appId, kind: 'app', label: 'nuera-studio', createdByUserId: TEST_USER_ID });
    expect((row!.config as { public?: boolean }).public).toBe(false);
    const { isBoundCipher } = await import('@/server/security/crypto');
    expect(isBoundCipher(row!.secretsEncrypted!)).toBe(true);
    const dump = await dumpIntegrationTables();
    expect(dump).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(dump).not.toContain('fake-client-secret');
    expect(dump).not.toContain('fake-webhook-secret');
    const [created] = await db.select().from(auditLog).where(eq(auditLog.action, 'integration.github.app_created'));
    expect(created).toMatchObject({ spaceId: TEST_SPACE_ID, targetId: result.sourceId, actorUserId: TEST_USER_ID });

    // Replayed callback (same source id) and the same app again: refused, nothing duplicated.
    const { completeManifestConversion } = await import('./manifest');
    fake.conversionCodes.add('valid-code');
    await expect(completeManifestConversion({ code: 'valid-code', userId: TEST_USER_ID, spaceId: TEST_SPACE_ID, sourceId: result.sourceId })).rejects.toThrow(/déjà enregistrée/);
    await expect(connectApp()).rejects.toThrow(/déjà enregistrée/);
    expect(await db.select().from(githubSources)).toHaveLength(1);
  });

  it('adds a second source with its own app; a name already taken on GitHub is refused', async () => {
    const first = await connectApp();
    const second = await connectSecondApp();
    expect(second.sourceId).not.toBe(first.sourceId);
    expect(second.slug).toBe('nuera-dev-5151');
    const rows = await db.select().from(githubSources).where(eq(githubSources.spaceId, TEST_SPACE_ID));
    expect(rows.map((row) => row.appId).sort()).toEqual([4242, 5151]);
    fake.appCodes.set('same-name', { appId: 6161, slug: 'nuera-dev-6161', name: 'Nuera Dev 5151' });
    await expect(connectApp({ code: 'same-name' })).rejects.toThrow(/refusé/);
  });

  it('gives each source of a space its own label (two apps of one owner), and refuses a rename to a taken one', async () => {
    const first = await connectApp();
    const second = await connectSecondApp({ owner: ORG as unknown as typeof USER });
    const { getGithubOverview, renameGithubSource } = await import('./status');
    const overview = await getGithubOverview(TEST_SPACE_ID);
    expect(overview.sources.map((item) => [item.id, item.label])).toEqual([
      [first.sourceId, 'nuera-studio'],
      [second.sourceId, 'nuera-studio 2'],
    ]);
    // Another space may use the same label.
    const b = await memberOfOwnSpace();
    await connectSecondApp({ spaceId: b.space.id, userId: b.user.id, appId: 7171, owner: ORG as unknown as typeof USER });
    expect((await getGithubOverview(b.space.id)).sources.map((item) => item.label)).toEqual(['nuera-studio']);
    await expect(renameGithubSource({ spaceId: TEST_SPACE_ID, sourceId: second.sourceId, label: 'NUERA-STUDIO', actorUserId: TEST_USER_ID })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Une autre source GitHub de votre espace porte déjà ce nom.',
    });
    await expect(renameGithubSource({ spaceId: TEST_SPACE_ID, sourceId: second.sourceId, label: 'Studio', actorUserId: TEST_USER_ID })).resolves.toMatchObject({ label: 'Studio' });
    // Renaming a source to its own label (other case) is not a conflict.
    await expect(renameGithubSource({ spaceId: TEST_SPACE_ID, sourceId: first.sourceId, label: 'Nuera-Studio', actorUserId: TEST_USER_ID })).resolves.toMatchObject({ label: 'Nuera-Studio' });
  });

  it('refuses an unknown code and a space that already has 10 sources', async () => {
    const { completeManifestConversion, startManifestFlow } = await import('./manifest');
    await expect(completeManifestConversion({ code: 'unknown-code', userId: TEST_USER_ID, spaceId: TEST_SPACE_ID })).rejects.toThrow(/refusé/);
    await db.insert(githubSources).values(
      Array.from({ length: 10 }, (_, index) => ({ spaceId: TEST_SPACE_ID, appId: 90_000 + index, label: `source ${index}`, config: {} })),
    );
    await expect(startManifestFlow({ userId: TEST_USER_ID, spaceId: TEST_SPACE_ID })).rejects.toMatchObject({ code: 'CONFLICT', reason: 'SOURCE_LIMIT' });
    await expect(connectApp()).rejects.toMatchObject({ reason: 'SOURCE_LIMIT' });
    // The limit checked under the space's lock at insert time (concurrent flows) carries the same reason.
    const { insertGithubSource } = await import('./store');
    await expect(
      insertGithubSource({
        id: crypto.randomUUID(),
        spaceId: TEST_SPACE_ID,
        createdByUserId: TEST_USER_ID,
        label: null,
        config: { mode: 'app', appId: 99_999, slug: 'x', clientId: 'x', name: 'x', htmlUrl: 'https://github.example.test/apps/x', owner: null, public: false, permissionsRequested: {}, createdAt: new Date().toISOString(), allowedAccountIds: [], installations: [], ignoredInstallations: 0, repoCount: null, consecutiveFailures: 0, failingSince: null, lastCheck: null, history: [] },
        secrets: { privateKeyPem: 'pem', clientSecret: 'secret', webhookSecret: null },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', reason: 'SOURCE_LIMIT' });
  });
});

describe('installations', () => {
  it('allow-lists an account only with a valid state, and ignores foreign installations', async () => {
    const { sourceId } = await connectApp();
    expect((await installOn(sourceId, ORG, 11, ['nuera-os', 'roux-conseil'])).outcome).toBe('installed');
    expect((await installOn(sourceId, USER, 22, ['nuera-studio'], { stateValid: false })).outcome).toBe('unknown_installation');
    expect((await installOn(sourceId, USER, 23, ['nuera-studio'])).outcome).toBe('installed');
    const { getGithubSource } = await import('./store');
    const stored = await getGithubSource({ spaceId: TEST_SPACE_ID, sourceId });
    expect(stored.config.allowedAccountIds.sort()).toEqual([1001, 2002]);
    const jwtCalls = fake.requests.filter((request) => request.path.startsWith('/app/installations/'));
    expect(jwtCalls.every((request) => /^bearer /i.test(request.authorization ?? ''))).toBe(true);
  });

  it('resolves a stateless setup redirect by asking each source of the space with its own JWT', async () => {
    const first = await connectApp();
    const second = await connectSecondApp();
    await installOn(first.sourceId, ORG, 11, ['nuera-os']);
    // The second app's installation, reported without state: found through the second app's JWT.
    addInstallation(fake, { id: 31, appId: 5151, account: USER, permissions: FULL_PERMISSIONS, repos: ['perso'] }, [{ id: 3100, name: 'perso' }]);
    const { handleInstallationSetup } = await import('./manifest');
    const update = await handleInstallationSetup({ installationId: 31, setupAction: 'update', userId: TEST_USER_ID, spaceId: TEST_SPACE_ID, sourceId: null, stateValid: false });
    // The owner of the second app is trusted from its creation: its installation is recorded.
    expect(update).toMatchObject({ outcome: 'installed', account: USER.login, sourceId: second.sourceId });
    // A state naming the FIRST source does not allow-list an account in the second one.
    addInstallation(fake, { id: 32, appId: 5151, account: OTHER, permissions: FULL_PERMISSIONS, repos: ['x'] }, [{ id: 3200, name: 'x' }]);
    const crossed = await handleInstallationSetup({ installationId: 32, setupAction: 'install', userId: TEST_USER_ID, spaceId: TEST_SPACE_ID, sourceId: first.sourceId, stateValid: true });
    expect(crossed).toMatchObject({ outcome: 'unknown_installation', sourceId: second.sourceId });
  });

  it("never resolves an installation through another space's source", async () => {
    const { sourceId } = await connectApp();
    await installOn(sourceId, ORG, 11, ['nuera-os']);
    const b = await memberOfOwnSpace();
    // B has its own app; A's installation id is unknown to B's app → unknown, nothing recorded in A.
    await connectSecondApp({ spaceId: b.space.id, userId: b.user.id, appId: 7171 });
    const { handleInstallationSetup } = await import('./manifest');
    const before = (await db.select().from(githubSources).where(eq(githubSources.id, sourceId)))[0]!.config;
    const result = await handleInstallationSetup({ installationId: 11, setupAction: 'update', userId: b.user.id, spaceId: b.space.id, sourceId: null, stateValid: true });
    expect(result).toMatchObject({ outcome: 'unknown_installation', sourceId: null });
    // Naming A's source in a state of B's space is « unknown » too.
    const named = await handleInstallationSetup({ installationId: 11, setupAction: 'update', userId: b.user.id, spaceId: b.space.id, sourceId, stateValid: true });
    expect(named.outcome).toBe('unknown_installation');
    expect((await db.select().from(githubSources).where(eq(githubSources.id, sourceId)))[0]!.config).toEqual(before);
    const { findSourceForInstallation } = await import('./installations');
    expect(await findSourceForInstallation({ spaceId: b.space.id, installationId: 11 })).toBeNull();
  });

  it('lists accessible repositories grouped by account with the « Déjà cloné » flag of the space only', async () => {
    const { sourceId } = await connectApp();
    await installOn(sourceId, ORG, 11, ['nuera-os', 'roux-conseil', 'bistrot-du-port']);
    await installOn(sourceId, USER, 23, ['nuera-studio']);
    await insertProject({ slug: 'nuera-studio', githubFullName: 'ethanthedevelop/nuera-studio', githubRepoId: 2300, githubSourceId: sourceId });
    // The same repository tracked by another space is never « Déjà cloné » here.
    const b = await memberOfOwnSpace();
    await insertProject({ slug: 'nuera-os', githubFullName: 'nuera-studio/nuera-os', githubRepoId: 1100, spaceId: b.space.id, environmentId: b.environment!.id });
    const { listAccessibleRepos } = await import('./repos');
    const result = await listAccessibleRepos({ spaceId: TEST_SPACE_ID });
    expect(result.total).toBe(4);
    expect(result.accounts.map((account) => [account.login, account.count, account.sourceId])).toEqual([
      ['nuera-studio', 3, sourceId],
      ['ethanthedevelop', 1, sourceId],
    ]);
    expect(result.repos.find((repo) => repo.fullName === 'ethanthedevelop/nuera-studio')?.clonedProject?.name).toBe('Projet nuera-studio');
    expect(result.repos.find((repo) => repo.fullName === 'nuera-studio/nuera-os')?.clonedProject).toBeNull();
    expect(result.repos[0]).toMatchObject({ sourceId, sourceLabel: 'nuera-studio', sources: [{ sourceId, sourceLabel: 'nuera-studio' }] });
    expect(result.manageAccessUrl).toBe(`https://github.example.test/apps/${fake.slug}/installations/new`);
    // Listing used metadata-only tokens.
    expect(fake.tokens.every((token) => JSON.stringify(token.permissions) === JSON.stringify({ metadata: 'read' }))).toBe(true);
    // B has no source: not connected (never A's).
    await expect(listAccessibleRepos({ spaceId: b.space.id })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(listAccessibleRepos({ spaceId: b.space.id, sourceId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('merges several sources: one entry per repository with every source, partial result when one fails', async () => {
    const first = await connectApp();
    const second = await connectSecondApp();
    await installOn(first.sourceId, ORG, 11, ['nuera-os', 'roux-conseil']);
    // The second app is installed on the same organisation (shared repository) and on the user.
    await installOn(second.sourceId, ORG, 41, ['nuera-os'], { appId: 5151 });
    await installOn(second.sourceId, USER, 42, ['perso'], { appId: 5151 });
    const { listAccessibleRepos } = await import('./repos');
    const result = await listAccessibleRepos({ spaceId: TEST_SPACE_ID });
    expect(result.total).toBe(3);
    const shared = result.repos.find((repo) => repo.fullName === 'nuera-studio/nuera-os')!;
    expect(shared.sourceId).toBe(first.sourceId);
    expect(shared.sources.map((item) => item.sourceId)).toEqual([first.sourceId, second.sourceId]);
    expect(result.sources.map((item) => item.id)).toEqual([first.sourceId, second.sourceId]);
    expect(result.manageAccessUrl).toBeNull();
    expect(result.failures).toEqual([]);

    // One source fails: the others are still listed.
    fake.apps[1]!.rejectJwt = true;
    const { clearGithubTokenCache } = await import('./tokens');
    clearGithubTokenCache();
    const partial = await listAccessibleRepos({ spaceId: TEST_SPACE_ID });
    expect(partial.repos.map((repo) => repo.fullName).sort()).toEqual(['nuera-studio/nuera-os', 'nuera-studio/roux-conseil']);
    expect(partial.failures).toMatchObject([{ sourceId: second.sourceId }]);
    // Filtered on one source.
    fake.apps[1]!.rejectJwt = false;
    const only = await listAccessibleRepos({ spaceId: TEST_SPACE_ID, sourceId: second.sourceId });
    expect(only.repos.map((repo) => repo.fullName).sort()).toEqual(['ethanthedevelop/perso', 'nuera-studio/nuera-os']);
  });

  it('follows every page of every installation (counts are per installation)', async () => {
    const { sourceId } = await connectApp();
    const names = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(3, '0')}`);
    await installOn(sourceId, ORG, 11, names('org', 150));
    await installOn(sourceId, USER, 23, names('perso', 120));
    const { listAccessibleRepos } = await import('./repos');
    const result = await listAccessibleRepos({ spaceId: TEST_SPACE_ID });
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
    const { sourceId } = await connectApp();
    await installOn(sourceId, ORG, 11, ['nuera-os', 'roux-conseil']);
    const { getGitAuthForRepo } = await import('./access');
    const ref = { spaceId: TEST_SPACE_ID, fullName: 'nuera-studio/nuera-os' };
    const write = await getGitAuthForRepo(ref, 'write');
    const issued = fake.tokens.at(-1)!;
    expect(issued.repositories).toEqual(['nuera-os']);
    expect(issued.permissions).toEqual({ metadata: 'read', contents: 'write' });
    expect(write.extraHeader).toBe(`AUTHORIZATION: basic ${Buffer.from(`x-access-token:${issued.token}`).toString('base64')}`);
    expect(write.sourceId).toBe(sourceId);
    expect(Date.parse(write.expiresAt)).toBeGreaterThan(Date.now() + 50 * 60_000);

    const count = fake.tokens.length;
    const again = await getGitAuthForRepo(ref, 'write');
    expect(again.extraHeader).toBe(write.extraHeader);
    expect(fake.tokens.length).toBe(count);

    const read = await getGitAuthForRepo(ref, 'read');
    expect(read.extraHeader).not.toBe(write.extraHeader);
    expect(fake.tokens.at(-1)?.permissions).toEqual({ metadata: 'read', contents: 'read' });

    await expect(getGitAuthForRepo({ spaceId: TEST_SPACE_ID, fullName: 'nuera-studio/unknown-repo' }, 'read')).rejects.toThrow(/n'est pas accordé/);
    await expect(getGitAuthForRepo({ spaceId: TEST_SPACE_ID, fullName: 'someone-else/repo' }, 'read')).rejects.toThrow();
  });

  it('keys the cache by app: clearing one source keeps the tokens of the others', async () => {
    const first = await connectApp();
    const second = await connectSecondApp();
    await installOn(first.sourceId, ORG, 11, ['nuera-os']);
    await installOn(second.sourceId, USER, 42, ['perso'], { appId: 5151 });
    const { getGitAuthForRepo } = await import('./access');
    const { clearGithubTokenCache, tokenCacheKey } = await import('./tokens');
    expect(tokenCacheKey({ appId: 1, installationId: 2, repositoryNames: ['B', 'a'], permissions: { metadata: 'read' } })).toBe('1|2|a,b|metadata:read');
    await getGitAuthForRepo({ spaceId: TEST_SPACE_ID, fullName: 'nuera-studio/nuera-os' }, 'read');
    await getGitAuthForRepo({ spaceId: TEST_SPACE_ID, fullName: 'ethanthedevelop/perso' }, 'read');
    expect(fake.tokens.map((token) => token.appId)).toEqual([4242, 5151]);
    clearGithubTokenCache({ appId: 5151 });
    await getGitAuthForRepo({ spaceId: TEST_SPACE_ID, fullName: 'nuera-studio/nuera-os' }, 'read');
    await getGitAuthForRepo({ spaceId: TEST_SPACE_ID, fullName: 'ethanthedevelop/perso' }, 'read');
    // Only the second app minted again.
    expect(fake.tokens.map((token) => token.appId)).toEqual([4242, 5151, 5151]);
  });

  it("serves a project only from its own source, binds a project without source, never another space's", async () => {
    const first = await connectApp();
    const second = await connectSecondApp();
    await installOn(first.sourceId, ORG, 11, ['nuera-os']);
    await installOn(second.sourceId, ORG, 41, ['nuera-os'], { appId: 5151 });
    const { getGitAuthForProject } = await import('./access');
    const bound = await insertProject({ slug: 'bound', githubFullName: 'nuera-studio/nuera-os', githubSourceId: second.sourceId });
    const auth = await getGitAuthForProject(bound, 'read');
    expect(auth.sourceId).toBe(second.sourceId);
    expect(fake.tokens.at(-1)?.appId).toBe(5151);

    // Lazy binding: resolved in the space (first source), then recorded on the project.
    const legacy = await insertProject({ slug: 'legacy', githubFullName: 'nuera-studio/nuera-os', githubSourceId: null, archived: true });
    expect((await getGitAuthForProject(legacy, 'read')).sourceId).toBe(first.sourceId);
    const [after] = await db.select().from(projects).where(eq(projects.id, legacy.id));
    expect(after).toMatchObject({ githubSourceId: first.sourceId, githubInstallationId: 11 });

    // A project of space B with a source id of A (forged ref): unknown source, no token.
    const b = await memberOfOwnSpace();
    const count = fake.tokens.length;
    await expect(
      getGitAuthForProject({ id: crypto.randomUUID(), spaceId: b.space.id, githubSourceId: first.sourceId, githubFullName: 'nuera-studio/nuera-os' }, 'read'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(getGitAuthForProject({ id: crypto.randomUUID(), spaceId: b.space.id, githubSourceId: null, githubFullName: 'nuera-studio/nuera-os' }, 'read')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(fake.tokens.length).toBe(count);
  });

  it('resolves the source to bind at project creation (the chosen one, checked in the space)', async () => {
    const first = await connectApp();
    const second = await connectSecondApp();
    await installOn(first.sourceId, ORG, 11, ['nuera-os']);
    await installOn(second.sourceId, USER, 42, ['perso'], { appId: 5151 });
    const { resolveSourceForRepo } = await import('./access');
    expect(await resolveSourceForRepo({ spaceId: TEST_SPACE_ID, fullName: 'ethanthedevelop/perso' })).toEqual({
      mode: 'app',
      sourceId: second.sourceId,
      sourceLabel: 'ethanthedevelop',
      installationId: 42,
    });
    await expect(resolveSourceForRepo({ spaceId: TEST_SPACE_ID, sourceId: first.sourceId, fullName: 'ethanthedevelop/perso' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(resolveSourceForRepo({ spaceId: TEST_SPACE_ID, fullName: 'inconnu/depot' })).rejects.toThrow(/aucune source GitHub de votre espace/);
  });

  it('keeps GITHUB_FALLBACK_TOKEN for the space of the default server only', async () => {
    process.env.GITHUB_FALLBACK_TOKEN = 'github_pat_fallbacktoken0123456789';
    try {
      const { getGitAuthForRepo, getGithubMode } = await import('./access');
      const own = await getGitAuthForRepo({ spaceId: TEST_SPACE_ID, fullName: 'nuera-studio/nuera-os' }, 'read');
      expect(own).toMatchObject({ sourceId: null });
      const b = await memberOfOwnSpace();
      expect(await getGithubMode(TEST_SPACE_ID)).toBe('fallback_token');
      expect(await getGithubMode(b.space.id)).toBe('none');
      await expect(getGitAuthForRepo({ spaceId: b.space.id, fullName: 'nuera-studio/nuera-os' }, 'read')).rejects.toMatchObject({ code: 'CONFLICT' });
    } finally {
      delete process.env.GITHUB_FALLBACK_TOKEN;
    }
  });

  it('sends X-GitHub-Api-Version: 2026-03-10 on every REST call', async () => {
    const { sourceId } = await connectApp();
    await installOn(sourceId, ORG, 11, ['nuera-os']);
    const { getRepo } = await import('./repos');
    await getRepo({ spaceId: TEST_SPACE_ID, fullName: 'nuera-studio/nuera-os' });
    expect(fake.requests.length).toBeGreaterThan(2);
    expect(fake.requests.every((request) => request.apiVersion === '2026-03-10')).toBe(true);
  });
});

describe('protected branches', () => {
  it('adds the default branch, caches a minute per space, reads again for a push and falls back on failure', async () => {
    const { listProtectedBranches } = await import('./repos');
    let calls = 0;
    const listImpl = async () => {
      calls += 1;
      return [
        { name: 'main', sha: 'a', protected: true },
        { name: 'release', sha: 'b', protected: true },
        { name: 'feature/x', sha: 'c', protected: false },
      ];
    };
    const repo = { spaceId: TEST_SPACE_ID, fullName: `nuera-studio/protected-${Date.now()}` };
    expect(await listProtectedBranches(repo, 'main', { listImpl })).toEqual(['main', 'release']);
    expect(await listProtectedBranches({ ...repo, defaultBranch: 'main' }, { listImpl })).toEqual(['main', 'release']);
    expect(calls).toBe(1);
    expect(await listProtectedBranches(repo, 'main', { listImpl, maxAgeMs: 0 })).toEqual(['main', 'release']);
    expect(calls).toBe(2);
    // Another space never reads this space's answer.
    await listProtectedBranches({ ...repo, spaceId: crypto.randomUUID() }, 'main', { listImpl });
    expect(calls).toBe(3);
    const failing = async () => {
      throw new Error('GitHub injoignable');
    };
    // Known list kept when GitHub fails; an unknown repository falls back to its default branch.
    expect(await listProtectedBranches(repo, 'main', { listImpl: failing, maxAgeMs: 0 })).toEqual(['main', 'release']);
    expect(await listProtectedBranches({ ...repo, fullName: `${repo.fullName}-autre` }, 'develop', { listImpl: failing })).toEqual(['develop']);
  });
});

describe('pull requests', () => {
  it("creates a project's pull request with a pull_requests:write token of its source and reads it with its checks", async () => {
    const { sourceId } = await connectApp();
    await installOn(sourceId, ORG, 11, ['nuera-os']);
    const project = await insertProject({ slug: 'nuera-os', githubFullName: 'nuera-studio/nuera-os', githubSourceId: sourceId });
    const { createPullRequest, getPullRequest } = await import('./pulls');
    const pull = await createPullRequest(project, { title: 'crm : colonnes glissables', head: 'feature/crm-core', base: 'main' });
    expect(pull).toMatchObject({ number: 57, state: 'open', headRef: 'feature/crm-core', baseRef: 'main', url: 'https://github.com/nuera-studio/nuera-os/pull/57' });
    const token = fake.tokens.at(-1)!;
    expect(token.permissions).toEqual({ metadata: 'read', pull_requests: 'write' });
    expect(token.repositories).toEqual(['nuera-os']);

    await expect(createPullRequest(project, { title: 'bis', head: 'feature/crm-core', base: 'main' })).rejects.toMatchObject({ code: 'CONFLICT' });

    fake.checkRuns.push({ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'test', status: 'in_progress', conclusion: null });
    fake.reviews.push({ user: 'nezar', state: 'APPROVED', submittedAt: new Date().toISOString() });
    const detail = await getPullRequest(project, 57);
    expect(detail.checks.state).toBe('pending');
    expect(detail.reviews.state).toBe('approved');
    fake.checkRuns[1] = { name: 'test', status: 'completed', conclusion: 'failure' };
    expect((await getPullRequest(project, 57)).checks.state).toBe('failure');
    fake.checkRuns.length = 0;
    fake.reviews.length = 0;
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
  it('reports connected with accounts, repository count and permissions (single source = the aggregate)', async () => {
    const { sourceId } = await connectApp();
    await installOn(sourceId, ORG, 11, ['nuera-os', 'roux-conseil']);
    await installOn(sourceId, USER, 23, ['nuera-studio']);
    const { checkGithub } = await import('./status');
    const status = await checkGithub({ spaceId: TEST_SPACE_ID, trigger: 'schedule' });
    expect(status.mode).toBe('app');
    expect(status.status).toBe('connected');
    expect(status.sourceId).toBe(sourceId);
    expect(status.repoCount).toBe(3);
    expect(status.accounts.map((account) => account.login).sort()).toEqual(['ethanthedevelop', 'nuera-studio']);
    expect(status.permissions.title).toBe('Contenu · pull requests');
    expect(status.permissions.detail).toBe('lecture et écriture ; issues, checks et statuts en lecture');
    expect(status.lastCheck?.steps.map((step) => step.name)).toContain('GET /app');
    expect(status.installUrl).toBe(`/api/integrations/github/install?source=${sourceId}`);
    expect(status.sources).toHaveLength(1);
    expect(status.sourceCount).toBe(1);
    expect(status.canAddSource).toBe(true);
    expect(JSON.stringify(status)).not.toMatch(/ghs_|PRIVATE KEY|fake-client-secret/);
  });

  it('moves a source to « expiré » when GitHub refuses its key, notifies the members of its space only, once', async () => {
    const { sourceId } = await connectApp();
    await installOn(sourceId, ORG, 11, ['nuera-os']);
    const b = await memberOfOwnSpace();
    const { checkGithub } = await import('./status');
    expect((await checkGithub({ spaceId: TEST_SPACE_ID, trigger: 'schedule' })).status).toBe('connected');
    fake.rejectJwt = true;
    const status = await checkGithub({ spaceId: TEST_SPACE_ID, trigger: 'schedule' });
    expect(status.status).toBe('expired');
    expect(status.reason).toMatch(/clé privée/);
    await checkGithub({ spaceId: TEST_SPACE_ID, trigger: 'schedule' });
    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: TEST_USER_ID,
      spaceId: TEST_SPACE_ID,
      kind: 'integration_expired',
      severity: 'danger',
      title: "L'accès GitHub a été retiré",
      dedupKey: `integration:github:${sourceId}:expired`,
      href: '/integrations',
    });
    expect(rows.some((row) => row.userId === b.user.id)).toBe(false);
    expect(rows[0]?.body).toContain('Synchronisation, push et pull requests suspendus. Le travail local continue.');

    fake.rejectJwt = false;
    expect((await checkGithub({ spaceId: TEST_SPACE_ID, trigger: 'schedule' })).status).toBe('connected');
    const after = await db.select().from(notifications);
    expect(after[0]?.readAt).not.toBeNull();
  });

  it('aggregates several sources (worst status, « 1 source sur 2 à réautoriser ») and names the source', async () => {
    const first = await connectApp();
    const second = await connectSecondApp();
    await installOn(first.sourceId, ORG, 11, ['nuera-os']);
    await installOn(second.sourceId, USER, 42, ['perso', 'notes'], { appId: 5151 });
    const { checkGithub, checkGithubSource, getGithubOverview } = await import('./status');
    await checkGithub({ spaceId: TEST_SPACE_ID, trigger: 'schedule' });
    fake.apps[1]!.rejectJwt = true;
    await checkGithubSource({ spaceId: TEST_SPACE_ID, sourceId: second.sourceId, trigger: 'schedule' });
    const overview = await getGithubOverview(TEST_SPACE_ID);
    expect(overview.status).toBe('expired');
    expect(overview.reason).toBe('1 source sur 2 à réautoriser');
    expect(overview.app).toBeNull();
    expect(overview.repoCount).toBe(3);
    expect(overview.failingSourceCount).toBe(1);
    expect(overview.sources.map((source) => [source.label, source.status])).toEqual([
      ['nuera-studio', 'connected'],
      ['ethanthedevelop', 'expired'],
    ]);
    const [row] = await db.select().from(notifications);
    expect(row).toMatchObject({ title: "L'accès GitHub · ethanthedevelop a été retiré", href: `/integrations?source=${second.sourceId}`, dedupKey: `integration:github:${second.sourceId}:expired` });
    // Unknown and foreign source ids answer the same NOT_FOUND.
    const b = await memberOfOwnSpace();
    await expect(checkGithubSource({ spaceId: b.space.id, sourceId: first.sourceId })).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Source GitHub introuvable.' });
    await expect(checkGithubSource({ spaceId: TEST_SPACE_ID, sourceId: crypto.randomUUID() })).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Source GitHub introuvable.' });
  });

  it('limits manual checks to one every 10 s per source', async () => {
    const { sourceId } = await connectApp();
    await installOn(sourceId, ORG, 11, ['nuera-os']);
    const { checkGithubSource } = await import('./status');
    await checkGithubSource({ spaceId: TEST_SPACE_ID, sourceId, trigger: 'manual', actorUserId: TEST_USER_ID });
    const count = fake.requests.length;
    await checkGithubSource({ spaceId: TEST_SPACE_ID, sourceId, trigger: 'manual', actorUserId: TEST_USER_ID });
    expect(fake.requests.length).toBe(count);
    const [checked] = await db.select().from(auditLog).where(eq(auditLog.action, 'integration.github.checked'));
    expect(checked).toMatchObject({ spaceId: TEST_SPACE_ID, targetId: sourceId });
  });

  it('uses the documented fallback PAT for the space of the default server only', async () => {
    fake.pat = { token: 'github_pat_fallbacktoken0123456789', login: 'ethanthedevelop', expiration: '2026-11-07 10:00:00 UTC' };
    process.env.GITHUB_FALLBACK_TOKEN = fake.pat.token;
    try {
      const { checkGithub, getGithubOverview } = await import('./status');
      const status = await checkGithub({ spaceId: TEST_SPACE_ID, trigger: 'schedule' });
      expect(status.mode).toBe('fallback_token');
      expect(status.expiresAt).toBe('2026-11-07T10:00:00.000Z');
      expect(JSON.stringify(status)).not.toContain('github_pat_');
      const b = await memberOfOwnSpace();
      expect((await getGithubOverview(b.space.id)).mode).toBe('none');
    } finally {
      delete process.env.GITHUB_FALLBACK_TOKEN;
      fake.pat = null;
    }
  });

  it('refuses to disconnect a source used by an active project, then deletes it and audits', async () => {
    const first = await connectApp();
    const second = await connectSecondApp();
    await installOn(second.sourceId, USER, 42, ['perso'], { appId: 5151 });
    const project = await insertProject({ slug: 'perso', githubFullName: 'ethanthedevelop/perso', githubSourceId: second.sourceId });
    const { disconnectGithub, disconnectGithubSource, getGithubOverview } = await import('./status');
    await expect(disconnectGithubSource({ spaceId: TEST_SPACE_ID, sourceId: second.sourceId, actorUserId: TEST_USER_ID })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Cette source GitHub est utilisée par 1 projet actif : Projet perso.',
      data: { projects: [{ id: project.id, name: 'Projet perso' }] },
    });
    // The historical route cannot choose among several sources.
    await expect(disconnectGithub({ spaceId: TEST_SPACE_ID, actorUserId: TEST_USER_ID })).rejects.toThrow(/Plusieurs sources GitHub/);
    // Another space cannot disconnect it (unknown).
    const b = await memberOfOwnSpace();
    await expect(disconnectGithubSource({ spaceId: b.space.id, sourceId: first.sourceId, actorUserId: b.user.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, project.id));
    expect((await disconnectGithubSource({ spaceId: TEST_SPACE_ID, sourceId: second.sourceId, actorUserId: TEST_USER_ID })).deleted).toBe(true);
    const [archived] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(archived?.githubSourceId).toBeNull();
    const overview = await getGithubOverview(TEST_SPACE_ID);
    expect(overview.sources.map((source) => source.id)).toEqual([first.sourceId]);
    const [audited] = await db.select().from(auditLog).where(and(eq(auditLog.action, 'integration.github.disconnected'), eq(auditLog.targetId, second.sourceId)));
    expect(audited).toMatchObject({ spaceId: TEST_SPACE_ID, actorUserId: TEST_USER_ID });
    // With one source left, the historical route disconnects it.
    expect((await disconnectGithub({ spaceId: TEST_SPACE_ID, actorUserId: TEST_USER_ID })).deleted).toBe(true);
    expect((await getGithubOverview(TEST_SPACE_ID)).mode).toBe('none');
  });
});
