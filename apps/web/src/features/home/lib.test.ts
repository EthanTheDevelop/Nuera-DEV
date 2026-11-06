import { describe, expect, it } from 'vitest';
import type { SessionStatusEvent } from '@nuera/shared/events';
import {
  applySessionStatus,
  capacityLabel,
  cardActivity,
  claudeBadge,
  claudeNote,
  claudePill,
  firstSteps,
  firstStepsVisible,
  lowerFirst,
  pendingAlert,
  pickQuickResume,
  progressLine,
  serverBadge,
  serverFooter,
  serverMeters,
  serverPill,
  sortActiveSessions,
  uptimeText,
} from './lib';
import type { HomeSession } from './types';

const GB = 1024 ** 3;

function session(overrides: Partial<HomeSession> = {}): HomeSession {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Module CRM · pipeline',
    status: 'running',
    live: true,
    resumable: false,
    projectId: '00000000-0000-4000-8000-0000000000aa',
    projectName: 'Nuera OS',
    branch: 'feature/crm-core',
    worktreeName: 'crm-core',
    permissionMode: 'manual',
    currentActivity: 'Écrit les tests de pipeline-totals.ts',
    lastInstruction: 'Termine le module pipeline du CRM',
    planDone: 3,
    planTotal: 5,
    createdAt: '2026-11-04T09:00:00.000Z',
    startedAt: '2026-11-04T09:00:05.000Z',
    lastActivityAt: '2026-11-04T09:10:00.000Z',
    pendingPermission: null,
    ...overrides,
  };
}

function statusEvent(overrides: Partial<SessionStatusEvent> = {}): SessionStatusEvent {
  return {
    sessionId: '00000000-0000-4000-8000-000000000001',
    projectId: '00000000-0000-4000-8000-0000000000aa',
    status: 'running',
    live: true,
    currentActivity: 'Lance les tests',
    lastInstruction: 'Termine le module pipeline du CRM',
    lastActivityAt: '2026-11-04T09:12:00.000Z',
    startedAt: '2026-11-04T09:00:05.000Z',
    endedAt: null,
    planDone: 4,
    planTotal: 5,
    errorCode: null,
    errorMessage: null,
    cliStatus: null,
    pendingPermissionId: null,
    remoteControlUrl: null,
    queuedInstructions: 0,
    ...overrides,
  };
}

describe('Accueil · copie', () => {
  it('écrit la ligne de plan de Figma', () => {
    expect(progressLine(session())).toBe('Plan 3 / 5 · écrit les tests de pipeline-totals.ts');
    expect(progressLine(session({ planTotal: null, planDone: null }))).toBe('Écrit les tests de pipeline-totals.ts');
    expect(progressLine(session({ currentActivity: null }))).toBe('Plan 3 / 5');
    expect(progressLine(session({ currentActivity: null, planTotal: null }))).toBeNull();
  });

  it('ne met pas en minuscule un sigle', () => {
    expect(lowerFirst('CSV exporté')).toBe('CSV exporté');
    expect(lowerFirst('Écrit')).toBe('écrit');
  });

  it("annonce la demande d'autorisation sur la carte", () => {
    const pending = { id: 'p', sessionId: 's', sessionTitle: 'Tests e2e du devis', projectName: 'Nuera OS', target: 'npm run test -- crm', isCommand: true, title: 'Claude demande à exécuter une commande', createdAt: '2026-11-04T09:00:00.000Z' };
    expect(cardActivity(session({ status: 'waiting_permission', pendingPermission: pending }))).toBe('Attend votre accord pour npm run test -- crm');
    expect(cardActivity(session())).toBe('Écrit les tests de pipeline-totals.ts');
    expect(pendingAlert([pending])).toBe('Tests e2e du devis attend votre autorisation');
    expect(pendingAlert([pending, { ...pending, id: 'q', sessionId: 't' }])).toBe('2 sessions attendent votre autorisation');
    expect(pendingAlert([])).toBeNull();
  });

  it('accorde la capacité', () => {
    expect(capacityLabel(2, 4)).toBe('sessions actives sur 4 possibles');
    expect(capacityLabel(1, 4)).toBe('session active sur 4 possibles');
    expect(capacityLabel(0, 1)).toBe('session active sur 1 possible');
  });

  it('dit seulement ce que le CLI expose', () => {
    expect(claudeNote({ state: 'connected', plan: 'max', defaultModel: null }, 'available')).toBe(
      'CLI officiel connecté au compte Claude · formule Max · modèle : défaut du CLI. Nuera Dev ne stocke aucun identifiant.',
    );
    expect(claudeNote({ state: 'connected', plan: null, defaultModel: 'opus' }, 'available')).toBe(
      'CLI officiel connecté au compte Claude · modèle : opus. Nuera Dev ne stocke aucun identifiant.',
    );
    expect(claudeBadge('connected', 1, 'available')).toEqual({ label: 'Attention requise', tone: 'warn' });
    expect(claudeBadge('connected', 0, 'available')).toEqual({ label: 'Connecté', tone: 'success' });
    expect(claudeBadge('disconnected', 0, 'available').tone).toBe('warn');
    expect(claudeBadge('connected', 0, 'unavailable').label).toBe('Injoignable');
    expect(claudePill('connected', 'available').label).toBe('Claude Code connecté');
  });

  it('décrit le serveur', () => {
    expect(serverBadge('available')).toEqual({ label: 'En ligne', tone: 'success' });
    expect(serverPill('VPS-3', 'available').label).toBe('VPS-3 en ligne');
    expect(uptimeText(18 * 86_400 + 5)).toBe('18 j');
    expect(uptimeText(7_300)).toBe('2 h');
    expect(uptimeText(20)).toBe('1 min');
    const now = Date.parse('2026-11-04T10:00:00.000Z');
    expect(serverFooter({ location: 'OVH Gravelines', availability: 'available', uptimeSec: 18 * 86_400, lastContactAt: null, now })).toBe('OVH Gravelines · en ligne depuis 18 j');
    expect(serverFooter({ location: null, availability: 'unavailable', uptimeSec: null, lastContactAt: '2026-11-04T09:57:00.000Z', now })).toBe('dernier contact il y a 3 min');
    expect(serverFooter({ location: null, availability: 'unavailable', uptimeSec: null, lastContactAt: 'pas une date', now })).toBe('aucun contact récent');
    const meters = serverMeters({ cpuPercent: 23.4, memoryUsedBytes: 5.1 * GB, memoryTotalBytes: 16 * GB, diskUsedBytes: 61 * GB, diskTotalBytes: 160 * GB, sampledAt: '' });
    expect(meters.cpu.valueLabel).toBe('23 %');
    expect(meters.memory.valueLabel).toBe('5,1 / 16 Go');
    expect(meters.disk.valueLabel).toBe('61 / 160 Go');
    expect(serverMeters(null).cpu).toEqual({ valueLabel: '—', percent: null });
  });
});

describe('Accueil · ordre et reprise', () => {
  it("place d'abord la demande d'autorisation, puis la plus récente", () => {
    const a = session({ id: 'a', lastActivityAt: '2026-11-04T09:20:00.000Z' });
    const b = session({ id: 'b', status: 'waiting_permission', lastActivityAt: '2026-11-04T09:00:00.000Z' });
    const c = session({ id: 'c', lastActivityAt: '2026-11-04T09:30:00.000Z' });
    expect(sortActiveSessions([a, b, c]).map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it("reprend la dernière session active qui n'attend pas déjà une autorisation", () => {
    const a = session({ id: 'a', status: 'waiting_permission', lastActivityAt: '2026-11-04T09:30:00.000Z' });
    const b = session({ id: 'b', lastActivityAt: '2026-11-04T09:20:00.000Z' });
    expect(pickQuickResume([a, b])?.id).toBe('b');
    expect(pickQuickResume([a])?.id).toBe('a');
    expect(pickQuickResume([])).toBeNull();
  });
});

describe('Accueil · mises à jour en direct', () => {
  it('met à jour une carte sur place', () => {
    const next = applySessionStatus([session()], statusEvent());
    expect(next?.[0]).toMatchObject({ currentActivity: 'Lance les tests', planDone: 4 });
  });

  it('relit les données quand une session entre, sort ou demande une autorisation', () => {
    expect(applySessionStatus([session()], statusEvent({ sessionId: '00000000-0000-4000-8000-000000000009' }))).toBeNull();
    expect(applySessionStatus([session()], statusEvent({ status: 'finished', live: false }))).toBeNull();
    expect(applySessionStatus([session()], statusEvent({ status: 'waiting_permission', pendingPermissionId: '00000000-0000-4000-8000-00000000000f' }))).toBeNull();
    // An unknown session that is not active changes nothing.
    expect(applySessionStatus([session()], statusEvent({ sessionId: '00000000-0000-4000-8000-000000000009', status: 'finished' }))).toHaveLength(1);
  });

  it("retire la demande répondue", () => {
    const pending = { id: 'p', sessionId: 's', sessionTitle: 'x', projectName: 'y', target: 'npm test', isCommand: true, title: 't', createdAt: '2026-11-04T09:00:00.000Z' };
    const next = applySessionStatus([session({ status: 'waiting_permission', pendingPermission: pending })], statusEvent());
    expect(next?.[0]?.pendingPermission).toBeNull();
    expect(next?.[0]?.status).toBe('running');
  });
});

describe('premiers pas', () => {
  const server = { name: 'VPS-3', availability: 'available' as const };
  const states = (steps: ReturnType<typeof firstSteps>) => steps.map((step) => [step.id, step.state]);

  it('se masque quand Claude Code, GitHub et un projet sont en place', () => {
    const steps = firstSteps({ server, claudeState: 'connected', onboarding: { github: true, project: true } });
    expect(states(steps)).toEqual([
      ['claude', 'done'],
      ['github', 'done'],
      ['project', 'done'],
    ]);
    expect(firstStepsVisible(steps)).toBe(false);
  });

  it('propose seulement ce qui reste vraiment à faire, avec son action', () => {
    const steps = firstSteps({ server, claudeState: 'disconnected', onboarding: { github: false, project: false } });
    expect(states(steps)).toEqual([
      ['claude', 'todo'],
      ['github', 'todo'],
      ['project', 'todo'],
    ]);
    expect(steps.map((step) => step.action?.label)).toEqual(['Se connecter dans un terminal', 'Ouvrir Intégrations', 'Ajouter un projet']);
    expect(steps[2]?.text).toBe('Clonez un dépôt GitHub sur VPS-3, prêt pour Claude Code.');
    expect(firstStepsVisible(steps)).toBe(true);
  });

  it("n'invente rien quand un état n'a pas pu être lu", () => {
    const steps = firstSteps({ server: { name: 'VPS-3', availability: 'unavailable' }, claudeState: 'unknown', onboarding: { github: null, project: true } });
    expect(states(steps)).toEqual([
      ['claude', 'unknown'],
      ['github', 'unknown'],
      ['project', 'done'],
    ]);
    expect(steps.every((step) => step.action === null)).toBe(true);
    expect(firstStepsVisible(steps)).toBe(false);
  });

  it("reste masquée pour un espace qui a déjà travaillé, même si le CLI se déconnecte (T6 s'en charge)", () => {
    const onboarding = { github: true, project: true, session: true };
    const steps = firstSteps({ server, claudeState: 'disconnected', onboarding });
    expect(states(steps)[0]).toEqual(['claude', 'todo']);
    expect(firstStepsVisible(steps, onboarding)).toBe(false);
    // Never a session yet: the step is still offered.
    expect(firstStepsVisible(steps, { ...onboarding, session: false })).toBe(true);
  });

  it('sans serveur, attend un administrateur pour Claude Code et le premier projet', () => {
    const steps = firstSteps({ server: null, claudeState: 'unknown', onboarding: { github: true, project: false } });
    expect(states(steps)).toEqual([
      ['claude', 'blocked'],
      ['github', 'done'],
      ['project', 'blocked'],
    ]);
    expect(steps[0]?.text).toBe("Disponible dès qu'un administrateur vous attribue un serveur.");
    expect(steps.filter((step) => step.state === 'blocked').every((step) => step.action === null)).toBe(true);
    expect(firstStepsVisible(steps)).toBe(true);
  });
});
