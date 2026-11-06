/**
 * TEST-ONLY — unit tests of the e2e harness (no stack, no database): ports and layout of N servers,
 * state v1 → v2, netstat parsing, command line, portable paths, legacy secret format, and the
 * multi-app fake GitHub (binding by owner, unique names, JWT routed by issuer, PR numbers per repo).
 */
import { createDecipheriv, createSign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findString } from '../admin';
import { formatEnv, parseArgs, pagePath } from '../cli';
import { accountFiles, accountIdentity, allPorts, layoutFor, portsFor, runnerName, runnerPathsFor, runnerPortsFor, stackKeys, validatePorts, webEnv } from '../config';
import { encryptLegacySecret } from '../db';
import { buildBareRepo, fixtureGithubApps, fixtureRepoStates, type FixtureRepoSpec } from '../fixture-repos';
import { parseManifestForm, sourcesOf } from '../github-connect';
import { jwtIssuer, nextPullNumber, pickAppToBind, startFakeGithubFront, type FakeGithubFront } from '../github-front';
import { parseNetstatListening } from '../proc';
import { accountOf, patchSeeded, reposOfApp, runnerComponent, runnerKeyOf, seededOf, upgradeState, type StackState } from '../state';
import { normalizePath, samePath } from '../../fixtures/paths';

describe('ports et dossiers de N serveurs', () => {
  it('suit la convention : web N, runner A N+1000, hooks A N+1001, GitHub N+1002, runner B N+1010', () => {
    const ports = portsFor(3102, {}, 2);
    expect(ports).toEqual({ web: 3102, runner: 4102, hook: 4103, github: 4104 });
    expect(runnerPortsFor(ports, 'a')).toEqual({ runner: 4102, hook: 4103 });
    expect(runnerPortsFor(ports, 'b')).toEqual({ runner: 4112, hook: 4113 });
    expect(runnerPortsFor(ports, 'c')).toEqual({ runner: 4122, hook: 4123 });
    expect(allPorts(ports, 2)).toEqual([3102, 4104, 4102, 4103, 4112, 4113]);
    expect(runnerPortsFor(portsFor(3900, {}, 2), 'b')).toEqual({ runner: 4910, hook: 4911 });
  });

  it('refuse les ports de pnpm dev et les doublons, runner B compris', () => {
    expect(() => validatePorts({ web: 3000, runner: 4000, hook: 4001, github: 4002 })).toThrow(/réservé/);
    // Runner B of web 3090 would be 4100 (pnpm dev).
    expect(() => portsFor(3090, {}, 2)).toThrow(/4100/);
    expect(() => portsFor(3200, { github: 4210 }, 2)).toThrow(/double/);
  });

  it('donne à chaque serveur ses propres dossiers, le serveur par défaut gardant ceux de la version 1', () => {
    const layout = layoutFor('essai');
    expect(runnerPathsFor(layout.dir, 'a')).toMatchObject({ projects: layout.projects, runnerData: layout.runnerData, claudeConfig: layout.claudeConfig });
    const b = runnerPathsFor(layout.dir, 'b');
    expect(b.projects).toBe(path.join(layout.dir, 'runner-b', 'projects'));
    expect(b.claudeConfig).toBe(path.join(layout.dir, 'runner-b', 'home', '.claude'));
    expect(accountFiles(layout, 'a')).toEqual({ stateFile: layout.ownerFile, storageState: layout.storageState });
    expect(accountFiles(layout, 'b').stateFile).toBe(path.join(layout.dir, 'accounts', 'b.json'));
  });

  it('nomme les comptes et les serveurs', () => {
    expect(accountIdentity('e2e', 'a')).toMatchObject({ name: 'Camille Laurent', email: 'camille.laurent@e2e.nuera.test', role: 'owner' });
    expect(accountIdentity('e2e', 'b')).toMatchObject({ name: 'Hugo Martin', email: 'hugo.martin@e2e.nuera.test', role: 'member', gitIdentity: { name: 'Hugo Martin', email: 'hugo.martin@e2e.nuera.test' } });
    expect([runnerName('a'), runnerName('b')]).toEqual(['VPS-3', 'VPS-4']);
    expect(stackKeys(2)).toEqual(['a', 'b']);
    expect(() => stackKeys(0)).toThrow();
    expect(runnerComponent('a')).toBe('runner');
    expect(runnerComponent('b')).toBe('runner-b');
    expect(runnerKeyOf('runner-b')).toBe('b');
  });

  it("ne transmet pas au web les réglages Nuera du shell parent et coupe l'horloge web", () => {
    const previous = { id: process.env.NUERA_ENVIRONMENT_ID, twofa: process.env.NUERA_REQUIRE_2FA };
    process.env.NUERA_ENVIRONMENT_ID = 'parent';
    process.env.NUERA_REQUIRE_2FA = 'false';
    try {
      const layout = layoutFor('essai');
      const env = webEnv({
        name: 'essai',
        ports: portsFor(3301),
        urls: { web: 'http://localhost:3301', runner: 'http://127.0.0.1:4301', hook: 'http://127.0.0.1:4302', githubApi: 'x', githubWeb: 'y' },
        databaseUrl: 'postgres://x/y',
        secrets: { runnerToken: 't', betterAuthSecret: 's', appEncryptionKey: 'k', setupToken: 'j', vapidPublicKey: 'p', vapidPrivateKey: 'q' },
        layout,
        scheduler: false,
        ownerEmail: 'a@b.c',
      });
      expect(env.NUERA_ENVIRONMENT_ID).toBeUndefined();
      expect(env.NUERA_REQUIRE_2FA).toBeUndefined();
      expect(env.NUERA_WEB_SCHEDULER).toBe('off');
      expect(env.RUNNER_TOKEN).toBe('t');
    } finally {
      if (previous.id === undefined) delete process.env.NUERA_ENVIRONMENT_ID;
      else process.env.NUERA_ENVIRONMENT_ID = previous.id;
      if (previous.twofa === undefined) delete process.env.NUERA_REQUIRE_2FA;
      else process.env.NUERA_REQUIRE_2FA = previous.twofa;
    }
  });
});

describe('state.json version 2', () => {
  const layout = layoutFor('ancienne');
  const v1 = {
    version: 1 as const,
    name: 'ancienne',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    dir: layout.dir,
    ports: portsFor(3951),
    urls: { web: 'http://localhost:3951', runner: 'http://127.0.0.1:4951', hook: 'http://127.0.0.1:4952', githubApi: 'http://127.0.0.1:4953/api/v3', githubWeb: 'http://127.0.0.1:4953' },
    database: { name: 'nuera_ancienne', url: 'postgres://x/nuera_ancienne', adminUrl: 'postgres://x/postgres' },
    secrets: { runnerToken: 'jeton-a', betterAuthSecret: 's', appEncryptionKey: 'k', setupToken: 'j', vapidPublicKey: 'p', vapidPrivateKey: 'q' },
    owner: { name: 'Camille Laurent', email: 'camille.laurent@ancienne.nuera.test', password: 'x', totpSecret: 'ABC', userId: 'u1', created: true },
    options: { web: true, scheduler: false, pristine: false },
    paths: { ...layout, accounts: undefined as unknown as string },
    processes: {},
    github: { appId: 903951, slug: 'nuera-dev-ancienne', accounts: [{ login: 'atelier-test', id: 5101, type: 'Organization' as const, installationId: 71001 }], connected: true },
    repos: [{ fullName: 'atelier-test/devis-express', owner: 'atelier-test', name: 'devis-express', id: 1, installationId: 71001, defaultBranch: 'main', branches: ['main'], private: true, language: null, description: '', bare: 'x', displayName: 'Devis', failingTests: false }],
    seeded: { projects: { devis: { key: 'devis', id: 'p1', slug: 'devis', name: 'Devis', fullName: 'atelier-test/devis-express', path: 'x', defaultBranch: 'main', worktreeId: 'w1', operationId: 'o1' } } },
  };

  it('lit une pile de la version 1 comme le compte et le serveur « a »', () => {
    const state = upgradeState(v1 as unknown as Parameters<typeof upgradeState>[0]);
    expect(state.version).toBe(2);
    expect(state.accountCount).toBe(1);
    expect(accountOf(state, 'a')).toMatchObject({ email: v1.owner.email, userId: 'u1', created: true, runner: 'a', createdVia: 'configuration' });
    expect(state.runners[0]).toMatchObject({ key: 'a', component: 'runner', name: 'VPS-3', isDefault: true, token: 'jeton-a', ports: { runner: 4951, hook: 4952 } });
    expect(state.githubApps[0]).toMatchObject({ key: 'a', appId: 903951, installations: [{ account: 'atelier-test', installationId: 71001 }] });
    expect(state.repos[0]!.installations).toEqual({ a: 71001 });
    expect(state.paths.accounts).toBe(path.join(layout.dir, 'accounts'));
    expect(seededOf(state, 'a').projects?.devis?.id).toBe('p1');
  });

  it('range les données de chaque compte à part', () => {
    const state = upgradeState(v1 as unknown as Parameters<typeof upgradeState>[0]);
    state.accounts.push({ ...state.accounts[0]!, key: 'b', email: 'hugo@x', seeded: {} });
    patchSeeded(state, 'b', (data) => {
      data.notifications = { ids: ['n1'], at: 'now' };
    });
    expect(seededOf(state, 'b').notifications?.ids).toEqual(['n1']);
    expect(state.seeded.notifications).toBeUndefined();
  });
});

describe('dépôts et applications GitHub de test', () => {
  it("déclare trois applications aux installations distinctes et calcule ce que chacune atteint", () => {
    const apps = fixtureGithubApps('e2e', 3102, ['a', 'b']);
    expect(apps.map((app) => [app.key, app.owner.login, app.account])).toEqual([
      ['a', 'atelier-test', 'a'],
      ['a2', 'atelier-test', null],
      ['b', 'hugo-test', 'b'],
    ]);
    expect(new Set(apps.map((app) => app.appId)).size).toBe(3);
    const repos = fixtureRepoStates('remotes', apps);
    const state = { allRepos: repos } as Pick<StackState, 'allRepos'>;
    expect(reposOfApp(state, 'a').map((repo) => repo.fullName)).toContain('dev-test/outils-cli');
    expect(reposOfApp(state, 'a').map((repo) => repo.fullName)).not.toContain('hugo-test/carnet-chantier');
    expect(reposOfApp(state, 'b').map((repo) => repo.fullName)).toEqual(expect.arrayContaining(['hugo-test/carnet-chantier', 'atelier-test/devis-express']));
    expect(reposOfApp(state, 'b').map((repo) => repo.fullName).filter((name) => name.startsWith('dev-test/'))).toEqual([]);
    expect(repos.find((repo) => repo.fullName === 'atelier-test/site-vitrine')!.installations).toEqual({ a: 71001, a2: 71101, b: 72001 });
  });
});

describe('outils du processus et de la ligne de commande', () => {
  it('lit netstat en anglais, en allemand et en IPv6, sans les connexions établies', () => {
    const output = [
      '  TCP    0.0.0.0:3102           0.0.0.0:0              LISTENING       101',
      '  TCP    127.0.0.1:4112         0.0.0.0:0              ABHÖREN         202',
      '  TCP    [::]:4104              [::]:0                 LISTENING       303',
      '  TCP    127.0.0.1:50000        127.0.0.1:3102         ESTABLISHED     404',
    ].join('\r\n');
    const parsed = parseNetstatListening(output);
    expect([...parsed.entries()].map(([port, pids]) => [port, [...pids]])).toEqual([
      [3102, [101]],
      [4112, [202]],
      [4104, [303]],
    ]);
  });

  it('comprend les chemins de Git Bash, les arguments passés à Playwright et les syntaxes de shell', () => {
    expect(pagePath('C:/Program Files/Git/projets')).toBe('/projets');
    expect(pagePath('projets')).toBe('/projets');
    expect(parseArgs(['e2e', '--name', 'w6', '--accounts', '2', '--', 'isolation.spec.ts', '--project', 'desktop'])).toMatchObject({
      command: 'e2e',
      rest: ['isolation.spec.ts', '--project', 'desktop'],
    });
    expect(formatEnv({ E2E_STACK: 'w6', E2E_X: "l'a" }, 'powershell')).toBe("$env:E2E_STACK = 'w6'\n$env:E2E_X = 'l''a'");
    expect(formatEnv({ E2E_STACK: 'w6' }, 'cmd')).toBe('set "E2E_STACK=w6"');
    expect(formatEnv({ E2E_STACK: 'w6' }, 'posix')).toBe('E2E_STACK=w6');
  });

  it('compare des chemins Windows et POSIX sans dépendre des séparateurs ni de la casse', () => {
    expect(samePath('P:\\-Nuera-DEV\\.data\\stacks\\e2e\\projects\\.worktrees\\x', 'P:/-Nuera-DEV/.data/stacks/e2e/projects/.worktrees/x', 'win32')).toBe(true);
    expect(samePath('p:/a/B', 'P:\\a\\b\\', 'win32')).toBe(true);
    expect(samePath('/srv/dev/a', '/srv/dev/A', 'linux')).toBe(false);
    expect(normalizePath('/srv/dev/a/', 'linux')).toBe('/srv/dev/a');
  });

  it('écrit un secret au format historique que le web déchiffre encore (v1, AAD = identifiant de clé)', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const cipher = encryptLegacySecret('nrt_secret', key);
    const [keyId, rest] = cipher.split(':') as [string, string];
    const [iv, tag, data] = rest.split('.').map((part) => Buffer.from(part, 'base64url')) as [Buffer, Buffer, Buffer];
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(keyId));
    decipher.setAuthTag(tag);
    expect(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')).toBe('nrt_secret');
  });

  it("retrouve les champs utiles dans les réponses de l'administration et de GitHub", () => {
    expect(findString({ server: { id: '0b0b0b0b-1111-4222-8333-444444444444', token: 'nrt_x'.padEnd(40, 'x') } }, ['id'], (text) => /^[0-9a-f-]{36}$/.test(text))).toBe('0b0b0b0b-1111-4222-8333-444444444444');
    expect(parseManifestForm('<form action="http://g/settings/apps/new?state=s&amp;x=1"><input name="manifest" value="{&quot;name&quot;:&quot;Nuera&quot;}"></form>')).toEqual({ action: 'http://g/settings/apps/new?state=s&x=1', manifest: '{"name":"Nuera"}' });
    expect(sourcesOf({ mode: 'app', status: 'connected', app: { slug: 's' }, accounts: [{ login: 'atelier-test' }], repoCount: 4 })).toEqual([{ id: null, slug: 's', status: 'connected', accounts: ['atelier-test'], repoCount: 4 }]);
    expect(sourcesOf({ sources: [{ id: 'x', status: 'expired', app: { slug: 'b' }, accounts: ['hugo-test'] }] })[0]).toMatchObject({ id: 'x', slug: 'b', accounts: ['hugo-test'] });
  });
});

describe('faux GitHub à plusieurs applications', () => {
  let front: FakeGithubFront;
  let dir: string;
  const apps = fixtureGithubApps('essai', 3990, ['a', 'b']);

  function jwt(appId: number, pem: string): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iat: now - 30, exp: now + 540, iss: appId })).toString('base64url');
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`);
    return `Bearer ${header}.${payload}.${signer.sign(pem).toString('base64url')}`;
  }

  async function postManifest(route: string, name: string, extra: Record<string, unknown> = {}) {
    const manifest = JSON.stringify({ name, redirect_url: 'http://localhost:3990/api/integrations/github/callback', setup_url: 'http://localhost:3990/api/integrations/github/setup', public: true, ...extra });
    return fetch(`${front.url}${route}?state=etat`, { method: 'POST', body: new URLSearchParams({ manifest }), redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  }

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'nuera-harness-'));
    const spec: FixtureRepoSpec = {
      owner: 'atelier-test',
      name: 'devis-express',
      id: 610_001,
      displayName: 'Devis',
      description: '',
      private: true,
      language: 'JavaScript',
      failingTests: false,
      history: [{ message: 'chore: init', daysAgo: 1, author: 'camille', files: { 'README.md': '# Devis\n' } }],
      branches: [{ name: 'feature/a', commits: [{ message: 'feat: a', daysAgo: 0.5, author: 'camille', files: { 'a.txt': 'a\n' } }] }, { name: 'feature/b', commits: [{ message: 'feat: b', daysAgo: 0.4, author: 'hugo', files: { 'b.txt': 'b\n' } }] }],
    };
    buildBareRepo(spec, path.join(dir, 'remotes'), path.join(dir, 'tmp'));
    const repos = fixtureRepoStates(path.join(dir, 'remotes'), apps).filter((repo) => repo.fullName === 'atelier-test/devis-express');
    front = await startFakeGithubFront({
      port: 0,
      apps: apps.map(({ key, appId, slug, owner, installations }) => ({ key, appId, slug, owner, installations })),
      appUrl: 'http://localhost:3990',
      accounts: [
        { login: 'atelier-test', id: 5101, type: 'Organization' },
        { login: 'dev-test', id: 5202, type: 'User' },
        { login: 'hugo-test', id: 5303, type: 'User' },
      ],
      repos,
      stateDir: path.join(dir, 'github'),
    });
  }, 120_000);

  afterAll(async () => {
    await front?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('choisit une application selon le propriétaire du manifest ou celle demandée', () => {
    const bound = new Set<string>(['a']);
    const configs = apps.map(({ key, appId, slug, owner, installations }) => ({ key, appId, slug, owner, installations }));
    expect(pickAppToBind(configs, (key) => bound.has(key), { organization: 'atelier-test' }, null)?.key).toBe('a2');
    expect(pickAppToBind(configs, (key) => bound.has(key), { organization: null }, null)?.key).toBe('b');
    expect(pickAppToBind(configs, () => false, { organization: 'atelier-test' }, 'b')?.key).toBe('b');
    expect(nextPullNumber([])).toBe(57);
    expect(nextPullNumber([57, 60])).toBe(61);
    expect(jwtIssuer('Bearer x.eyJpc3MiOjQyfQ.y')).toBe('42');
    expect(jwtIssuer('token ghs_x')).toBeNull();
  });

  it('lie une application par manifest, refuse un nom déjà pris ou trop long, et route les JWT par émetteur', async () => {
    const first = await postManifest('/organizations/atelier-test/settings/apps/new', 'Nuera Dev · essai');
    expect(first.status).toBe(302);
    const code = new URL(first.headers.get('location')!).searchParams.get('code')!;
    const taken = await postManifest('/settings/apps/new', 'nuera dev · ESSAI');
    expect(taken.status).toBe(422);
    expect(await taken.text()).toContain('déjà utilisé par une autre application GitHub');
    const long = await postManifest('/settings/apps/new', 'N'.repeat(35));
    expect(long.status).toBe(422);

    const conversion = await fetch(`${front.apiUrl}/app-manifests/${code}/conversions`, { method: 'POST' });
    expect(conversion.status).toBe(201);
    const converted = (await conversion.json()) as { id: number; slug: string; pem: string; name: string };
    expect(converted).toMatchObject({ id: apps[0]!.appId, slug: apps[0]!.slug, name: 'Nuera Dev · essai' });
    expect(converted.pem).toBe(readFileSync(path.join(dir, 'github', 'app-key.pem'), 'utf8'));

    // Personal route → app b (owner hugo-test, a user account).
    const personal = await postManifest('/settings/apps/new', 'Nuera Dev · Hugo');
    const codeB = new URL(personal.headers.get('location')!).searchParams.get('code')!;
    const convertedB = (await (await fetch(`${front.apiUrl}/app-manifests/${codeB}/conversions`, { method: 'POST' })).json()) as { id: number; pem: string };
    expect(convertedB.id).toBe(apps[2]!.appId);

    // Each JWT reaches its own app (installations of that app only).
    const installationsA = (await (await fetch(`${front.apiUrl}/app/installations`, { headers: { authorization: jwt(converted.id, converted.pem) } })).json()) as Array<{ id: number }>;
    const installationsB = (await (await fetch(`${front.apiUrl}/app/installations`, { headers: { authorization: jwt(convertedB.id, convertedB.pem) } })).json()) as Array<{ id: number }>;
    expect(installationsA.map((item) => item.id).sort()).toEqual([71001, 71002]);
    expect(installationsB.map((item) => item.id).sort()).toEqual([72001, 72003]);
    // A JWT signed with app b's key but claiming app a is refused.
    expect((await fetch(`${front.apiUrl}/app/installations`, { headers: { authorization: jwt(converted.id, convertedB.pem) } })).status).toBe(401);
  });

  it('numérote les pull requests par dépôt, toutes applications confondues, et refuse une branche déjà proposée', async () => {
    const key = (app: string) => readFileSync(path.join(dir, 'github', app === 'a' ? 'app-key.pem' : `app-key-${app}.pem`), 'utf8');
    const token = async (appIndex: number, installationId: number) => {
      const app = apps[appIndex]!;
      const response = await fetch(`${front.apiUrl}/app/installations/${installationId}/access_tokens`, { method: 'POST', headers: { authorization: jwt(app.appId, key(app.key)), 'content-type': 'application/json' }, body: '{}' });
      expect(response.status).toBe(201);
      return ((await response.json()) as { token: string }).token;
    };
    const tokenA = await token(0, 71001);
    const tokenB = await token(2, 72001);
    const open = (tokenValue: string, head: string) =>
      fetch(`${front.apiUrl}/repos/atelier-test/devis-express/pulls`, { method: 'POST', headers: { authorization: `token ${tokenValue}`, 'content-type': 'application/json' }, body: JSON.stringify({ title: head, head, base: 'main' }) });
    const first = (await (await open(tokenA, 'feature/a')).json()) as { number: number };
    const second = (await (await open(tokenB, 'feature/b')).json()) as { number: number };
    expect(second.number).toBe(first.number + 1);
    expect((await open(tokenB, 'feature/a')).status).toBe(422);
    const state = (await (await fetch(`${front.url}/__harness/state`)).json()) as { pulls: Array<{ head: string; app: string; number: number }> };
    expect(state.pulls.map((pull) => [pull.head, pull.app])).toEqual([
      ['feature/a', 'a'],
      ['feature/b', 'b'],
    ]);
  });
});
