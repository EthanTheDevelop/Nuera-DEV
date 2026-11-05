import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { commandRuns } from '@nuera/db';
import type { RunDto } from '@nuera/shared/runner';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, createBareRemote, dbReady, git, seedProject, startTestRunner, waitFor, type TestEnv } from './helpers';

describe.skipIf(!dbReady)('project runs (platform shell in a PTY)', () => {
  let env: TestEnv;
  let projectId: string;
  let projectPath: string;

  const inject = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    env.runner.api.inject({ method, url, headers: { ...auth, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });

  beforeAll(async () => {
    env = await startTestRunner();
    const remote = createBareRemote(env.dirs.remotes, 'nuera-studio/runs');
    projectPath = path.join(env.dirs.projects, 'runs');
    git(env.dirs.projects, 'clone', remote.bare, projectPath);
    writeFileSync(
      path.join(projectPath, 'print-test.js'),
      [
        "console.log('  VITE ready - Local: http://localhost:4321/');",
        "console.log(' ✓ src/a.test.ts > somme 3ms');",
        "console.log(' ✓ src/a.test.ts > produit 2ms');",
        "console.log('');",
        "console.log(' Test Files  1 passed (1)');",
        "console.log('      Tests  2 passed (2)');",
        "console.log('   Duration  1.10s');",
      ].join('\n'),
    );
    writeFileSync(path.join(projectPath, 'wait.js'), "console.log('serveur prêt sur le port 5050'); setInterval(() => {}, 1000);");
    const project = await seedProject(env.db, { fullName: 'nuera-studio/runs', path: projectPath, slug: 'runs' });
    projectId = project.id;
  }, 600_000);

  afterAll(async () => {
    await env?.close();
  }, 120_000);

  it('runs a command, detects the port and reads the test results', async () => {
    const res = await inject('POST', '/v1/runs', { projectId, kind: 'custom', command: 'node print-test.js' });
    expect(res.statusCode).toBe(200);
    const run = res.json() as RunDto;
    expect(run.status).toBe('running');
    const done = await waitFor(async () => {
      const r = (await inject('GET', `/v1/runs/${run.id}`)).json() as RunDto;
      return r.status !== 'running' ? r : null;
    }, { timeoutMs: 120_000, intervalMs: 300, label: 'run end' });
    expect(done).toMatchObject({ status: 'succeeded', exitCode: 0, port: 4321, summary: '2 / 2 réussis' });
    const [row] = await env.db.select().from(commandRuns).where(eq(commandRuns.id, run.id));
    expect(row!.outputTail).toContain('Tests  2 passed (2)');
  }, 300_000);

  it('stops a long-running command', async () => {
    const res = await inject('POST', '/v1/runs', { projectId, kind: 'dev', command: 'node wait.js' });
    const run = res.json() as RunDto;
    await waitFor(async () => ((await inject('GET', `/v1/runs/${run.id}`)).json() as RunDto).port === 5050, { timeoutMs: 120_000, intervalMs: 300, label: 'port' });
    const second = await inject('POST', '/v1/runs', { projectId, kind: 'dev', command: 'node wait.js' });
    expect(second.statusCode).toBe(409);
    const stop = await inject('DELETE', `/v1/runs/${run.id}`);
    expect(stop.statusCode).toBe(200);
    const stopped = await waitFor(async () => {
      const r = (await inject('GET', `/v1/runs/${run.id}`)).json() as RunDto;
      return r.status === 'stopped' ? r : null;
    }, { timeoutMs: 60_000, intervalMs: 300, label: 'stopped' });
    expect(stopped.live).toBe(false);
  }, 300_000);

  it('refuses a run without a command', async () => {
    const res = await inject('POST', '/v1/runs', { projectId, kind: 'build' });
    expect(res.statusCode).toBe(400);
  });
});
