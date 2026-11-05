import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { projects, worktrees } from '@nuera/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, createBareRemote, dbReady, git, seedProject, startTestRunner, waitFor, type TestEnv } from './helpers';

const HEADER = 'AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46dGVzdA==';
const author = { name: 'Nuera Test', email: 'owner@example.com' };

describe.skipIf(!dbReady)('git module (local bare remote as origin)', () => {
  let env: TestEnv;
  let projectId: string;
  let primaryWorktreeId: string;
  let featureWorktreeId: string;
  let seedWork: string;

  const inject = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    env.runner.api.inject({ method, url, headers: { ...auth, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });

  beforeAll(async () => {
    env = await startTestRunner();
    const remote = createBareRemote(env.dirs.remotes, 'nuera-studio/demo', { 'package.json': JSON.stringify({ name: 'demo', scripts: { dev: 'vite', test: 'vitest run' } }) });
    seedWork = remote.work;
    const project = await seedProject(env.db, { fullName: 'nuera-studio/demo', path: path.join(env.dirs.projects, 'demo'), status: 'cloning', slug: 'demo' });
    projectId = project.id;
  }, 600_000);

  afterAll(async () => {
    await env?.close();
  }, 600_000);

  it('clones with progress, steps and journal (A2/A3)', async () => {
    const res = await inject('POST', '/v1/repos/clone', { projectId, fullName: 'nuera-studio/demo', destination: 'demo', installDeps: false });
    expect(res.statusCode).toBe(200);
    const { operationId } = res.json() as { operationId: string };
    const op = await waitFor(
      async () => {
        const r = await inject('GET', `/v1/operations/${operationId}`);
        const body = r.json() as { status: string };
        return body.status !== 'running' ? (body as { status: string; steps: Array<{ key: string; status: string; detail?: string }>; log: string; progress: number; result: Record<string, unknown> }) : null;
      },
      { timeoutMs: 120_000, label: 'clone' },
    );
    expect(op.status).toBe('succeeded');
    expect(op.progress).toBe(100);
    expect(op.steps.map((s) => [s.key, s.status])).toEqual([
      ['clone', 'done'],
      ['install', 'skipped'],
      ['inspect', 'done'],
    ]);
    expect(op.log).toContain('$ git clone https://github.com/nuera-studio/demo.git');
    expect(op.result).toMatchObject({ branch: 'main', claudeMd: { found: true, location: 'racine', lines: 4 }, scripts: ['dev', 'test'] });
    const [row] = await env.db.select().from(projects).where(eq(projects.id, projectId));
    expect(row!.status).toBe('ready');
    expect(row!.currentBranch).toBe('main');
    expect((row!.commands as Record<string, string>).dev).toBe('npm run dev');
    primaryWorktreeId = (op.result as { worktreeId: string }).worktreeId;
    // The remote URL never carries a token.
    expect(git(row!.path, 'config', '--get', 'remote.origin.url')).not.toContain('@');
  }, 600_000);

  it('reports a non-empty destination with a suggestion (A4)', async () => {
    const res = await inject('POST', '/v1/repos/check-destination', { path: 'demo', fullName: 'nuera-studio/demo' });
    expect(res.statusCode).toBe(200);
    const check = res.json() as { available: boolean; fileCount: number; existingClone: { sameRepository: boolean; branch: string }; suggestedPath: string };
    expect(check.available).toBe(false);
    expect(check.fileCount).toBeGreaterThan(0);
    expect(check.existingClone).toMatchObject({ sameRepository: true, branch: 'main' });
    expect(check.suggestedPath).toMatch(/demo-/);
    const escape = await inject('POST', '/v1/repos/check-destination', { path: '../outside' });
    expect(escape.statusCode).toBe(400);
  });

  it('creates a worktree for a new branch from main', async () => {
    const res = await inject('POST', `/v1/repos/${projectId}/worktrees`, { branch: 'feature/crm-core' });
    expect(res.statusCode).toBe(200);
    const wt = res.json() as { id: string; name: string; branch: string; path: string; baseBranch: string };
    expect(wt).toMatchObject({ name: 'crm-core', branch: 'feature/crm-core', baseBranch: 'main' });
    expect(wt.path.replace(/\\/g, '/')).toMatch(/\.worktrees\/demo\/crm-core$/);
    featureWorktreeId = wt.id;
    const dup = await inject('POST', `/v1/repos/${projectId}/worktrees`, { branch: 'feature/crm-core' });
    expect(dup.statusCode).toBe(409);
    const list = await inject('GET', `/v1/repos/${projectId}/worktrees`);
    expect((list.json() as { worktrees: Array<{ id: string }> }).worktrees.map((w) => w.id)).toEqual(expect.arrayContaining([primaryWorktreeId, featureWorktreeId]));
  }, 600_000);

  it('lists changes with M/A letters and +/− counts, and a structured diff', async () => {
    const [wt] = await env.db.select().from(worktrees).where(eq(worktrees.id, featureWorktreeId));
    writeFileSync(path.join(wt!.path, 'src', 'index.ts'), 'export const answer = 43;\nexport const extra = true;\n');
    writeFileSync(path.join(wt!.path, 'src', 'new.ts'), 'a\nb\nc\n');
    const res = await inject('GET', `/v1/worktrees/${featureWorktreeId}/changes`);
    expect(res.statusCode).toBe(200);
    const changes = res.json() as { files: Array<{ path: string; status: string; insertions: number; deletions: number }>; totals: { files: number; insertions: number; deletions: number } };
    expect(changes.files).toEqual([
      expect.objectContaining({ path: 'src/index.ts', status: 'M', insertions: 2, deletions: 1 }),
      expect.objectContaining({ path: 'src/new.ts', status: 'A', insertions: 3, deletions: 0 }),
    ]);
    expect(changes.totals).toEqual({ files: 2, insertions: 5, deletions: 1 });
    const diff = await inject('GET', `/v1/worktrees/${featureWorktreeId}/diff?path=src/index.ts`);
    const parsed = diff.json() as { hunks: Array<{ lines: Array<{ type: string; oldNumber: number | null; newNumber: number | null; text: string }> }>; status: string };
    expect(parsed.status).toBe('M');
    expect(parsed.hunks[0]!.lines).toEqual([
      { type: 'del', oldNumber: 1, newNumber: null, text: 'export const answer = 42;' },
      { type: 'add', oldNumber: null, newNumber: 1, text: 'export const answer = 43;' },
      { type: 'add', oldNumber: null, newNumber: 2, text: 'export const extra = true;' },
    ]);
    const untracked = await inject('GET', `/v1/worktrees/${featureWorktreeId}/diff?path=src/new.ts`);
    expect((untracked.json() as { insertions: number }).insertions).toBe(3);
    const traversal = await inject('GET', `/v1/worktrees/${featureWorktreeId}/diff?path=../../etc/passwd`);
    expect(traversal.statusCode).toBe(400);
  }, 600_000);

  it('reads the file tree lazily, hiding .git and flagging ignored files', async () => {
    const [wt] = await env.db.select().from(worktrees).where(eq(worktrees.id, featureWorktreeId));
    writeFileSync(path.join(wt!.path, '.gitignore'), 'dist/\n*.log\n');
    writeFileSync(path.join(wt!.path, 'debug.log'), 'x');
    const res = await inject('GET', `/v1/worktrees/${featureWorktreeId}/tree?path=`);
    const tree = res.json() as { entries: Array<{ name: string; kind: string; ignored: boolean; lines: number | null }> };
    const names = tree.entries.map((e) => e.name);
    expect(names).not.toContain('.git');
    expect(tree.entries.find((e) => e.name === 'src')?.kind).toBe('dir');
    expect(tree.entries.find((e) => e.name === 'debug.log')?.ignored).toBe(true);
    expect(tree.entries.find((e) => e.name === 'CLAUDE.md')?.lines).toBe(4);
    const file = await inject('GET', `/v1/worktrees/${featureWorktreeId}/file?path=src/index.ts`);
    expect(file.json()).toMatchObject({ binary: false, language: 'typescript', lines: 2 });
    const gitDir = await inject('GET', `/v1/worktrees/${featureWorktreeId}/file?path=.git/config`);
    expect(gitDir.statusCode).toBeGreaterThanOrEqual(400);
  }, 600_000);

  it('commits only the given paths, then pushes the branch', async () => {
    const res = await inject('POST', `/v1/worktrees/${featureWorktreeId}/commit`, { message: 'crm : ajoute le tableau', body: '- détail', author, paths: ['src/index.ts', 'src/new.ts'] });
    expect(res.statusCode).toBe(200);
    const commit = res.json() as { sha: string; filesCommitted: number; insertions: number; deletions: number };
    expect(commit.filesCommitted).toBe(2);
    expect(commit.insertions).toBe(5);
    const [wt] = await env.db.select().from(worktrees).where(eq(worktrees.id, featureWorktreeId));
    // .gitignore was not part of the given paths: still uncommitted.
    expect(git(wt!.path, 'status', '--porcelain')).toContain('.gitignore');
    expect(git(wt!.path, 'log', '-1', '--format=%an <%ae>|%s')).toBe('Nuera Test <owner@example.com>|crm : ajoute le tableau');
    const nothing = await inject('POST', `/v1/worktrees/${featureWorktreeId}/commit`, { message: 'vide', author, paths: ['src/index.ts'] });
    expect(nothing.statusCode).toBe(409);
    expect((nothing.json() as { error: { reason: string } }).error.reason).toBe('NOTHING_TO_COMMIT');

    const ab = await inject('GET', `/v1/worktrees/${featureWorktreeId}/ahead-behind`);
    expect(ab.json()).toMatchObject({ base: 'main', ahead: 1, behind: 0, upstream: null });

    const protectedPush = await inject('POST', `/v1/worktrees/${featureWorktreeId}/push`, { extraHeader: HEADER, protectedBranches: ['feature/crm-core'] });
    expect(protectedPush.statusCode).toBe(409);
    // The default branch is protected even when the request lists nothing.
    const toDefault = await inject('POST', `/v1/worktrees/${featureWorktreeId}/push`, { extraHeader: HEADER, remoteBranch: 'main' });
    expect(toDefault.statusCode).toBe(409);
    expect((toDefault.json() as { error: { reason: string } }).error.reason).toBe('BRANCH_PROTECTED');
    const push = await inject('POST', `/v1/worktrees/${featureWorktreeId}/push`, { extraHeader: HEADER });
    expect(push.statusCode).toBe(200);
    expect(push.json()).toMatchObject({ branch: 'feature/crm-core', remoteBranch: 'feature/crm-core', createdRemoteBranch: true });
    const bare = path.join(env.dirs.remotes, 'nuera-studio/demo.git');
    expect(git(bare, 'rev-parse', 'refs/heads/feature/crm-core')).toBe(commit.sha);
    const ab2 = await inject('GET', `/v1/worktrees/${featureWorktreeId}/ahead-behind`);
    expect(ab2.json()).toMatchObject({ upstream: { name: 'origin/feature/crm-core', ahead: 0, behind: 0 } });
    // Never stored in the repository config.
    expect(readFileSync(path.join(wt!.path, '..', '..', '..', 'demo', '.git', 'config'), 'utf8')).not.toMatch(/extraheader|AUTHORIZATION/i);
  }, 600_000);

  it('refuses a network command when the repository config would redirect it (Claude can edit .git/config)', async () => {
    const [row] = await env.db.select().from(projects).where(eq(projects.id, projectId));
    git(row!.path, 'config', 'url.file:///elsewhere/.insteadOf', env.runner.services.config.gitRemoteBase);
    try {
      const res = await inject('POST', `/v1/repos/${projectId}/fetch`, { extraHeader: HEADER });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: unknown }).error).toMatchObject({ reason: 'GIT_CONFIG_UNSAFE', data: { keys: ['url.file:///elsewhere/.insteadof'] } });
    } finally {
      git(row!.path, 'config', '--unset', 'url.file:///elsewhere/.insteadOf');
    }
    const ok = await inject('POST', `/v1/repos/${projectId}/fetch`, {});
    expect(ok.statusCode).toBe(200);
  }, 600_000);

  it('lists branches with merged / protected / worktree flags and the log', async () => {
    const res = await inject('GET', `/v1/repos/${projectId}/branches?protected=release`);
    const { branches, defaultBranch } = res.json() as { defaultBranch: string; branches: Array<{ name: string; kind: string; merged: boolean; protected: boolean; worktreeName: string | null; isDefault: boolean }> };
    expect(defaultBranch).toBe('main');
    expect(branches.find((b) => b.kind === 'local' && b.name === 'main')).toMatchObject({ protected: true, isDefault: true });
    expect(branches.find((b) => b.kind === 'local' && b.name === 'feature/crm-core')).toMatchObject({ merged: false, worktreeName: 'crm-core' });
    expect(branches.some((b) => b.kind === 'remote' && b.name === 'feature/crm-core')).toBe(true);
    const log = await inject('GET', `/v1/repos/${projectId}/log?n=5&worktreeId=${featureWorktreeId}`);
    expect((log.json() as { commits: Array<{ subject: string }> }).commits[0]!.subject).toBe('crm : ajoute le tableau');
  }, 600_000);

  it('detects divergence (ff-only) and rebase conflicts precisely, touching nothing', async () => {
    // Remote main moves on…
    writeFileSync(path.join(seedWork, 'README.md'), '# Projet de test\nligne distante\n');
    git(seedWork, 'commit', '-am', 'distant');
    git(seedWork, 'push', 'origin', 'main');
    // …while the primary clone has its own commit on the same line.
    const [row] = await env.db.select().from(projects).where(eq(projects.id, projectId));
    writeFileSync(path.join(row!.path, 'README.md'), '# Projet de test\nligne locale\n');
    git(row!.path, 'commit', '-am', 'local');
    const before = git(row!.path, 'rev-parse', 'HEAD');

    const ff = await inject('POST', `/v1/repos/${projectId}/pull`, { extraHeader: HEADER });
    expect(ff.statusCode).toBe(409);
    expect((ff.json() as { error: { reason: string; data: { ahead: number; behind: number } } }).error).toMatchObject({ reason: 'PULL_DIVERGED', data: { ahead: 1, behind: 1 } });

    const rebase = await inject('POST', `/v1/repos/${projectId}/pull`, { extraHeader: HEADER, mode: 'rebase', identity: author });
    expect(rebase.statusCode).toBe(409);
    const err = (rebase.json() as { error: { reason: string; data: { files: string[] }; untouched: string } }).error;
    expect(err.reason).toBe('PULL_CONFLICT');
    expect(err.data.files).toEqual(['README.md']);
    expect(git(row!.path, 'rev-parse', 'HEAD')).toBe(before);
    expect(existsSync(path.join(row!.path, '.git', 'rebase-merge'))).toBe(false);

    const sync = await inject('GET', `/v1/repos/${projectId}/sync`);
    expect(sync.json()).toMatchObject({ state: 'diverged', ahead: 1, behind: 1 });
  }, 600_000);

  it('fast-forwards when only behind', async () => {
    const [row] = await env.db.select().from(projects).where(eq(projects.id, projectId));
    git(row!.path, 'reset', '--hard', 'origin/main');
    writeFileSync(path.join(seedWork, 'src', 'index.ts'), 'export const answer = 44;\n');
    git(seedWork, 'commit', '-am', 'encore');
    git(seedWork, 'push', 'origin', 'main');
    const res = await inject('POST', `/v1/repos/${projectId}/pull`, { extraHeader: HEADER });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'fast_forward', commits: 1, sync: { state: 'up_to_date' } });
  }, 600_000);

  it('refuses to remove a dirty worktree unless forced', async () => {
    const [wt] = await env.db.select().from(worktrees).where(eq(worktrees.id, featureWorktreeId));
    writeFileSync(path.join(wt!.path, 'wip.txt'), 'en cours');
    const res = await inject('DELETE', `/v1/worktrees/${featureWorktreeId}`);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { reason: string; untouched: string } }).error).toMatchObject({ reason: 'WORKTREE_DIRTY' });
    expect(existsSync(wt!.path)).toBe(true);
    const forced = await inject('DELETE', `/v1/worktrees/${featureWorktreeId}?force=1&deleteBranch=1`);
    expect(forced.statusCode).toBe(200);
    // `git branch -d` accepts it: the branch is fully merged into its (pushed) upstream.
    expect(forced.json()).toMatchObject({ removed: true, branchDeleted: true });
    expect(existsSync(wt!.path)).toBe(false);
    const [after] = await env.db.select().from(worktrees).where(eq(worktrees.id, featureWorktreeId));
    expect(after!.status).toBe('removed');
  }, 600_000);

  it('writes CLAUDE.md and commits it alone', async () => {
    const res = await inject('PUT', `/v1/projects/${projectId}/claude-md`, { content: '# Règles\n\n- Nouvelle règle\n', commit: { message: 'docs : met à jour CLAUDE.md', author } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ lines: 3 });
    const read = await inject('GET', `/v1/projects/${projectId}/claude-md`);
    expect(read.json()).toMatchObject({ exists: true, lines: 3, lastCommit: { subject: 'docs : met à jour CLAUDE.md' } });
  }, 600_000);
});
