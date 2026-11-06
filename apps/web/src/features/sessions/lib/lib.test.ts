import { describe, expect, it } from 'vitest';
import { createSessionInputSchema, historySearch, parseHistoryParams, type SessionListItem } from './contract';
import { capacityLine, existingBranchOptions, newBranchError, permissionModeOptions, suggestBranchName, toCreateInput, worktreeHint, CLI_DEFAULT } from './form';
import { applyStatusEvent, capacityShort, capacityTitle, cardActivity, historyAction, memoryCaption, memoryFreeShort, serverLabel, sessionHref, sortActive, worktreeNotes } from './view';

const GB = 1024 ** 3;

function item(partial: Partial<SessionListItem> & { id: string }): SessionListItem {
  return {
    title: 'Session',
    status: 'running',
    live: true,
    resumable: false,
    resumeBlockedReason: null,
    project: { id: 'p1', name: 'Nuera OS', slug: 'nuera-os', fullName: 'nuera-studio/nuera-os', archived: false },
    branch: 'feature/x',
    worktree: { id: `w-${partial.id}`, name: partial.id, isPrimary: false, present: true },
    permissionMode: 'manual',
    model: null,
    effort: null,
    remoteControl: false,
    currentActivity: null,
    lastInstruction: null,
    pendingPermissionId: null,
    errorMessage: null,
    planDone: null,
    planTotal: null,
    createdAt: '2026-11-04T09:00:00.000Z',
    startedAt: '2026-11-04T09:00:00.000Z',
    endedAt: null,
    lastActivityAt: null,
    archivedAt: null,
    durationMs: null,
    limit: null,
    autoResume: null,
    ...partial,
  };
}

describe('contract', () => {
  it('reads the history URL leniently and writes it without defaults', () => {
    expect(parseHistoryParams(new URLSearchParams('filtre=archivees&periode=7j&q=%20csv%20&projet=nope'))).toEqual({
      filter: 'archivees',
      period: '7j',
      projectId: null,
      q: 'csv',
    });
    expect(parseHistoryParams({ filtre: 'x', periode: ['90j'] })).toMatchObject({ filter: 'toutes', period: '90j' });
    expect(historySearch({ filter: 'toutes', period: '30j', projectId: null, q: '' })).toBe('');
    expect(historySearch({ filter: 'reprise-possible', period: 'tout', projectId: null, q: 'a b' }, new URLSearchParams('x=1&q=old'))).toBe(
      '?x=1&filtre=reprise-possible&periode=tout&q=a+b',
    );
  });

  it('validates the creation body', () => {
    const ok = createSessionInputSchema.parse({ projectId: '6f1c0b39-9f4c-4c1f-9c2e-8a8a2b0c1d2e', branch: { mode: 'new', branch: 'feature/a' }, model: '', instruction: '  ' });
    expect(ok).toMatchObject({ title: 'Nouvelle session', model: null, instruction: undefined });
    expect(() => createSessionInputSchema.parse({ projectId: 'x', branch: { mode: 'primary' } })).toThrow();
    expect(() => createSessionInputSchema.parse({ projectId: '6f1c0b39-9f4c-4c1f-9c2e-8a8a2b0c1d2e', branch: { mode: 'new', branch: 'a..b' } })).toThrow();
    expect(() => createSessionInputSchema.parse({ projectId: '6f1c0b39-9f4c-4c1f-9c2e-8a8a2b0c1d2e', branch: { mode: 'primary' }, effort: 'Très' })).toThrow();
  });
});

describe('form', () => {
  it('suggests and validates branch names', () => {
    expect(suggestBranchName('Export CSV des devis')).toBe('feature/export-csv-des-devis');
    expect(suggestBranchName('Nouvelle session')).toBe('');
    expect(newBranchError('', null)).toBe('Nom de branche requis.');
    expect(newBranchError('feature/a b', null)).toMatch(/invalide/);
    expect(newBranchError('main', [{ name: 'main', kind: 'local', isDefault: true, protected: false, current: true, worktreeName: null, busySessionId: null }])).toMatch(/existe déjà/);
    expect(newBranchError('feature/ok', [])).toBeNull();
    expect(worktreeHint('feature/crm-core', 'main')).toBe('Worktree crm-core créé depuis main.');
  });

  it('builds options and the request body', () => {
    const modes = permissionModeOptions(true);
    expect(modes.map((m) => m.value)).not.toContain('bypassPermissions');
    expect(permissionModeOptions(false).find((m) => m.value === 'bypassPermissions')).toMatchObject({ label: 'Sans autorisation' });
    expect(modes[0]).toMatchObject({ value: 'manual', label: "Demander avant d'agir" });
    const options = existingBranchOptions(
      {
        projectId: 'p',
        defaultBranch: 'main',
        currentBranch: 'main',
        primaryBusy: true,
        branches: [
          { name: 'main', kind: 'local', isDefault: true, protected: false, current: true, worktreeName: null, busySessionId: null },
          { name: 'feature/a', kind: 'local', isDefault: false, protected: false, current: false, worktreeName: 'a', busySessionId: 's1' },
          { name: 'feature/r', kind: 'remote', isDefault: false, protected: false, current: false, worktreeName: null, busySessionId: null },
        ],
      },
      true,
    );
    expect(options.map((o) => [o.value, o.disabled, o.description])).toEqual([
      ['main', true, 'Une session tourne déjà sur cette branche'],
      ['feature/a', true, 'Une session tourne déjà sur cette branche'],
      ['feature/r', false, 'sur origin · nouveau worktree'],
    ]);
    expect(
      toCreateInput({ projectId: 'p', title: ' ', mode: 'new', newBranch: ' feature/a ', base: 'main', existingBranch: '', permissionMode: 'plan', model: ' ', effort: CLI_DEFAULT, remoteControl: true, instruction: '' }),
    ).toEqual({ projectId: 'p', title: 'Nouvelle session', branch: { mode: 'new', branch: 'feature/a', base: 'main' }, permissionMode: 'plan', model: null, effort: null, remoteControl: true });
    expect(capacityLine(2, 4)).toBe('2 sessions actives sur 4 possibles');
    expect(capacityLine(1, 1)).toBe('1 session active sur 1 possible');
  });
});

describe('view', () => {
  it('formats the capacity tile', () => {
    expect(capacityTitle(2, 4)).toBe('2 sessions actives sur 4 autorisées');
    expect(capacityShort(0, 4)).toBe('0 session sur 4');
    const metrics = { cpuPercent: 23.2, memoryUsedBytes: 5.1 * GB, memoryTotalBytes: 16 * GB };
    expect(memoryCaption(metrics)).toBe('Mémoire libre : 10,9 Go sur 16 · processeur 23 %');
    expect(memoryFreeShort(metrics)).toBe('10,9 Go libres');
    expect(memoryCaption(null)).toBeNull();
  });

  it('orders cards per layout and writes the worktree note', () => {
    const items = [item({ id: 'crm-core', status: 'running' }), item({ id: 'devis-pdf', status: 'waiting_permission', pendingPermissionId: 'perm' })];
    expect(sortActive(items, 'desktop').map((i) => i.id)).toEqual(['crm-core', 'devis-pdf']);
    expect(sortActive(items, 'phone').map((i) => i.id)).toEqual(['devis-pdf', 'crm-core']);
    expect(worktreeNotes(items)).toEqual([
      'Les deux sessions de Nuera OS travaillent dans deux worktrees distincts (crm-core, devis-pdf) : elles ne modifient jamais les mêmes fichiers.',
    ]);
    expect(worktreeNotes(items.slice(0, 1))).toEqual([]);
    expect(sessionHref(items[1]!)).toBe('/workspace/devis-pdf#demande-perm');
    expect(sessionHref(items[0]!)).toBe('/workspace/crm-core');
    expect(cardActivity(item({ id: 'n', status: 'new' }))).toBe('Pas encore démarrée · aucune instruction envoyée');
    const limit = {
      active: true,
      detectedAt: '2026-11-04T13:00:00Z',
      resetsAt: '2026-11-04T14:00:00.000Z',
      source: 'hook' as const,
      window: 'five_hour' as const,
      message: null,
      autoResume: { enabled: true, nextAttemptAt: '2026-11-04T14:02:00.000Z', mode: 'reset' as const, attempts: 0, maxAttempts: 5, lastAttemptAt: null, giveUpAt: null, outcome: 'scheduled' as const },
    };
    expect(cardActivity(item({ id: 'l', status: 'waiting_input', limit, lastInstruction: 'Écris les tests' }), '2026-11-04T13:01:00Z')).toBe('Limite atteinte · reprise à 15 h 02');
  });

  it('maps history actions', () => {
    expect(historyAction({ status: 'finished', resumable: true })).toBe('summary');
    expect(historyAction({ status: 'interrupted', resumable: true })).toBe('resume');
    expect(historyAction({ status: 'stopped', resumable: false })).toBe('why');
    expect(historyAction({ status: 'archived', resumable: false })).toBe('view');
  });

  it('applies live status events', () => {
    const items = [item({ id: 'a', status: 'running' })];
    const event = {
      sessionId: 'a',
      projectId: 'p1',
      status: 'waiting_permission' as const,
      live: true,
      currentActivity: 'Attend votre accord',
      lastInstruction: null,
      lastActivityAt: null,
      startedAt: '2026-11-04T09:00:00.000Z',
      endedAt: null,
      planDone: null,
      planTotal: null,
      errorCode: null,
      errorMessage: null,
      cliStatus: null,
      pendingPermissionId: 'perm',
      remoteControlUrl: null,
      queuedInstructions: 0,
    };
    const updated = applyStatusEvent(items, event);
    expect(updated.refresh).toBe(false);
    expect(updated.items[0]).toMatchObject({ status: 'waiting_permission', currentActivity: 'Attend votre accord', pendingPermissionId: 'perm' });
    expect(applyStatusEvent(items, { ...event, status: 'finished', live: false })).toEqual({ items: [], refresh: true });
    expect(applyStatusEvent(items, { ...event, sessionId: 'new-one' }).refresh).toBe(true);
    expect(applyStatusEvent(items, { ...event, sessionId: 'old', status: 'finished' }).refresh).toBe(false);
  });
});

describe('server label', () => {
  it('names the server of the data first, then the shell one, « le serveur » while neither is known', () => {
    expect(serverLabel('VPS-4', 'VPS-3')).toBe('VPS-4');
    expect(serverLabel(null, 'VPS-3')).toBe('VPS-3');
    expect(serverLabel(undefined, '  ')).toBe('le serveur');
  });
});
