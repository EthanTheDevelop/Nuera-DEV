import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { createDb, sessions } from '@nuera/db';
import type { SessionDto } from '@nuera/shared/runner';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRunner, type Runner } from '../src/app';
import { auth, cleanup, createBareRemote, dbReady, dbUrl, defaultServer, git, seedProject, seedServer, silentLogger, startTestRunner, testConfig, tmpDir, waitFor, type TestEnv } from './helpers';

function tmuxAvailable(): boolean {
  if (process.platform === 'win32') return false;
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Runner restart with the tmux backend (own socket per run, never the `nuera` one): a session whose
 * row says « ended » while its CLI is still alive is adopted; an unknown `nuera-*` session, one whose
 * row belongs to ANOTHER server, or one started for another row under a live row's name, is left
 * running (never killed, never attached).
 */
describe.skipIf(!dbReady || !tmuxAvailable())('tmux orphans at runner start-up', () => {
  const socket = `nuera-test-${process.pid}-${Date.now().toString(36)}`;
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const hasSession = (name: string) => {
    try {
      tmux('has-session', '-t', `=${name}`);
      return true;
    } catch {
      return false;
    }
  };
  let env: TestEnv;
  let second: Runner | null = null;
  let projectId: string;

  beforeAll(async () => {
    const claudeConfig = tmpDir('claude-config');
    mkdirSync(path.join(claudeConfig, 'projects'), { recursive: true });
    env = await startTestRunner({ sessionBackend: 'tmux', tmuxSocket: socket, claudeConfigDir: claudeConfig });
    const remote = createBareRemote(env.dirs.remotes, 'nuera-studio/orphans');
    const target = path.join(env.dirs.projects, 'orphans');
    git(env.dirs.projects, 'clone', remote.bare, target);
    projectId = (await seedProject(env.db, { fullName: 'nuera-studio/orphans', path: target, slug: 'orphans' })).id;
  }, 600_000);

  afterAll(async () => {
    await second?.close().catch(() => undefined);
    await env?.runner.close().catch(() => undefined);
    try {
      tmux('kill-server');
    } catch {
      // already gone
    }
    if (env) cleanup(env.root);
  }, 600_000);

  it('adopts a live CLI whose row was left ended, and leaves an unknown session alone', async () => {
    const created = await env.runner.api.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: JSON.stringify({ projectId, title: 'Orpheline', worktree: { mode: 'new', branch: 'feature/orpheline' }, start: true }),
    });
    expect(created.statusCode).toBe(200);
    const dto = created.json() as SessionDto;
    expect(dto).toMatchObject({ backend: 'tmux', live: true });
    expect(dto.tmuxName).toMatch(/^nuera-orphans-orpheline/);
    await waitFor(() => hasSession(dto.tmuxName!), { label: 'tmux session' });
    tmux('new-session', '-d', '-s', 'nuera-inconnue', '--', 'sleep', '600');
    // A tmux session of the same name pattern whose row belongs to another server.
    const other = await seedServer(env.db, { token: `tmux-autre-serveur-${Date.now()}-abcdef`, name: 'Serveur voisin' });
    const otherProject = await seedProject(env.db, { fullName: 'nuera-studio/voisin', path: path.join(env.dirs.projects, 'voisin'), slug: 'voisin', server: other });
    const [foreign] = await env.db
      .insert(sessions)
      .values({ id: randomUUID(), projectId: otherProject.id, environmentId: other.environmentId, title: 'Voisine', status: 'stopped', backend: 'tmux', tmuxName: 'nuera-voisin-main', hookTokenHash: 'a'.repeat(64) })
      .returning();
    tmux('new-session', '-d', '-s', 'nuera-voisin-main', '--', 'sleep', '600');
    // A live row of THIS server whose tmux name is now held by a session started for another row
    // (its NUERA_SESSION_ID is not the row's id): never re-attached, the row is interrupted.
    const own = await defaultServer(env.db);
    const [usurped] = await env.db
      .insert(sessions)
      .values({ id: randomUUID(), projectId, environmentId: own.environmentId, worktreeId: dto.worktreeId, title: 'Usurpée', status: 'running', backend: 'tmux', tmuxName: 'nuera-usurpee', hookTokenHash: 'b'.repeat(64) })
      .returning();
    tmux('new-session', '-d', '-s', 'nuera-usurpee', '-e', `NUERA_SESSION_ID=${foreign!.id}`, '--', 'sleep', '600');

    // Runner stops (tmux sessions survive; its database client is closed), then the row is left
    // « stopped » by mistake.
    await env.runner.close();
    expect(hasSession(dto.tmuxName!)).toBe(true);
    const db = createDb(dbUrl, { max: 5, applicationName: 'nuera-runner-test' });
    await db.update(sessions).set({ status: 'stopped', endedAt: new Date(), pid: null }).where(eq(sessions.id, dto.id));

    second = await buildRunner(testConfig(env.dirs, { sessionBackend: 'tmux', tmuxSocket: socket, claudeConfigDir: env.runner.services.config.claudeConfigDir }), { logger: silentLogger, db });
    await second.start({ listen: true });
    const res = await second.api.inject({ method: 'GET', url: `/v1/sessions/${dto.id}`, headers: auth });
    expect(res.json()).toMatchObject({ id: dto.id, live: true, status: 'waiting_input', endedAt: null });
    expect(hasSession(dto.tmuxName!)).toBe(true);
    expect(hasSession('nuera-inconnue')).toBe(true);
    expect(hasSession('nuera-voisin-main')).toBe(true);
    const [untouched] = await db.select().from(sessions).where(eq(sessions.id, foreign!.id));
    expect(untouched).toMatchObject({ status: 'stopped', pid: null });
    expect(second.services.sessions.isLive(foreign!.id)).toBe(false);
    expect(hasSession('nuera-usurpee')).toBe(true);
    expect(second.services.sessions.isLive(usurped!.id)).toBe(false);
    const [interrupted] = await db.select().from(sessions).where(eq(sessions.id, usurped!.id));
    expect(interrupted).toMatchObject({ status: 'interrupted', pid: null });
  });
});
