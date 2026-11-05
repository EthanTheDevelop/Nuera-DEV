import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { projects, sessions, worktrees } from '@nuera/db';
import type { ChangesResponse, WorktreeDto } from '@nuera/shared/runner';
import type { RunnerEvent } from '@nuera/shared/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, createBareRemote, dbReady, git, seedProject, startTestRunner, type TestEnv } from './helpers';

/**
 * Disk footprint (worktree sizes, clone removal), bounded change counts and the web-side status
 * announcement — real Git repositories, real folders.
 */
describe.skipIf(!dbReady)('maintenance: sizes, clone removal, bounded changes, announce', () => {
  let env: TestEnv;
  let projectId: string;
  let primary: string;
  let worktreeId: string;

  const inject = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    env.runner.api.inject({ method, url, headers: { ...auth, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
  const listWorktrees = async (sizes: boolean) => ((await inject('GET', `/v1/repos/${projectId}/worktrees${sizes ? '?sizes=1' : ''}`)).json() as { worktrees: WorktreeDto[] }).worktrees;

  beforeAll(async () => {
    env = await startTestRunner();
    const remote = createBareRemote(env.dirs.remotes, 'nuera-studio/disk', { 'data/blob.txt': 'x'.repeat(256 * 1024) });
    primary = path.join(env.dirs.projects, 'disk');
    git(env.dirs.projects, 'clone', remote.bare, primary);
    const project = await seedProject(env.db, { fullName: 'nuera-studio/disk', path: primary, slug: 'disk' });
    projectId = project.id;
    const created = await inject('POST', `/v1/repos/${projectId}/worktrees`, { branch: 'feature/disk' });
    if (created.statusCode !== 200) throw new Error(`worktree: ${created.statusCode} ${created.body}`);
    worktreeId = (created.json() as WorktreeDto).id;
  }, 600_000);

  afterAll(async () => {
    await env?.close();
  }, 600_000);

  it('measures worktree folders only when asked, like du', async () => {
    const plain = await listWorktrees(false);
    expect(plain.every((w) => w.sizeBytes === undefined)).toBe(true);
    const sized = await listWorktrees(true);
    const main = sized.find((w) => w.isPrimary)!;
    const feature = sized.find((w) => w.id === worktreeId)!;
    // The primary clone holds the 256 Kio file twice (working tree + .git objects, compressed or not).
    expect(main.sizeBytes).toBeGreaterThan(256 * 1024);
    expect(feature.sizeBytes).toBeGreaterThan(256 * 1024);
  });

  it('counts untracked lines within a budget, and says when it did not', async () => {
    const wt = (await listWorktrees(false)).find((w) => w.id === worktreeId)!;
    mkdirSync(path.join(wt.path, 'gen'), { recursive: true });
    for (let i = 0; i < 6; i += 1) writeFileSync(path.join(wt.path, 'gen', `f${i}.txt`), 'a\nb\n');
    env.runner.services.git.untrackedBudget = { files: 2, bytes: 1024 * 1024, ms: 10_000 };
    try {
      const res = await inject('GET', `/v1/worktrees/${worktreeId}/changes`);
      expect(res.statusCode).toBe(200);
      const changes = res.json() as ChangesResponse;
      const gen = changes.files.filter((f) => f.path.startsWith('gen/'));
      expect(gen).toHaveLength(6);
      expect(gen.filter((f) => f.linesCounted === undefined && f.insertions === 2)).toHaveLength(2);
      expect(gen.filter((f) => f.linesCounted === false && f.insertions === 0)).toHaveLength(4);
    } finally {
      env.runner.services.git.untrackedBudget = { files: 400, bytes: 16 * 1024 * 1024, ms: 2_500 };
    }
  });

  it('refuses to delete the clone while work exists only on the server, touching nothing', async () => {
    // Untracked files in the worktree (previous test): refused.
    const dirty = await inject('DELETE', `/v1/repos/${projectId}/clone`);
    expect(dirty.statusCode).toBe(409);
    expect(dirty.json()).toMatchObject({ error: { reason: 'CLONE_DIRTY', untouched: "Rien n'a été supprimé du disque." } });
    const wt = (await listWorktrees(false)).find((w) => w.id === worktreeId)!;
    // A local commit pushed nowhere: refused too.
    git(wt.path, 'add', '-A');
    git(wt.path, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-m', 'local only');
    const unpushed = await inject('DELETE', `/v1/repos/${projectId}/clone`);
    expect(unpushed.statusCode).toBe(409);
    expect(unpushed.json()).toMatchObject({ error: { reason: 'CLONE_UNPUSHED' } });
    expect(existsSync(primary)).toBe(true);
    expect(existsSync(wt.path)).toBe(true);
    // Once pushed, nothing is lost by deleting the copies.
    git(wt.path, 'push', 'origin', 'feature/disk');
  });

  it('deletes the clone and its worktrees, marks them removed and reports the freed space', async () => {
    const wt = (await listWorktrees(false)).find((w) => w.id === worktreeId)!;
    const res = await inject('DELETE', `/v1/repos/${projectId}/clone`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { removed: boolean; freedBytes: number | null; worktrees: number; operationId: string };
    expect(body).toMatchObject({ removed: true, worktrees: 1 });
    expect(body.freedBytes).toBeGreaterThan(512 * 1024);
    expect(existsSync(primary)).toBe(false);
    expect(existsSync(wt.path)).toBe(false);
    expect(existsSync(env.dirs.projects)).toBe(true);
    const rows = await env.db.select().from(worktrees).where(eq(worktrees.projectId, projectId));
    expect(rows.every((r) => r.status === 'removed' && r.removedAt)).toBe(true);
    const [project] = await env.db.select().from(projects).where(eq(projects.id, projectId));
    expect(project).toMatchObject({ status: 'error', statusDetail: 'Clone supprimé du serveur.' });
  });

  it('re-publishes session.status (with the title) after a web-side rename or archive', async () => {
    const [other] = await env.db.select().from(projects).where(eq(projects.id, projectId));
    const id = randomUUID();
    await env.db.insert(sessions).values({ id, projectId: other!.id, title: 'Avant', status: 'stopped', backend: 'pty' });
    await env.db.update(sessions).set({ title: 'Après', status: 'archived', archivedAt: new Date() }).where(eq(sessions.id, id));
    const seen: RunnerEvent[] = [];
    const off = env.runner.services.bus.subscribe('global', (e) => {
      if (e.type === 'session.status') seen.push(e);
    });
    const res = await inject('POST', `/v1/sessions/${id}/announce`);
    off();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, title: 'Après', status: 'archived' });
    expect(seen.map((e) => e.data)).toEqual([expect.objectContaining({ sessionId: id, title: 'Après', status: 'archived', live: false })]);
    const missing = await inject('POST', `/v1/sessions/${randomUUID()}/announce`);
    expect(missing.statusCode).toBe(404);
  });
});
