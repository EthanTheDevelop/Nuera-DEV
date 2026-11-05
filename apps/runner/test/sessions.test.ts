import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { sessions, worktrees } from '@nuera/db';
import type { SessionDto, SessionEventItem } from '@nuera/shared/runner';
import { parseRunnerEvent, type RunnerEvent } from '@nuera/shared/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, createBareRemote, dbReady, git, seedProject, startTestRunner, tmpDir, waitFor, type TestEnv } from './helpers';

describe.skipIf(!dbReady)('Claude session pipeline (fake CLI, PTY backend)', () => {
  let env: TestEnv;
  let projectId: string;
  let sessionId: string;

  const inject = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    env.runner.api.inject({ method, url, headers: { ...auth, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
  const session = async (id = sessionId) => (await inject('GET', `/v1/sessions/${id}`)).json() as SessionDto;
  const events = async (id = sessionId) => ((await inject('GET', `/v1/sessions/${id}/events?limit=500`)).json() as { items: SessionEventItem[] }).items;

  beforeAll(async () => {
    const t0 = Date.now();
    const step = (label: string) => console.info(`[sessions.test] ${label} : ${Math.round((Date.now() - t0) / 1000)} s`);
    const claudeConfig = tmpDir('claude-config');
    mkdirSync(path.join(claudeConfig, 'projects'), { recursive: true });
    env = await startTestRunner({}, { CLAUDE_CONFIG_DIR: claudeConfig });
    step('runner démarré');
    const remote = createBareRemote(env.dirs.remotes, 'nuera-studio/app');
    step('dépôt distant créé');
    const target = path.join(env.dirs.projects, 'app');
    git(env.dirs.projects, 'clone', remote.bare, target);
    const project = await seedProject(env.db, { fullName: 'nuera-studio/app', path: target, slug: 'app' });
    projectId = project.id;
    step('projet prêt');
  }, 600_000);

  afterAll(async () => {
    await env?.close();
  }, 600_000);

  it('creates a session and its worktree without starting the CLI (W1)', async () => {
    const res = await inject('POST', '/v1/sessions', {
      projectId,
      title: 'Module CRM · pipeline',
      worktree: { mode: 'new', branch: 'feature/crm-core' },
      launch: { permissionWaitSeconds: 60, denyRules: ['mcp__coolify__deploy'] },
    });
    expect(res.statusCode).toBe(200);
    const dto = res.json() as SessionDto;
    expect(dto).toMatchObject({ status: 'new', live: false, backend: 'pty', worktree: { name: 'crm-core', branch: 'feature/crm-core' } });
    sessionId = dto.id;
    const settings = JSON.parse(readFileSync(path.join(env.dirs.data, 'sessions', sessionId, 'settings.json'), 'utf8')) as {
      hooks: Record<string, unknown>;
      permissions: { deny: string[] };
    };
    expect(Object.keys(settings.hooks)).toContain('PermissionRequest');
    expect(settings.permissions.deny).toEqual(['mcp__coolify__deploy']);
  }, 600_000);

  it('runs a full turn: instruction, plan, tools, permission decided in Nuera, final message', async () => {
    const sse: RunnerEvent[] = [];
    const abort = new AbortController();
    const stream = await fetch(`${env.apiUrl}/v1/sessions/${sessionId}/stream`, { headers: auth, signal: abort.signal });
    expect(stream.status).toBe(200);
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
            if (e) sse.push(e);
          }
        }
      } catch {
        // aborted
      }
    })();

    const res = await inject('POST', `/v1/sessions/${sessionId}/instruction`, { text: 'scenario:full Termine le module pipeline du CRM.' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ queued: true, started: true, delivered: false });

    const waiting = await waitFor(async () => {
      const s = await session();
      return s.pendingPermission ? s : null;
    }, { timeoutMs: 420_000, intervalMs: 500, label: 'permission request' });
    expect(waiting.status).toBe('waiting_permission');
    expect(waiting.live).toBe(true);
    expect(waiting.pendingPermission).toMatchObject({
      toolName: 'Edit',
      title: 'Claude demande à modifier un fichier',
      target: 'src/index.ts',
      alwaysLabel: 'Toujours pour src/**',
      options: [
        { id: 'allow', label: 'Autoriser' },
        { id: 'allow_always', label: 'Toujours pour src/**' },
        { id: 'deny', label: 'Refuser' },
      ],
    });
    const busy = await inject('POST', `/v1/sessions/${sessionId}/instruction`, { text: 'autre chose' });
    expect(busy.statusCode).toBe(409);

    const decision = await inject('POST', `/v1/permissions/${waiting.pendingPermission!.id}/decision`, { behavior: 'allow', always: true });
    expect(decision.statusCode).toBe(200);
    expect(decision.json()).toMatchObject({ status: 'allowed_always' });
    const again = await inject('POST', `/v1/permissions/${waiting.pendingPermission!.id}/decision`, { behavior: 'deny' });
    expect(again.statusCode).toBe(409);

    const done = await waitFor(async () => {
      const s = await session();
      return s.status === 'waiting_input' && s.lastInstruction ? s : null;
    }, { timeoutMs: 420_000, intervalMs: 500, label: 'end of turn' });
    expect(done.planTotal).toBe(3);
    expect(done.cliStatus).toMatchObject({ model: { displayName: 'Fake Opus' }, contextWindow: { usedPercentage: 23 } });

    const items = await events();
    const kinds = items.map((i) => i.kind);
    expect(kinds[0]).toBe('status');
    const instruction = items.find((i) => i.kind === 'instruction');
    expect(instruction?.payload).toMatchObject({ text: 'scenario:full Termine le module pipeline du CRM.', source: 'nuera' });
    const plan = items.find((i) => i.kind === 'plan');
    expect(plan?.payload).toMatchObject({ total: 3 });
    const tools = items.filter((i): i is Extract<SessionEventItem, { kind: 'tool' }> => i.kind === 'tool');
    expect(tools.map((t) => [t.payload.tool, t.payload.status, t.payload.summary])).toEqual([
      ['Read', 'done', '4 lignes'],
      ['Edit', 'done', '+2 −1'],
      ['Bash', 'done', '10 réussis · 3,2 s'],
    ]);
    expect(tools[0]!.payload.target).toBe('CLAUDE.md');
    expect(tools[1]!.payload.permissionId).toBe(waiting.pendingPermission!.id);
    expect(tools[2]!.payload.output).toContain('Tests  10 passed (10)');
    const permission = items.find((i) => i.kind === 'permission');
    expect(permission?.payload).toMatchObject({ status: 'allowed_always', resolvedLabel: 'Modification toujours autorisée · src/index.ts' });
    const assistants = items.filter((i): i is Extract<SessionEventItem, { kind: 'assistant' }> => i.kind === 'assistant');
    expect(assistants.map((a) => a.payload.text)).toEqual(["Je lis d'abord les conventions du dépôt.", "C'est terminé : les dix tests passent."]);
    expect(assistants[1]!.payload.final).toBe(true);
    // Positions follow the conversation order.
    const order = items.map((i) => (i.kind === 'tool' ? i.payload.tool : i.kind));
    expect(order.indexOf('instruction')).toBeLessThan(order.indexOf('Read'));
    expect(order.indexOf('Read')).toBeLessThan(order.indexOf('Edit'));
    expect(order.indexOf('Edit')).toBeLessThan(order.indexOf('Bash'));

    const [wt] = await env.db.select().from(worktrees).where(eq(worktrees.id, done.worktreeId!));
    expect(readFileSync(path.join(wt!.path, 'src', 'index.ts'), 'utf8')).toContain('answer = 43');

    await waitFor(() => sse.some((e) => e.type === 'session.event'), { timeoutMs: 10_000, label: 'sse events' });
    expect(sse[0]?.type).toBe('session.status');
    expect(sse.some((e) => e.type === 'session.permission')).toBe(true);
    abort.abort();
    await pump;
  }, 1_200_000);

  it('enforces one live session per worktree and the concurrency cap', async () => {
    const s = await session();
    const sameWorktree = await inject('POST', '/v1/sessions', { projectId, worktree: { mode: 'existing', worktreeId: s.worktreeId }, start: true });
    expect(sameWorktree.statusCode).toBe(409);
    expect((sameWorktree.json() as { error: { reason: string } }).error.reason).toBe('WORKTREE_IN_USE');
    const capped = await inject('POST', '/v1/sessions', {
      projectId,
      worktree: { mode: 'new', branch: 'feature/second' },
      launch: { maxConcurrentSessions: 1 },
      start: true,
    });
    expect(capped.statusCode).toBe(409);
    expect((capped.json() as { error: { reason: string } }).error.reason).toBe('CAPACITY_REACHED');
  }, 600_000);

  it('delivers an instruction typed while ready, interrupts, stops and resumes', async () => {
    const res = await inject('POST', `/v1/sessions/${sessionId}/instruction`, { text: 'bonjour' });
    expect(res.json()).toMatchObject({ delivered: true });
    await waitFor(async () => (await events()).some((i) => i.kind === 'assistant' && i.payload.text === 'Reçu : bonjour'), { timeoutMs: 300_000, intervalMs: 500, label: 'echo reply' });
    const terminal = env.runner.services.sessions.terminalFor(sessionId)!;
    const interrupt = await inject('POST', `/v1/sessions/${sessionId}/interrupt`);
    expect(interrupt.statusCode).toBe(200);
    await waitFor(() => terminal.screenText().includes('Interrompu'), { timeoutMs: 30_000, label: 'interrupt' });

    const stop = await inject('POST', `/v1/sessions/${sessionId}/stop`, { force: false });
    expect(stop.statusCode).toBe(200);
    const stopped = await waitFor(async () => {
      const s = await session();
      return s.status === 'stopped' ? s : null;
    }, { timeoutMs: 60_000, label: 'stopped' });
    expect(stopped.live).toBe(false);
    expect(stopped.resumable).toBe(true);

    const resumed = await inject('POST', `/v1/sessions/${sessionId}/resume`, {});
    expect(resumed.statusCode).toBe(200);
    const live = await waitFor(async () => {
      const s = await session();
      return s.live && s.status === 'waiting_input' ? s : null;
    }, { timeoutMs: 300_000, intervalMs: 500, label: 'resumed' });
    expect(live.resumeCount).toBe(1);
    const [row] = await env.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row!.hookTokenHash).toMatch(/^[0-9a-f]{64}$/);
    await inject('POST', `/v1/sessions/${sessionId}/stop`, { force: true });
    await waitFor(async () => (await session()).status === 'stopped', { timeoutMs: 60_000, label: 'stopped again' });
  }, 1_200_000);

  it('falls back to the terminal when nobody answers in time', async () => {
    const created = await inject('POST', '/v1/sessions', {
      projectId,
      title: 'Délai',
      worktree: { mode: 'new', branch: 'feature/timeout' },
      launch: { permissionWaitSeconds: 5 },
    });
    const id = (created.json() as SessionDto).id;
    await inject('POST', `/v1/sessions/${id}/instruction`, { text: 'scenario:full délai' });
    const answered = await waitFor(async () => {
      const items = await events(id);
      const p = items.find((i) => i.kind === 'permission');
      return p && p.payload.status === 'answered_in_terminal' ? p : null;
    }, { timeoutMs: 420_000, intervalMs: 500, label: 'answered in terminal' });
    expect(answered.payload).toMatchObject({ resolvedLabel: 'Réponse attendue dans le terminal · src/index.ts' });
    const s = await session(id);
    expect(s.status).toBe('waiting_permission');
    expect(s.currentActivity).toBe('Répondez à la demande dans le terminal');
    // The owner answers the CLI's own dialog in the raw terminal.
    const terminal = env.runner.services.sessions.terminalFor(id)!;
    await waitFor(() => terminal.screenText().includes('Autoriser la modification'), { timeoutMs: 60_000, label: 'cli dialog' });
    await inject('POST', `/v1/terminals/${terminal.id}/input`, { data: 'o' });
    await waitFor(async () => (await session(id)).status === 'waiting_input', { timeoutMs: 300_000, intervalMs: 500, label: 'turn end' });
    await inject('POST', `/v1/sessions/${id}/stop`, { force: true });
  }, 1_200_000);

  it('starts afresh a conversation that never began, with one CLI for concurrent instructions', async () => {
    const created = await inject('POST', '/v1/sessions', { projectId, title: 'Concurrence', worktree: { mode: 'new', branch: 'feature/concurrence' }, start: true });
    expect(created.statusCode).toBe(200);
    const id = (created.json() as SessionDto).id;
    await waitFor(async () => {
      const [row] = await env.db.select().from(sessions).where(eq(sessions.id, id));
      return row?.transcriptPath ? row : null;
    }, { timeoutMs: 300_000, intervalMs: 500, label: 'session start hook' });
    await inject('POST', `/v1/sessions/${id}/stop`, { force: true });
    await waitFor(async () => (await session(id)).status === 'stopped', { timeoutMs: 60_000, label: 'stopped' });
    // Nothing was said: no journal to resume (a real CLI writes it at the first message).
    const [row] = await env.db.select().from(sessions).where(eq(sessions.id, id));
    rmSync(row!.transcriptPath!, { force: true });
    expect((await session(id)).resumable).toBe(false);

    const notifications: RunnerEvent[] = [];
    const off = env.runner.services.bus.subscribe('global', (e) => {
      if (e.type === 'notification.created') notifications.push(e);
    });
    // A double click: both instructions must reach the same, single CLI.
    const [first, second] = await Promise.all([
      inject('POST', `/v1/sessions/${id}/instruction`, { text: 'premier' }),
      inject('POST', `/v1/sessions/${id}/instruction`, { text: 'second' }),
    ]);
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    const replies = await waitFor(async () => {
      const texts = (await events(id)).filter((i) => i.kind === 'assistant').map((i) => (i.kind === 'assistant' ? i.payload.text : ''));
      return texts.includes('Reçu : premier') && texts.includes('Reçu : second') ? texts : null;
    }, { timeoutMs: 420_000, intervalMs: 500, label: 'both replies' });
    expect(replies).toHaveLength(2);
    const items = await events(id);
    expect(items.filter((i) => i.kind === 'status' && i.payload.label === 'Session démarrée')).toHaveLength(2);
    expect(items.filter((i) => i.kind === 'instruction').map((i) => (i.kind === 'instruction' ? i.payload.source : null))).toEqual(['nuera', 'nuera']);
    // Notifications open the Workspace of the session.
    await waitFor(() => notifications.length > 0, { timeoutMs: 30_000, label: 'notification' });
    expect(notifications[0]!.data).toMatchObject({ href: `/workspace/${id}`, sessionId: id });
    off();

    // « Interrompre » during a long step: Claude Code sends no hook afterwards (no Stop, no
    // PostToolUse for the cancelled tool), so the runner settles the status and the tool line.
    await inject('POST', `/v1/sessions/${id}/instruction`, { text: 'scenario:long' });
    await waitFor(async () => {
      const running = (await events(id)).some((i) => i.kind === 'tool' && i.payload.status === 'running');
      return running && (await session(id)).status === 'running';
    }, { timeoutMs: 300_000, intervalMs: 500, label: 'long step running' });
    expect((await inject('POST', `/v1/sessions/${id}/interrupt`)).statusCode).toBe(200);
    const settled = await waitFor(async () => {
      const s = await session(id);
      return s.status === 'waiting_input' ? s : null;
    }, { timeoutMs: 60_000, intervalMs: 500, label: 'settled after interrupt' });
    expect(settled.currentActivity).toBeNull();
    const after = await events(id);
    const longStep = after.filter((i): i is Extract<SessionEventItem, { kind: 'tool' }> => i.kind === 'tool').find((t) => t.payload.target === 'npm run dev');
    expect(longStep?.payload).toMatchObject({ status: 'error', summary: 'interrompu' });
    expect(after.some((i) => i.kind === 'status' && i.payload.label === 'Étape interrompue')).toBe(true);
    await inject('POST', `/v1/sessions/${id}/stop`, { force: true });
    await waitFor(async () => (await session(id)).status === 'stopped', { timeoutMs: 60_000, label: 'stopped again' });
  }, 1_200_000);
});
