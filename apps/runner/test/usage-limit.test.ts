import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { sessions } from '@nuera/db';
import type { CliStatus, SessionDto, SessionEventItem, UsageLimit } from '@nuera/shared/runner';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { usageLimitMessage } from '../src/sessions/manager';
import { sanitizeStatusLine } from '../src/sessions/statusline';
import { extractAssistantTexts } from '../src/sessions/transcript';
import {
  buildUsageLimit,
  DEFAULT_AUTO_RESUME_POLICY,
  detectLimitText,
  parseResetTime,
  resetFromStatus,
  scheduleAutoResume,
} from '../src/sessions/usage-limit';
import { auth, createBareRemote, dbReady, git, seedProject, startTestRunner, tmpDir, waitFor, type TestEnv } from './helpers';

// 2026-11-06 13:40 in Paris (12:40 UTC).
const NOW = Date.parse('2026-11-06T12:40:00Z');

describe('usage limit: what the CLI prints', () => {
  it('recognises the limit notices of the official CLI and their reset time', () => {
    expect(detectLimitText('5-hour limit reached ∙ resets 3pm (Europe/Paris)', NOW)).toEqual({
      message: '5-hour limit reached ∙ resets 3pm (Europe/Paris)',
      resetsAt: '2026-11-06T14:00:00.000Z',
      window: 'five_hour',
    });
    expect(detectLimitText("You've hit your session limit · resets 3:45pm", NOW, 'Europe/Paris')).toMatchObject({
      resetsAt: '2026-11-06T14:45:00.000Z',
      window: 'five_hour',
    });
    // Older CLIs: epoch seconds after « | ».
    expect(detectLimitText('Claude AI usage limit reached|1793977200', NOW)).toMatchObject({ resetsAt: new Date(1793977200 * 1000).toISOString(), window: null });
    // 7:40 in New York: today 9am there.
    expect(detectLimitText('Claude usage limit reached. Your limit will reset at 9am (America/New_York).', NOW)).toMatchObject({
      resetsAt: '2026-11-06T14:00:00.000Z',
    });
    expect(detectLimitText("You've hit your weekly limit · resets Mon 9am", NOW, 'Europe/Paris')).toMatchObject({
      window: 'seven_day',
      resetsAt: '2026-11-09T08:00:00.000Z',
    });
    expect(detectLimitText("You've hit your weekly limit · resets Nov 12, 9am", NOW, 'Europe/Paris')?.resetsAt).toBe('2026-11-12T08:00:00.000Z');
    // A time already passed today is tomorrow's.
    expect(parseResetTime('resets 11am', NOW, 'Europe/Paris')).toBe('2026-11-07T10:00:00.000Z');
    // Terminal screen: box drawing around the notice.
    expect(detectLimitText('│ ⎿  5-hour limit reached ∙ resets 3pm │\n│ /upgrade to increase your usage limit. │', NOW, 'Europe/Paris')?.resetsAt).toBe(
      '2026-11-06T14:00:00.000Z',
    );
  });

  it('does not take a warning, a reply about limits or a notice without time for more than it is', () => {
    expect(detectLimitText("You've used 85% of your session limit · resets 3:45pm", NOW)).toBeNull();
    expect(detectLimitText('Le middleware applique une limite de débit par adresse IP.', NOW)).toBeNull();
    expect(detectLimitText('You have hit your session limit', NOW)).toMatchObject({ resetsAt: null, window: 'five_hour' });
    expect(parseResetTime('resets 3', NOW)).toBeNull();
  });

  it('marks only the messages the CLI wrote itself in the transcript', () => {
    const synthetic = JSON.stringify({
      type: 'assistant',
      isApiErrorMessage: true,
      uuid: 'u9',
      timestamp: '2026-11-06T12:40:00Z',
      message: { model: '<synthetic>', content: [{ type: 'text', text: '5-hour limit reached ∙ resets 3pm' }] },
    });
    expect(extractAssistantTexts(synthetic)).toEqual([{ key: 'assistant:u9:0', text: '5-hour limit reached ∙ resets 3pm', at: '2026-11-06T12:40:00Z', cliMessage: true }]);
  });

  it('takes the exact reset from the status line when it is ahead', () => {
    const cli = sanitizeStatusLine({ rate_limits: { five_hour: { used_percentage: 100, resets_at: 1793977200 }, seven_day: { used_percentage: 40, resets_at: 1794400000 } } }) as CliStatus;
    expect(resetFromStatus(cli, 'five_hour', NOW)).toBe(new Date(1793977200 * 1000).toISOString());
    expect(resetFromStatus(cli, null, NOW)).toBe(new Date(1793977200 * 1000).toISOString());
    expect(resetFromStatus(cli, 'seven_day', NOW)).toBe(new Date(1794400000 * 1000).toISOString());
    // A window already reset (an older status line) is never used.
    expect(resetFromStatus(cli, 'five_hour', 1793977200 * 1000 + 1)).toBeNull();
    expect(resetFromStatus(null, 'five_hour', NOW)).toBeNull();
  });
});

describe('usage limit: schedule of the automatic resumption', () => {
  const policy = DEFAULT_AUTO_RESUME_POLICY;
  const detectedAt = new Date(NOW).toISOString();

  it('resumes at the reset + 2 min, or every 30 min for 6 h when the reset is unknown', () => {
    expect(scheduleAutoResume({ enabled: true, resetsAt: '2026-11-06T14:00:00.000Z', detectedAt, carried: null, policy, now: NOW })).toEqual({
      enabled: true,
      mode: 'reset',
      attempts: 0,
      maxAttempts: 5,
      lastAttemptAt: null,
      giveUpAt: null,
      nextAttemptAt: '2026-11-06T14:02:00.000Z',
      outcome: 'scheduled',
    });
    const retry = scheduleAutoResume({ enabled: true, resetsAt: null, detectedAt, carried: null, policy, now: NOW });
    expect(retry).toMatchObject({ mode: 'retry', maxAttempts: 12, nextAttemptAt: '2026-11-06T13:10:00.000Z', giveUpAt: '2026-11-06T18:40:00.000Z' });
    // Past the 6-hour window: nothing more.
    const late = scheduleAutoResume({ enabled: true, resetsAt: null, detectedAt, carried: { attempts: 3, lastAttemptAt: null, giveUpAt: retry.giveUpAt }, policy, now: NOW + 6 * 3600_000 });
    expect(late).toMatchObject({ outcome: 'exhausted', nextAttemptAt: null });
    expect(scheduleAutoResume({ enabled: false, resetsAt: '2026-11-06T14:00:00.000Z', detectedAt, carried: null, policy, now: NOW })).toMatchObject({ outcome: 'off', nextAttemptAt: null });
  });

  it('keeps counting when the limit is hit again after a resumption, and stops after the last attempt', () => {
    const first = buildUsageLimit({ previous: null, source: 'hook', message: 'You have hit your session limit', resetsAt: null, window: 'five_hour', autoResumeEnabled: true, policy, now: NOW });
    // Same stop, the transcript then the status line give the reset: completed, not counted twice.
    const completed = buildUsageLimit({ previous: first, source: 'transcript', message: 'x', resetsAt: '2026-11-06T14:00:00.000Z', window: 'five_hour', autoResumeEnabled: true, policy, now: NOW + 500 });
    expect(completed).toMatchObject({ detectedAt: first.detectedAt, source: 'hook', resetsAt: '2026-11-06T14:00:00.000Z', autoResume: { attempts: 0, mode: 'reset', nextAttemptAt: '2026-11-06T14:02:00.000Z' } });
    const fired: UsageLimit = { ...completed, active: false, autoResume: { ...completed.autoResume!, attempts: 5, outcome: 'fired', nextAttemptAt: null } };
    const again = buildUsageLimit({ previous: fired, source: 'hook', message: null, resetsAt: '2026-11-06T19:00:00.000Z', window: 'five_hour', autoResumeEnabled: true, policy, now: NOW + 3 * 3600_000 });
    expect(again.autoResume).toMatchObject({ attempts: 5, outcome: 'exhausted', nextAttemptAt: null });
    // A fresh stop (no resumption before it) starts from zero.
    const fresh = buildUsageLimit({ previous: { ...fired, autoResume: { ...fired.autoResume!, outcome: 'off' } }, source: 'hook', message: null, resetsAt: '2026-11-06T19:00:00.000Z', window: null, autoResumeEnabled: true, policy, now: NOW });
    expect(fresh.autoResume).toMatchObject({ attempts: 0, outcome: 'scheduled' });
  });

  it('writes the French status of the stop', () => {
    const limit = buildUsageLimit({ previous: null, source: 'hook', message: null, resetsAt: '2026-11-06T14:00:00.000Z', window: 'five_hour', autoResumeEnabled: true, policy, now: NOW });
    expect(usageLimitMessage(limit, NOW)).toBe("Limite d'utilisation atteinte : reprise automatique à 15 h 02.");
    expect(usageLimitMessage({ ...limit, autoResume: { ...limit.autoResume!, outcome: 'off', nextAttemptAt: null } }, NOW)).toBe("Limite d'utilisation atteinte : levée à 15 h 00.");
    expect(usageLimitMessage({ ...limit, resetsAt: null, autoResume: null }, NOW)).toBe("Limite d'utilisation atteinte.");
  });
});

describe.skipIf(!dbReady)('usage limit: detection, automatic resumption, restart (fake CLI, PTY backend)', () => {
  let env: TestEnv;
  let projectId: string;
  let claudeConfig: string;
  const overrides = () => ({ claudeConfigDir: claudeConfig, autoResume: { marginMs: 1000, retryMs: 2000 } });

  const inject = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    env.runner.api.inject({ method, url, headers: { ...auth, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
  const session = async (id: string) => (await inject('GET', `/v1/sessions/${id}`)).json() as SessionDto;
  const events = async (id: string) => ((await inject('GET', `/v1/sessions/${id}/events?limit=500`)).json() as { items: SessionEventItem[] }).items;
  const instructions = async (id: string) => (await events(id)).filter((e) => e.kind === 'instruction').map((e) => (e.payload as { text: string; source: string }));

  async function newSession(branch: string, autoResume: { enabled: boolean; instruction?: string }): Promise<string> {
    const res = await inject('POST', '/v1/sessions', { projectId, title: `Limite ${branch}`, worktree: { mode: 'new', branch: `feature/${branch}` }, launch: { autoResume } });
    expect(res.statusCode).toBe(200);
    return (res.json() as SessionDto).id;
  }
  const limitOf = async (id: string) => (await session(id)).limit ?? null;

  beforeAll(async () => {
    claudeConfig = tmpDir('claude-config-limit');
    mkdirSync(path.join(claudeConfig, 'projects'), { recursive: true });
    env = await startTestRunner(overrides());
    const remote = createBareRemote(env.dirs.remotes, 'nuera-studio/limite');
    const target = path.join(env.dirs.projects, 'limite');
    git(env.dirs.projects, 'clone', remote.bare, target);
    projectId = (await seedProject(env.db, { fullName: 'nuera-studio/limite', path: target, slug: 'limite' })).id;
  }, 600_000);

  afterAll(async () => {
    await env?.close();
  }, 600_000);

  it('records the limit with the reset of the status line, then types the instruction once it is lifted', async () => {
    const id = await newSession('reprise', { enabled: true, instruction: 'Reprends le chantier.' });
    expect((await inject('POST', `/v1/sessions/${id}/instruction`, { text: 'Écris les tests scenario:limit:4' })).statusCode).toBe(200);
    const limit = await waitFor(async () => {
      const l = await limitOf(id);
      return l?.active && l.resetsAt && l.autoResume?.outcome === 'scheduled' ? l : null;
    }, { timeoutMs: 60_000, label: 'limite enregistrée' });
    // First seen by the hook or by the transcript reader (whichever the CLI's writes reach first).
    expect(['hook', 'transcript']).toContain(limit.source);
    expect(limit).toMatchObject({ window: 'five_hour', autoResume: { enabled: true, mode: 'reset', attempts: 0 } });
    expect(limit.message).toContain('5-hour limit reached');
    expect(Date.parse(limit.autoResume!.nextAttemptAt!) - Date.parse(limit.resetsAt!)).toBe(1000);
    const dto = await session(id);
    expect(dto).toMatchObject({ status: 'waiting_input', live: true, errorCode: 'rate_limit' });
    expect(dto.errorMessage).toMatch(/^Limite d'utilisation atteinte : reprise automatique à \d{1,2} h \d{2}\.$/);
    // The CLI's own notice is in the conversation (transcript), next to the hook's error line.
    expect((await events(id)).some((e) => e.kind === 'assistant' && (e.payload as { text: string }).text.startsWith('5-hour limit reached'))).toBe(true);

    // Reset + 1 s: the instruction is typed into the same live CLI; the turn ends normally.
    await waitFor(async () => ((await session(id)).limit === null && (await instructions(id)).length === 2 ? true : null), { timeoutMs: 60_000, label: 'reprise automatique' });
    const typed = await instructions(id);
    expect(typed[1]).toEqual(expect.objectContaining({ text: 'Reprends le chantier.', source: 'nuera' }));
    const items = await events(id);
    expect(items.some((e) => e.kind === 'system' && (e.payload as { message: string }).message === "Reprise automatique après la limite d'utilisation (tentative 1 sur 5)")).toBe(true);
    expect(items.some((e) => e.kind === 'assistant' && (e.payload as { text: string }).text === 'Reçu : Reprends le chantier.')).toBe(true);
    expect((await session(id)).errorCode).toBeNull();
    await inject('POST', `/v1/sessions/${id}/stop`, { force: true });
  }, 180_000);

  it('reschedules from the new reset when the limit is still there, and stops counting at the last attempt', async () => {
    const id = await newSession('encore', { enabled: true });
    await inject('POST', `/v1/sessions/${id}/instruction`, { text: 'scenario:limit:600' });
    // The whole stop is in (transcript notice, status line, StopFailure) before the attempt is forced.
    await waitFor(async () => ((await events(id)).some((e) => e.kind === 'error' && (e.payload as { code: string }).code === 'rate_limit') ? true : null), { timeoutMs: 60_000 });
    const first = await waitFor(async () => ((await limitOf(id))?.autoResume?.outcome === 'scheduled' ? await limitOf(id) : null), { timeoutMs: 60_000 });
    // Bring the attempt forward (as if the CLI's reset had been optimistic).
    await env.db.update(sessions).set({ usageLimit: { ...first, autoResume: { ...first!.autoResume!, nextAttemptAt: new Date().toISOString() } } }).where(eq(sessions.id, id));
    await env.runner.services.sessions.fireAutoResume(id);
    const again = await waitFor(async () => {
      const l = await limitOf(id);
      return l?.active && l.autoResume?.attempts === 1 && l.autoResume.outcome === 'scheduled' ? l : null;
    }, { timeoutMs: 60_000, label: 'limite toujours active' }).catch(async (error: unknown) => {
      console.error(JSON.stringify(await session(id), null, 1), JSON.stringify(await events(id), null, 1).slice(-3000));
      throw error;
    });
    expect(again.detectedAt).not.toBe(first!.detectedAt);
    expect(Date.parse(again.autoResume!.nextAttemptAt!)).toBeGreaterThan(Date.now() + 500_000);
    expect((await instructions(id)).at(-1)).toMatchObject({ text: "Continue là où tu t'es arrêté.", source: 'nuera' });

    // The owner turns it off, then on again (a fresh count); then takes over with an instruction.
    const off = (await inject('POST', `/v1/sessions/${id}/auto-resume`, { enabled: false })).json() as SessionDto;
    expect(off.limit).toMatchObject({ active: true, autoResume: { enabled: false, outcome: 'off', nextAttemptAt: null } });
    expect(off.errorMessage).toMatch(/^Limite d'utilisation atteinte : levée à /);
    const on = (await inject('POST', `/v1/sessions/${id}/auto-resume`, { enabled: true, instruction: 'On reprend.' })).json() as SessionDto;
    expect(on.limit?.autoResume).toMatchObject({ enabled: true, outcome: 'scheduled', attempts: 0 });
    await inject('POST', `/v1/sessions/${id}/instruction`, { text: 'Je reprends la main.' });
    expect((await session(id)).limit).toBeNull();
    await inject('POST', `/v1/sessions/${id}/stop`, { force: true });
  }, 180_000);

  it('answers « introuvable » for an unknown session, without writing anything', async () => {
    const res = await inject('POST', '/v1/sessions/6f1c0b39-0000-4000-8000-0000000000aa/auto-resume', { enabled: true });
    expect(res.statusCode).toBe(404);
  });

  it('survives a runner restart: the conversation is resumed (`claude --resume`) at the scheduled time', async () => {
    const id = await newSession('redemarrage', { enabled: true, instruction: 'Après le redémarrage, continue.' });
    await inject('POST', `/v1/sessions/${id}/instruction`, { text: 'scenario:limit:6' });
    await waitFor(async () => ((await limitOf(id))?.autoResume?.outcome === 'scheduled' ? true : null), { timeoutMs: 60_000 });
    const dirs = env.dirs;
    await env.close({ keepFolders: true });
    // The PTY backend loses the CLI with the runner: the session is interrupted, its schedule kept.
    env = await startTestRunner(overrides(), { dirs });
    const after = await session(id);
    expect(after).toMatchObject({ status: 'interrupted', live: false, limit: { active: true, autoResume: { outcome: 'scheduled' } } });
    await waitFor(async () => {
      const dto = await session(id);
      return dto.limit === null && dto.resumeCount === 1 && (await instructions(id)).some((i) => i.text === 'Après le redémarrage, continue.') ? true : null;
    }, { timeoutMs: 90_000, label: 'reprise après redémarrage' });
    expect((await events(id)).some((e) => e.kind === 'status' && (e.payload as { label: string }).label === 'Session reprise')).toBe(true);
    await inject('POST', `/v1/sessions/${id}/stop`, { force: true });
  }, 240_000);
});
