import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { SessionDto, SessionEventItem } from '@nuera/shared/runner';
import type { RunnerEvent } from '@nuera/shared/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, createBareRemote, dbReady, git, seedProject, startTestRunner, tmpDir, waitFor, type TestEnv } from './helpers';

/**
 * Interactive screens of the CLI (fake CLI `FAKE_CLAUDE_ONBOARDING`): the theme picker and the
 * « Press Enter to continue » splash are answered by the runner, trust and unknown menus are left
 * to the owner (attention), and no instruction is ever typed into them (queued, then delivered).
 */
describe.skipIf(!dbReady)('interactive screens of the CLI (fake CLI, PTY backend)', () => {
  let env: TestEnv;
  let projectId: string;
  const bus: RunnerEvent[] = [];
  let off: (() => void) | null = null;

  const inject = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    env.runner.api.inject({ method, url, headers: { ...auth, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
  const session = async (id: string) => (await inject('GET', `/v1/sessions/${id}`)).json() as SessionDto;
  const events = async (id: string) => ((await inject('GET', `/v1/sessions/${id}/events?limit=500`)).json() as { items: SessionEventItem[] }).items;
  const systemLines = async (id: string) => (await events(id)).filter((i) => i.kind === 'system').map((i) => (i.kind === 'system' ? i.payload.message : ''));
  const replies = async (id: string) => (await events(id)).filter((i) => i.kind === 'assistant').map((i) => (i.kind === 'assistant' ? i.payload.text : ''));

  beforeAll(async () => {
    const claudeConfig = tmpDir('claude-config');
    mkdirSync(path.join(claudeConfig, 'projects'), { recursive: true });
    env = await startTestRunner({ claudeConfigDir: claudeConfig });
    const remote = createBareRemote(env.dirs.remotes, 'nuera-studio/attente');
    const target = path.join(env.dirs.projects, 'attente');
    git(env.dirs.projects, 'clone', remote.bare, target);
    projectId = (await seedProject(env.db, { fullName: 'nuera-studio/attente', path: target, slug: 'attente' })).id;
    off = env.runner.services.bus.subscribe('global', (event) => {
      bus.push(event);
    });
  }, 600_000);

  afterAll(async () => {
    off?.();
    await env?.close();
  }, 600_000);

  it('answers the theme picker itself, never the trust dialog, and holds the instruction until it is answered', async () => {
    const created = await inject('POST', '/v1/sessions', {
      projectId,
      title: 'Premier lancement',
      worktree: { mode: 'new', branch: 'feature/premier-lancement' },
      launch: { env: { FAKE_CLAUDE_ONBOARDING: 'theme,trust' } },
      start: true,
    });
    expect(created.statusCode).toBe(200);
    const id = (created.json() as SessionDto).id;

    // Theme picker: Enter sent by the runner, one sober line in the conversation.
    await waitFor(async () => (await systemLines(id)).includes('Thème du terminal choisi automatiquement'), { timeoutMs: 120_000, intervalMs: 300, label: 'theme auto-answered' });
    // Trust dialog: reported, never answered.
    const blocked = await waitFor(async () => {
      const s = await session(id);
      return s.attention?.kind === 'trust' ? s : null;
    }, { timeoutMs: 60_000, intervalMs: 300, label: 'trust attention' });
    expect(blocked.attention!.text).toContain('Yes, I trust this folder');
    expect(blocked.attention!.text.length).toBeLessThanOrEqual(400);
    expect(blocked.status).toBe('new');
    const statusEvent = bus.find((e) => e.type === 'session.status' && e.data.sessionId === id && e.data.attention?.kind === 'trust');
    expect(statusEvent).toBeTruthy();
    await waitFor(() => bus.some((e) => e.type === 'notification.created' && e.data.sessionId === id && e.data.kind === 'session_attention'), { timeoutMs: 30_000, label: 'notification' });

    // The owner types an instruction meanwhile: queued, NOT typed into the dialog (Enter would accept it).
    const sent = await inject('POST', `/v1/sessions/${id}/instruction`, { text: 'bonjour' });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ delivered: false, queued: true, session: { queuedInstructions: 1, attention: { kind: 'trust' } } });
    await new Promise((r) => setTimeout(r, 2500));
    const terminal = env.runner.services.sessions.terminalFor(id)!;
    expect(terminal.viewportText()).toContain('Yes, I trust this folder');
    expect((await session(id)).attention?.kind).toBe('trust');
    const trustNotices = bus.filter((e) => e.type === 'notification.created' && e.data.sessionId === id).length;
    expect(trustNotices).toBe(1);

    // The owner answers in the raw terminal: the screen goes, the held instruction leaves.
    await inject('POST', `/v1/terminals/${terminal.id}/input`, { data: '1' });
    await waitFor(async () => (await replies(id)).includes('Reçu : bonjour'), { timeoutMs: 120_000, intervalMs: 500, label: 'queued instruction delivered' });
    const after = await session(id);
    expect(after.attention ?? null).toBeNull();
    expect(after.queuedInstructions).toBe(0);
    expect(bus.some((e) => e.type === 'session.status' && e.data.sessionId === id && e.data.attention === null)).toBe(true);
    await inject('POST', `/v1/sessions/${id}/stop`, { force: true });
    await waitFor(async () => (await session(id)).status === 'stopped', { timeoutMs: 60_000, label: 'stopped' });
  }, 900_000);

  it('validates the splash, reports an unknown menu after its grace period, and delivers the first instruction once it is answered', async () => {
    const created = await inject('POST', '/v1/sessions', {
      projectId,
      title: 'Menu inconnu',
      worktree: { mode: 'new', branch: 'feature/menu-inconnu' },
      launch: { env: { FAKE_CLAUDE_ONBOARDING: 'continue,menu' } },
    });
    const id = (created.json() as SessionDto).id;
    // First instruction of a session that has not started: it waits for the CLI to be ready.
    const sent = await inject('POST', `/v1/sessions/${id}/instruction`, { text: 'premier message' });
    expect(sent.json()).toMatchObject({ queued: true, started: true });

    await waitFor(async () => (await systemLines(id)).includes("Écran d'information de Claude Code validé automatiquement"), { timeoutMs: 120_000, intervalMs: 300, label: 'splash auto-answered' });
    const menu = await waitFor(async () => {
      const s = await session(id);
      return s.attention?.kind === 'menu' ? s : null;
    }, { timeoutMs: 60_000, intervalMs: 300, label: 'menu attention' });
    expect(menu.attention!.text).toContain("Use Claude Code's terminal setup?");
    expect(menu.queuedInstructions).toBe(1);
    expect(await replies(id)).toEqual([]);
    // Never answered by the runner: still there a few seconds later.
    await new Promise((r) => setTimeout(r, 2000));
    expect((await session(id)).attention?.kind).toBe('menu');

    const terminal = env.runner.services.sessions.terminalFor(id)!;
    await inject('POST', `/v1/terminals/${terminal.id}/input`, { data: '2' });
    await waitFor(async () => (await replies(id)).includes('Reçu : premier message'), { timeoutMs: 120_000, intervalMs: 500, label: 'first instruction delivered' });
    expect((await session(id)).attention ?? null).toBeNull();
    await inject('POST', `/v1/sessions/${id}/stop`, { force: true });
    await waitFor(async () => (await session(id)).status === 'stopped', { timeoutMs: 60_000, label: 'stopped' });
  }, 900_000);
});
