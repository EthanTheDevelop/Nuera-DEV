import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { createDb, sessions } from '@nuera/db';
import type { SessionDto } from '@nuera/shared/runner';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRunner, type Runner } from '../src/app';
import { auth, cleanup, createBareRemote, dbReady, dbUrl, git, seedProject, silentLogger, startTestRunner, testConfig, tmpDir, waitFor, type TestEnv } from './helpers';

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
 * row says « ended » while its CLI is still alive is adopted; an unknown `nuera-*` session is left
 * running (never killed).
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
    env = await startTestRunner({ sessionBackend: 'tmux', tmuxSocket: socket }, { CLAUDE_CONFIG_DIR: claudeConfig });
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

    // Runner stops (tmux sessions survive; its database client is closed), then the row is left
    // « stopped » by mistake.
    await env.runner.close();
    expect(hasSession(dto.tmuxName!)).toBe(true);
    const db = createDb(dbUrl, { max: 5, applicationName: 'nuera-runner-test' });
    await db.update(sessions).set({ status: 'stopped', endedAt: new Date(), pid: null }).where(eq(sessions.id, dto.id));

    second = await buildRunner(testConfig(env.dirs, { sessionBackend: 'tmux', tmuxSocket: socket }), { logger: silentLogger, db });
    await second.start({ listen: true });
    const res = await second.api.inject({ method: 'GET', url: `/v1/sessions/${dto.id}`, headers: auth });
    expect(res.json()).toMatchObject({ id: dto.id, live: true, status: 'waiting_input', endedAt: null });
    expect(hasSession(dto.tmuxName!)).toBe(true);
    expect(hasSession('nuera-inconnue')).toBe(true);
  });
});
