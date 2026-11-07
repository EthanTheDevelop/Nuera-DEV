import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { sessions, worktrees } from '@nuera/db';
import type { SessionCommandResult, SessionDto, SessionEventItem } from '@nuera/shared/runner';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claudeProjectDirName, findTranscript, placeTranscript } from '../src/sessions/transcript';
import { auth, createBareRemote, dbReady, git, seedProject, startTestRunner, tmpDir, waitFor, type TestEnv } from './helpers';

const ID = '0b6f2f1e-6a51-4f43-9a3e-2b0c1f7d9e11';

describe('resume: conversation files of an account', () => {
  it('names the project folder like the CLI (non-alphanumeric → -, 200 characters + hash)', () => {
    expect(claudeProjectDirName('/srv/projets/.worktrees/app/crm-core')).toBe('-srv-projets--worktrees-app-crm-core');
    const long = `/srv/${'x'.repeat(300)}`;
    const name = claudeProjectDirName(long);
    expect(name.startsWith(`-srv-${'x'.repeat(195)}-`)).toBe(true);
    expect(name).toMatch(/^.{200}-[0-9a-z]+$/);
    expect(claudeProjectDirName(`${long}y`)).not.toBe(name);
  });

  it('finds the conversation at its place, at its recorded path, then anywhere in the roots of the account', async () => {
    const root = path.join(tmpDir('claude-a'), 'projects');
    const legacy = path.join(tmpDir('claude-legacy'), 'projects');
    const other = path.join(tmpDir('claude-b'), 'projects');
    const cwd = '/srv/projets/.worktrees/app/crm-core';
    const expected = path.join(root, claudeProjectDirName(cwd), `${ID}.jsonl`);

    // Nothing anywhere; another account's folder is never searched.
    mkdirSync(path.join(other, 'x'), { recursive: true });
    writeFileSync(path.join(other, 'x', `${ID}.jsonl`), '{"type":"user"}\n');
    expect(await findTranscript({ conversationId: ID, recordedPath: path.join(other, 'x', `${ID}.jsonl`), roots: [root, legacy], cwd })).toBeNull();

    // An empty file (CLI stopped before its first message) does not count.
    mkdirSync(path.join(legacy, '-old-path'), { recursive: true });
    writeFileSync(path.join(legacy, '-old-path', `${ID}.jsonl`), '');
    expect(await findTranscript({ conversationId: ID, recordedPath: null, roots: [root, legacy], cwd })).toBeNull();

    // In the legacy folder of the account (HOME / CLAUDE_CONFIG_DIR changed): found, then copied in place.
    writeFileSync(path.join(legacy, '-old-path', `${ID}.jsonl`), '{"type":"user"}\n');
    const found = await findTranscript({ conversationId: ID, recordedPath: null, roots: [root, legacy], cwd });
    expect(found).toMatchObject({ inPlace: false, expected });
    const placed = await placeTranscript(found!);
    expect(placed).toBe(expected);
    expect(readFileSync(expected, 'utf8')).toBe('{"type":"user"}\n');
    expect(existsSync(path.join(legacy, '-old-path', `${ID}.jsonl`))).toBe(true);
    expect(await findTranscript({ conversationId: ID, recordedPath: null, roots: [root, legacy], cwd })).toMatchObject({ inPlace: true });

    // Ids that are not conversation ids are never looked up.
    expect(await findTranscript({ conversationId: '../x', recordedPath: null, roots: [root], cwd })).toBeNull();
  });
});

describe.skipIf(!dbReady)('resume: never a dead end (fake CLI, PTY backend)', () => {
  let env: TestEnv;
  let projectId: string;
  let claudeConfig: string;

  const inject = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    env.runner.api.inject({ method, url, headers: { ...auth, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
  const session = async (id: string) => (await inject('GET', `/v1/sessions/${id}`)).json() as SessionDto;
  const events = async (id: string) => ((await inject('GET', `/v1/sessions/${id}/events?limit=500`)).json() as { items: SessionEventItem[] }).items;
  const row = async (id: string) => (await env.db.select().from(sessions).where(eq(sessions.id, id)))[0]!;
  const waitLive = (id: string, label: string) =>
    waitFor(async () => {
      const s = await session(id);
      return s.live && s.status === 'waiting_input' ? s : null;
    }, { timeoutMs: 300_000, intervalMs: 500, label });
  const stop = async (id: string) => {
    await inject('POST', `/v1/sessions/${id}/stop`, { force: true });
    return waitFor(async () => {
      const s = await session(id);
      return s.status === 'stopped' && !s.live ? s : null;
    }, { timeoutMs: 60_000, label: 'stopped' });
  };
  /** A session that said something (its conversation file is not empty), then stopped. */
  const talkedSession = async (branch: string) => {
    const created = await inject('POST', '/v1/sessions', { projectId, title: `Reprise ${branch}`, worktree: { mode: 'new', branch } });
    const id = (created.json() as SessionDto).id;
    await inject('POST', `/v1/sessions/${id}/instruction`, { text: 'bonjour' });
    await waitFor(async () => (await events(id)).some((i) => i.kind === 'assistant' && i.payload.text === 'Reçu : bonjour'), { timeoutMs: 300_000, intervalMs: 500, label: 'reply' });
    await stop(id);
    return id;
  };

  beforeAll(async () => {
    claudeConfig = tmpDir('claude-config');
    mkdirSync(path.join(claudeConfig, 'projects'), { recursive: true });
    env = await startTestRunner({ claudeConfigDir: claudeConfig });
    const remote = createBareRemote(env.dirs.remotes, 'nuera-studio/reprise');
    const target = path.join(env.dirs.projects, 'reprise');
    git(env.dirs.projects, 'clone', remote.bare, target);
    projectId = (await seedProject(env.db, { fullName: 'nuera-studio/reprise', path: target, slug: 'reprise' })).id;
  }, 600_000);

  afterAll(async () => {
    await env?.close();
  }, 600_000);

  it('reopens a conversation whose file is in another folder of the account (worktree moved, HOME changed)', async () => {
    const id = await talkedSession('feature/deplacee');
    const recorded = (await row(id)).transcriptPath!;
    const moved = path.join(claudeConfig, 'projects', '-ancien-chemin', path.basename(recorded));
    mkdirSync(path.dirname(moved), { recursive: true });
    renameSync(recorded, moved);
    await env.db.update(sessions).set({ transcriptPath: '/nulle/part/ailleurs.jsonl' }).where(eq(sessions.id, id));
    expect(await session(id)).toMatchObject({ resumable: true, resumeMode: 'conversation' });

    expect((await inject('POST', `/v1/sessions/${id}/resume`, {})).statusCode).toBe(200);
    const live = await waitLive(id, 'resumed');
    expect(live).toMatchObject({ resumeCount: 1, resumeMode: 'conversation' });
    expect((await row(id)).transcriptPath).toBe(recorded);
    expect(readFileSync(recorded, 'utf8')).toContain('bonjour');
    expect((await events(id)).some((i) => i.kind === 'status' && i.payload.label === 'Session reprise')).toBe(true);
    await stop(id);
  }, 1_200_000);

  it('finds the conversation in the folder the first account used before (CLAUDE_CONFIG_DIR of the runner)', async () => {
    const id = await talkedSession('feature/ancien-dossier');
    const recorded = (await row(id)).transcriptPath!;
    const legacy = tmpDir('claude-ancien');
    const moved = path.join(legacy, 'projects', '-srv-ancien', path.basename(recorded));
    mkdirSync(path.dirname(moved), { recursive: true });
    renameSync(recorded, moved);
    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = legacy;
    try {
      expect(await session(id)).toMatchObject({ resumeMode: 'conversation' });
      expect((await inject('POST', `/v1/sessions/${id}/resume`, {})).statusCode).toBe(200);
      await waitLive(id, 'resumed from the legacy folder');
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
    }
    // Copied into the account's folder, the original left in place.
    expect(existsSync(recorded)).toBe(true);
    expect(existsSync(moved)).toBe(true);
    await stop(id);
  }, 1_200_000);

  it('asks first, then starts a fresh CLI with the context when the conversation is gone (same session, same thread)', async () => {
    const id = await talkedSession('feature/perdue');
    const before = await row(id);
    rmSync(before.transcriptPath!, { force: true });
    expect(await session(id)).toMatchObject({ resumable: true, resumeMode: 'context' });

    const refused = await inject('POST', `/v1/sessions/${id}/resume`, {});
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { error: { reason: string } }).error.reason).toBe('RESUME_CONTEXT_REQUIRED');
    expect((await row(id)).claudeSessionId).toBe(before.claudeSessionId);

    const context = 'Reprise de la session « Reprise » : dernière instruction « bonjour ».';
    expect((await inject('POST', `/v1/sessions/${id}/resume`, { fresh: { context } })).statusCode).toBe(200);
    await waitFor(async () => (await events(id)).some((i) => i.kind === 'assistant' && i.payload.text === `Reçu : ${context}`), { timeoutMs: 300_000, intervalMs: 500, label: 'context delivered' });
    const after = await row(id);
    expect(after.claudeSessionId).not.toBe(before.claudeSessionId);
    expect(after.resumeCount).toBe(1);
    const items = await events(id);
    // The thread is kept: the first instruction is still there, then the notice and the context.
    expect(items.filter((i) => i.kind === 'instruction').map((i) => (i.kind === 'instruction' ? i.payload.text : ''))).toEqual(['bonjour', context]);
    expect(items.some((i) => i.kind === 'status' && i.payload.label === 'Session reprise avec un nouveau contexte')).toBe(true);
    expect(items.some((i) => i.kind === 'system' && i.payload.message.startsWith('Reprise avec un nouveau contexte'))).toBe(true);
    expect((await session(id)).resumeMode).toBe('context');
    await stop(id);
    // The new conversation is recorded: the next « Reprendre » reopens it.
    expect((await session(id)).resumeMode).toBe('conversation');
  }, 1_200_000);

  it('records a conversation the CLI refuses to reopen, then starts afresh on the next « Reprendre »', async () => {
    const id = await talkedSession('feature/refusee');
    // The fake CLI refuses a conversation file marked so (like a format it can no longer read).
    writeFileSync((await row(id)).transcriptPath!, '{"nuera-fake":"refuse-resume"}\n');
    expect(await session(id)).toMatchObject({ resumeMode: 'conversation' });
    expect((await inject('POST', `/v1/sessions/${id}/resume`, {})).statusCode).toBe(200);
    const failed = await waitFor(async () => {
      const s = await session(id);
      return s.status === 'failed' && !s.live ? s : null;
    }, { timeoutMs: 120_000, intervalMs: 500, label: 'refused by the CLI' });
    expect(failed).toMatchObject({ errorCode: 'resume_not_found', resumable: true, resumeMode: 'context' });
    expect((await events(id)).some((i) => i.kind === 'status' && /Conversation introuvable/.test(i.payload.label))).toBe(true);

    expect((await inject('POST', `/v1/sessions/${id}/resume`, { fresh: { context: null } })).statusCode).toBe(200);
    const live = await waitLive(id, 'fresh start without context');
    expect(live).toMatchObject({ resumeMode: 'context', errorCode: null });
    await stop(id);
  }, 1_200_000);

  it('recreates a removed worktree from its branch and reopens the conversation in it', async () => {
    const id = await talkedSession('feature/recreee');
    const first = await row(id);
    const [wt] = await env.db.select().from(worktrees).where(eq(worktrees.id, first.worktreeId!));
    git(wt!.path, 'commit', '--allow-empty', '-m', 'travail en cours');
    // « Supprimer le worktree » (branch kept): the session's folder is gone.
    const removed = await env.runner.api.inject({ method: 'DELETE', url: `/v1/worktrees/${wt!.id}?force=true&deleteBranch=false`, headers: auth });
    expect(removed.statusCode).toBe(200);
    expect(existsSync(wt!.path)).toBe(false);
    expect(await session(id)).toMatchObject({ resumable: true });

    expect((await inject('POST', `/v1/sessions/${id}/resume`, {})).statusCode).toBe(200);
    await waitLive(id, 'resumed in a recreated worktree');
    const after = await row(id);
    const [restored] = await env.db.select().from(worktrees).where(eq(worktrees.id, after.worktreeId!));
    expect(restored).toMatchObject({ branch: 'feature/recreee', status: 'active' });
    expect(existsSync(restored!.path)).toBe(true);
    expect(git(restored!.path, 'log', '-1', '--format=%s')).toBe('travail en cours');
    const notices = (await events(id)).filter((i) => i.kind === 'system').map((i) => (i.kind === 'system' ? i.payload.message : ''));
    expect(notices.some((m) => /recréé depuis la branche locale feature\/recreee/.test(m))).toBe(true);
    await stop(id);
  }, 1_200_000);

  it('changes the effort: stored for the next launch, typed as /effort into a live CLI, shown as the CLI reports it', async () => {
    const created = await inject('POST', '/v1/sessions', { projectId, title: 'Effort', worktree: { mode: 'new', branch: 'feature/effort' } });
    const id = (created.json() as SessionDto).id;
    const stored = (await inject('POST', `/v1/sessions/${id}/command`, { command: 'effort', effort: 'high' })).json() as SessionCommandResult;
    expect(stored).toMatchObject({ applied: 'next_launch', session: { effort: 'high' } });
    expect((await inject('POST', `/v1/sessions/${id}/command`, { command: 'effort', effort: 'turbo' })).statusCode).toBe(400);

    expect((await inject('POST', `/v1/sessions/${id}/start`, {})).statusCode).toBe(200);
    await waitFor(async () => (await session(id)).live, { timeoutMs: 300_000, intervalMs: 500, label: 'started' });
    const argv = await waitFor(() => {
      const file = path.join(claudeConfig, 'nuera-fake-launch', `${id}.json`);
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { argv: string[] }).argv : null;
    }, { timeoutMs: 60_000, label: 'launch argv' });
    expect(argv.join(' ')).toContain('--effort high');
    // Reported by the status line of the CLI.
    await waitFor(async () => (await session(id)).cliStatus?.effort === 'high', { timeoutMs: 60_000, intervalMs: 300, label: 'effort reported' });

    const live = (await inject('POST', `/v1/sessions/${id}/command`, { command: 'effort', effort: 'low' })).json() as SessionCommandResult;
    expect(live).toMatchObject({ applied: 'live', session: { effort: 'low', cliStatus: { effort: 'low' } } });
    const terminal = env.runner.services.sessions.terminalFor(id)!;
    expect(terminal.screenText()).toContain('Set effort level to low');
    await stop(id);
  }, 1_200_000);
});
