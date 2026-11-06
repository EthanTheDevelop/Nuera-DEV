import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { createDb, environmentSpaces, projects } from '@nuera/db';
import { seedMember } from '@nuera/db/test';
import { parseRunnerEvent, type RunnerEvent } from '@nuera/shared/events';
import type { SessionDto, TerminalDto } from '@nuera/shared/runner';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeAccounts, PRIMARY_MARKER } from '../src/claude/accounts';
import { cleanup, createBareRemote, dbReady, dbUrl, silentLogger, git, seedProject, seedServer, startTestRunner, tmpDir, waitFor, type TestEnv, type TestServer } from './helpers';

/**
 * Shared server (lot P1): one runner works for two accounts, each with ITS OWN Claude Code config
 * folder. The first account keeps the existing folder (pointed to, never moved nor read); the second
 * gets `<root>/<space id>/` (0700). Every `claude` process — status, login terminal, session — runs
 * with the folder of the account it works for; a missing account is refused on a shared server.
 */
describe.skipIf(!dbReady)('shared server: one Claude Code connection per account', () => {
  const TOKEN_S = `test-runner-token-partage-${Date.now().toString(36)}`;
  const CREDENTIALS = '{"claudeAiOauth":{"accessToken":"ne-jamais-lire"}}';
  let env: TestEnv;
  let legacy: string;
  let first: TestServer;
  let second: { userId: string; spaceId: string };
  let secondFolder: string;

  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    env.runner.api.inject({
      method,
      url,
      headers: { ...env.auth, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });

  beforeAll(async () => {
    legacy = tmpDir('claude-premier');
    // The existing login of the server (fake CLI state + a credentials file nobody may read).
    writeFileSync(path.join(legacy, 'nuera-fake-claude.json'), JSON.stringify({ loggedIn: true, email: 'premier@example.test' }));
    writeFileSync(path.join(legacy, '.credentials.json'), CREDENTIALS, { mode: 0o600 });
    const db = createDb(dbUrl, { max: 5, applicationName: 'nuera-runner-test-partage' });
    first = await seedServer(db, { token: TOKEN_S, name: 'Serveur partagé' });
    env = await startTestRunner({ token: TOKEN_S, claudeConfigDir: legacy }, { db });
    const guest = await seedMember(env.db, { email: `invite-${Date.now().toString(36)}@example.test`, name: 'Hugo Invité', environment: false });
    second = { userId: guest.userId, spaceId: guest.spaceId };
    await env.db.insert(environmentSpaces).values({ environmentId: first.environmentId, spaceId: second.spaceId });
    secondFolder = path.join(`${legacy}-comptes`, second.spaceId);
  }, 600_000);

  afterAll(async () => {
    await env?.close().catch(() => undefined);
    cleanup(legacy);
    cleanup(`${legacy}-comptes`);
  }, 600_000);

  it("donne à chaque compte son propre statut Claude, et refuse une requête sans compte sur un serveur partagé", async () => {
    const own = (await call('GET', `/v1/claude/status?refresh=1&spaceId=${first.spaceId}`)).json() as { state: string; spaceId: string; auth: { email: string | null } };
    expect(own).toMatchObject({ state: 'connected', spaceId: first.spaceId, auth: { email: 'premier@example.test' } });
    const guest = (await call('GET', `/v1/claude/status?refresh=1&spaceId=${second.spaceId}`)).json() as { state: string; spaceId: string };
    expect(guest).toMatchObject({ state: 'disconnected', spaceId: second.spaceId });
    // Its own folder, private to the runner's user.
    expect(statSync(secondFolder).isDirectory()).toBe(true);
    expect(statSync(secondFolder).mode & (process.platform === 'win32' ? 0 : 0o777)).toBe(process.platform === 'win32' ? 0 : 0o700);
    const missing = await call('GET', '/v1/claude/status?refresh=1');
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: { reason: 'CLAUDE_ACCOUNT_REQUIRED' } });
    const stranger = await call('GET', '/v1/claude/status?spaceId=00000000-0000-4000-8000-000000000000');
    expect(stranger.statusCode).toBe(404);
    // The first account kept the existing folder: pointed to, never moved nor read.
    expect(readFileSync(path.join(legacy, '.credentials.json'), 'utf8')).toBe(CREDENTIALS);
    expect(JSON.parse(readFileSync(path.join(env.dirs.data, PRIMARY_MARKER), 'utf8'))).toMatchObject({ spaceId: first.spaceId, environmentId: first.environmentId });
  });

  it('ouvre le terminal de connexion du compte invité dans SON dossier : la connexion du premier compte reste intacte', async () => {
    const res = await call('POST', '/v1/terminals', { kind: 'claude-login', actorUserId: second.userId, spaceId: second.spaceId });
    expect(res.statusCode).toBe(200);
    const dto = res.json() as TerminalDto;
    expect(dto).toMatchObject({ kind: 'claude-login', spaceId: second.spaceId, ownerUserId: second.userId, private: true });
    env.runner.services.terminals.get(dto.id).write('code-du-compte-invite\r');
    await waitFor(() => existsSync(path.join(secondFolder, 'nuera-fake-claude.json')), { timeoutMs: 60_000, label: 'connexion du compte invité' });
    const guest = (await call('GET', `/v1/claude/status?refresh=1&spaceId=${second.spaceId}`)).json() as { state: string };
    expect(guest.state).toBe('connected');
    expect(JSON.parse(readFileSync(path.join(legacy, 'nuera-fake-claude.json'), 'utf8'))).toMatchObject({ email: 'premier@example.test' });
    // A login terminal without account is refused on a shared server.
    const anonymous = await call('POST', '/v1/terminals', { kind: 'claude-status', actorUserId: second.userId });
    expect(anonymous.statusCode).toBe(400);
  }, 120_000);

  it("lance la session d'un projet du compte invité avec le dossier Claude de CE compte", async () => {
    const remote = createBareRemote(env.dirs.remotes, 'nuera-studio/partage');
    const check = (await call('POST', '/v1/repos/check-destination', { path: 'partage', fullName: 'nuera-studio/partage', spaceId: second.spaceId })).json() as {
      path: string;
      available: boolean;
    };
    // Its own folder of the projects root: two accounts can clone the same repository.
    expect(check.path).toBe(path.join(env.dirs.projects, 'espaces', second.spaceId, 'partage'));
    const outside = await call('POST', '/v1/repos/check-destination', { path: path.join(env.dirs.projects, 'ailleurs'), spaceId: second.spaceId });
    expect(outside.statusCode).toBe(400);
    const reserved = await call('POST', '/v1/repos/check-destination', { path: `espaces/${second.spaceId}/x`, spaceId: first.spaceId });
    expect(reserved.statusCode).toBe(400);

    git(env.dirs.projects, 'clone', remote.bare, check.path);
    const project = await seedProject(env.db, { fullName: 'nuera-studio/partage', path: check.path, slug: `partage-${Date.now().toString(36)}`, server: { ...first, spaceId: second.spaceId, userId: second.userId } });
    const created = (await call('POST', '/v1/sessions', { projectId: project.id, title: 'Session invitée', worktree: { mode: 'primary' } })).json() as SessionDto;
    expect((await call('POST', `/v1/sessions/${created.id}/instruction`, { text: 'Bonjour' })).statusCode).toBe(200);
    const envFile = path.join(secondFolder, 'nuera-fake-env', `${created.id}.json`);
    await waitFor(() => existsSync(envFile), { timeoutMs: 120_000, label: 'environnement de la session' });
    expect(JSON.parse(readFileSync(envFile, 'utf8'))).toMatchObject({ CLAUDE_CONFIG_DIR: secondFolder });
    expect(existsSync(path.join(legacy, 'nuera-fake-env', `${created.id}.json`))).toBe(false);
    // Claude's own file tools may not open the first account's folder (cheap same-uid mitigation).
    const settings = JSON.parse(readFileSync(path.join(env.dirs.data, 'sessions', created.id, 'settings.json'), 'utf8')) as { permissions?: { deny?: string[] } };
    expect(settings.permissions?.deny).toEqual(expect.arrayContaining([`Read(/${legacy}/**)`, `Edit(/${legacy}/**)`]));
    expect((settings.permissions?.deny ?? []).some((rule) => rule.includes(secondFolder))).toBe(false);
    const launch = JSON.parse(readFileSync(path.join(env.dirs.data, 'sessions', created.id, 'launch.json'), 'utf8')) as { denyRules: string[] };
    expect(launch.denyRules.some((rule) => rule.includes(legacy))).toBe(false);
    await call('POST', `/v1/sessions/${created.id}/stop`, { force: true });
  }, 300_000);

  it('ne relaie à un compte que son propre statut Claude sur le flux global', async () => {
    const received: RunnerEvent[] = [];
    const abort = new AbortController();
    const stream = await fetch(`${env.apiUrl}/v1/events?spaceId=${second.spaceId}`, { headers: env.auth, signal: abort.signal });
    const pump = (async () => {
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let i: number;
          while ((i = buffer.indexOf('\n\n')) !== -1) {
            const data = buffer.slice(0, i).split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
            buffer = buffer.slice(i + 2);
            const e = data ? parseRunnerEvent(data) : null;
            if (e) received.push(e);
          }
        }
      } catch {
        // aborted
      }
    })();
    await call('GET', `/v1/claude/status?refresh=1&spaceId=${first.spaceId}`);
    await call('GET', `/v1/claude/status?refresh=1&spaceId=${second.spaceId}`);
    await waitFor(() => received.filter((e) => e.type === 'claude.status').length >= 2, { timeoutMs: 30_000, label: 'statuts du compte invité' });
    abort.abort();
    await pump;
    const statuses = received.filter((e): e is Extract<RunnerEvent, { type: 'claude.status' }> => e.type === 'claude.status');
    expect(statuses.every((e) => e.data.spaceId === second.spaceId)).toBe(true);
  }, 60_000);

  it("reconnaît le premier compte d'après la base, même quand la ligne gardée en mémoire est encore celle d'avant l'attribution", async () => {
    const data = tmpDir('comptes-donnees');
    try {
      const accounts = new ClaudeAccounts({
        db: env.db,
        // The cached row right after the first assignment: space_id not seen yet.
        environment: { id: first.environmentId, current: null },
        legacyDir: legacy,
        accountsRoot: path.join(data, 'racine'),
        dataDir: data,
        logger: silentLogger,
      });
      const account = await accounts.forSpace(first.spaceId);
      expect(account).toMatchObject({ primary: true, configDir: legacy });
      expect(existsSync(path.join(data, 'racine', first.spaceId))).toBe(false);
    } finally {
      cleanup(data);
    }
  });

  it("efface le dossier Claude d'un compte retiré du serveur, jamais celui d'un compte encore présent", async () => {
    const refused = await call('POST', `/v1/claude/accounts/${second.spaceId}/forget`, {});
    expect(refused.statusCode).toBe(409);
    expect(existsSync(secondFolder)).toBe(true);
    // The web removes the account (its projects deleted first), then asks the runner.
    await env.db.delete(projects).where(eq(projects.spaceId, second.spaceId));
    await env.db.delete(environmentSpaces).where(and(eq(environmentSpaces.environmentId, first.environmentId), eq(environmentSpaces.spaceId, second.spaceId)));
    const forgotten = await call('POST', `/v1/claude/accounts/${second.spaceId}/forget`, {});
    expect(forgotten.statusCode).toBe(200);
    expect(forgotten.json()).toMatchObject({ removed: true });
    expect(existsSync(secondFolder)).toBe(false);
    // The first account's folder is never removed.
    const primary = await call('POST', `/v1/claude/accounts/${first.spaceId}/forget`, {});
    expect(primary.statusCode).toBe(409);
    expect(readFileSync(path.join(legacy, '.credentials.json'), 'utf8')).toBe(CREDENTIALS);
  }, 120_000);
});
