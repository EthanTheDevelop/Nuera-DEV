import { describe, expect, it } from 'vitest';
import {
  accessPolicyText,
  claudeBadge,
  formatAvailability,
  formatIn,
  freedSpaceText,
  formatJournalDate,
  liveSessionsCaption,
  modelOptions,
  permissionModeOptions,
  planLabel,
  removeWorktreesLabel,
  removeWorktreesTitle,
  serverBadge,
  serviceRows,
  staleWorktreesCaption,
  twoFactorCaption,
  uptimeBarDays,
  uptimeCaption,
  webSessionCaption,
} from './copy';
import { hasExplicitTab, parseSettingsTab, settingsHref } from './tabs';
import type { ClaudeCliView, RunnerHealthView, WebSessionView } from './types';

const NOW = '2026-11-05T11:00:00.000Z'; // 12:00 in Paris

const claude = (patch: Partial<ClaudeCliView> = {}): ClaudeCliView => ({
  checkedAt: NOW,
  state: 'connected',
  installed: true,
  version: '2.1.999',
  loggedIn: true,
  authMethod: 'claude.ai',
  subscriptionType: 'max',
  loginExpiresAt: null,
  error: null,
  ...patch,
});

const health = (patch: Partial<RunnerHealthView> = {}): RunnerHealthView => ({
  ok: true,
  version: '0.1.0',
  startedAt: '2026-11-05T10:00:00.000Z',
  backend: 'tmux',
  git: { available: true, version: 'git version 2.43.0', error: null },
  tmux: { available: true, version: 'tmux 3.4', error: null },
  claude: { available: true, version: '2.1.999', error: null },
  database: { ok: true, error: null },
  disk: null,
  projectsRoot: '/srv/dev',
  ...patch,
});

describe('Claude Code copy', () => {
  it('shows the plan only as the CLI reports it (D08 desktop / M08 phone)', () => {
    expect(claudeBadge(claude())).toEqual({ tone: 'success', label: 'Connecté · formule Max' });
    expect(claudeBadge(claude(), 'phone')).toEqual({ tone: 'success', label: 'Connecté · Max' });
    expect(claudeBadge(claude({ subscriptionType: null })).label).toBe('Connecté');
    expect(claudeBadge(claude({ state: 'disconnected' }))).toEqual({ tone: 'warn', label: 'Déconnecté' });
    expect(claudeBadge(null).label).toBe('État inconnu');
    expect(planLabel('pro')).toBe('Pro');
    expect(planLabel('ultra')).toBe('ultra');
    expect(planLabel(null)).toBeNull();
  });

  it('never offers the bypass mode while it is blocked', () => {
    expect(permissionModeOptions(true).map((o) => o.value)).not.toContain('bypassPermissions');
    expect(permissionModeOptions(false).map((o) => o.value)).toContain('bypassPermissions');
    expect(permissionModeOptions(true)[0]).toMatchObject({ value: 'manual', label: "Demander avant d'agir" });
  });

  it('lists the CLI default, the documented aliases, the models seen in sessions, the custom value', () => {
    const options = modelOptions('claude-custom-1', [{ id: 'claude-opus-4-1', displayName: 'Opus 4.1' }, { id: 'opus', displayName: 'Opus' }]);
    expect(options.map((o) => o.value)).toEqual(['__cli__', 'opus', 'sonnet', 'haiku', 'claude-opus-4-1', 'claude-custom-1', '__autre__']);
    expect(options[0]!.label).toBe('Défaut du CLI');
  });
});

describe('Compte et sécurité copy', () => {
  it('writes the 2FA and policy sentences of D08', () => {
    expect(twoFactorCaption(8)).toBe("Application d'authentification · 8 codes de secours restants");
    expect(twoFactorCaption(1)).toBe("Application d'authentification · 1 code de secours restant");
    expect(twoFactorCaption(null)).toBe("Application d'authentification");
    expect(accessPolicyText(12, 30)).toBe("Un accès expire après 12 h d'inactivité, et au plus tard après 30 jours.");
  });

  it('captions devices like D08 (location · time · expiry when close)', () => {
    const base: WebSessionView = {
      id: 's',
      deviceLabel: 'PC Windows · Chrome',
      deviceKind: 'desktop',
      location: 'Lyon',
      current: false,
      createdAt: '2026-11-03T10:00:00.000Z',
      lastActiveAt: '2026-11-04T17:04:00.000Z',
      expiresAt: '2026-11-05T17:00:00.000Z',
    };
    expect(webSessionCaption(base, NOW, 12)).toBe('Lyon · hier 18:04 · expire dans 6 h');
    expect(webSessionCaption({ ...base, current: true }, NOW, 12)).toBe('Lyon · maintenant');
    expect(webSessionCaption({ ...base, lastActiveAt: '2026-11-05T09:00:00.000Z', expiresAt: '2026-11-05T21:00:00.000Z' }, NOW, 12)).toBe('Lyon · il y a 2 h');
    expect(webSessionCaption({ ...base, lastActiveAt: 'not a date', location: null }, NOW, 12)).toBe('expire dans 6 h');
    expect(formatIn('2026-11-08T11:00:00.000Z', NOW)).toBe('dans 3 j');
  });

  it('dates the journal as D08: time today, « hier HH:MM », then the short date', () => {
    expect(formatJournalDate('2026-11-05T09:42:00.000Z', NOW)).toBe('10:42');
    expect(formatJournalDate('2026-11-04T17:04:00.000Z', NOW)).toBe('hier 18:04');
    expect(formatJournalDate('2026-11-02T09:00:00.000Z', NOW)).toBe('2 nov.');
    expect(formatJournalDate('invalide', NOW)).toBe('');
  });
});

describe('Serveur copy', () => {
  it('describes services from what the runner reports only', () => {
    const rows = serviceRows({ health: health(), live: { count: 2, names: ['crm-core', 'devis-pdf'] }, webStartedAt: '2026-10-18T11:00:00.000Z', now: NOW, runnerUnavailable: false });
    expect(rows.map((r) => r.title)).toEqual(['Sessions Claude Code', 'Application Nuera Dev', "Runner d'exécution", 'Base de données']);
    expect(rows[0]!.caption).toBe('2 processus tmux · crm-core, devis-pdf');
    expect(rows[1]!.caption).toBe('en ligne · redémarrée il y a 18 j');
    expect(serviceRows({ health: null, live: null, webStartedAt: NOW, now: NOW, runnerUnavailable: true }).map((r) => r.tone)).toEqual(['danger', 'success', 'danger']);
    const detailed = serviceRows({ health: health({ backend: 'pty' }), live: null, webStartedAt: NOW, now: NOW, runnerUnavailable: false, detailed: true });
    expect(detailed.find((r) => r.key === 'backend')).toMatchObject({ tone: 'warn' });
    expect(liveSessionsCaption({ count: 0, names: [] }, 'pty')).toBe('aucun processus PTY en cours');
  });

  it('badges the server and formats availability like D08', () => {
    expect(serverBadge(health(), false)).toEqual({ tone: 'success', label: 'En ligne' });
    expect(serverBadge(health({ database: { ok: false, error: 'x' } }), false).label).toBe('Dégradé');
    expect(serverBadge(null, true).label).toBe('Hors ligne');
    expect(formatAvailability(99.95)).toBe('99,95 %');
    expect(formatAvailability(100)).toBe('100 %');
    expect(formatAvailability(null)).toBe('—');
  });

  it('turns runner days into bars and the last incident into the caption', () => {
    const uptime = {
      availabilityPercent: 99.95,
      days: [
        { day: '2026-10-27', availability: 100, incidents: [] },
        { day: '2026-10-28', availability: 99.86, incidents: [{ start: '2026-10-28T08:40:00.000Z', end: '2026-10-28T08:42:00.000Z', reason: 'Runner indisponible (arrêt ou redémarrage)' }] },
        { day: '2026-10-29', availability: null, incidents: [] },
      ],
    };
    expect(uptimeBarDays(uptime).map((d) => [d.availability, d.incident])).toEqual([
      [1, false],
      [0.9986, true],
      [null, false],
    ]);
    expect(uptimeCaption(uptime, NOW)).toBe("28 oct. · runner indisponible (arrêt ou redémarrage), 2 min d'indisponibilité.");
    expect(uptimeCaption({ availabilityPercent: null, days: [{ day: '2026-11-05', availability: null, incidents: [] }] }, NOW)).toContain('Aucune mesure');
  });

  it('counts inactive worktrees with French plurals (T8)', () => {
    expect(staleWorktreesCaption({ staleDays: 30, items: [], unreadable: [] })).toBe('aucun worktree sans session depuis 30 jours');
    expect(removeWorktreesLabel(2)).toBe('Supprimer 2 worktrees');
    expect(removeWorktreesTitle(2)).toBe('Supprimer 2 worktrees inactifs ?');
    expect(removeWorktreesTitle(1)).toBe('Supprimer 1 worktree inactif ?');
  });

  it('shows measured sizes only when every one is known (D08 « · 2,4 Go », T8 « Libère 1,8 Go sur VPS-3. »)', () => {
    const item = (sizeBytes: number | null) => ({
      id: crypto.randomUUID(),
      name: 'w',
      branch: 'b',
      projectId: 'p',
      projectName: 'P',
      lastActivityAt: '2026-10-01T10:00:00.000Z',
      dirtyFiles: 0,
      eligible: true,
      excludedReason: null,
      sizeBytes,
    });
    const GB = 1024 ** 3;
    expect(staleWorktreesCaption({ staleDays: 30, items: [item(1.4 * GB), item(1 * GB), item(0)], unreadable: [] })).toBe('3 worktrees sans session depuis 30 jours · 2,4 Go');
    expect(staleWorktreesCaption({ staleDays: 30, items: [item(1.4 * GB), item(null)], unreadable: [] })).toBe('2 worktrees sans session depuis 30 jours');
    expect(freedSpaceText([item(0.8 * GB), item(1 * GB)], 'VPS-3')).toBe('Libère 1,8 Go sur VPS-3.');
    expect(freedSpaceText([item(0.8 * GB), item(null)], 'VPS-3')).toBeNull();
    expect(freedSpaceText([], 'VPS-3')).toBeNull();
  });
});

describe('tabs', () => {
  it('parses ?onglet= (the CLAUDE_RECONNECT_HREF target included)', () => {
    expect(parseSettingsTab('claude-code')).toBe('claude-code');
    expect(parseSettingsTab(['serveur'])).toBe('serveur');
    expect(parseSettingsTab('inconnu')).toBe('vue-d-ensemble');
    expect(hasExplicitTab('vue-d-ensemble')).toBe(false);
    expect(hasExplicitTab('preferences')).toBe(true);
    expect(settingsHref('compte-et-securite', 'journal-de-securite')).toBe('/parametres?onglet=compte-et-securite#journal-de-securite');
    expect(settingsHref('vue-d-ensemble')).toBe('/parametres');
  });
});
