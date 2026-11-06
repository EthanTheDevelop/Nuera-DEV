import { describe, expect, it } from 'vitest';
import { administrationGroup, navigationGroup } from './CommandPalette';
import { activeNavKey, hidesTabBar, isRunnerIndependentPage, NAV_ITEMS, navItemsFor, tabBarActiveKey } from './nav-items';
import { availabilitySentence } from './ShellAvailability';
import { claudeLine, formatServerMetrics, lastContactText, roleLine, serverLabel, serverTone } from './status-text';

const GB = 1024 ** 3;

describe('server card texts', () => {
  it('prints CPU and RAM with two spaces around the middle dot (Figma white-space: pre)', () => {
    const text = formatServerMetrics({
      cpuPercent: 23,
      memoryUsedBytes: 5.1 * GB,
      memoryTotalBytes: 16 * GB,
      diskUsedBytes: null,
      diskTotalBytes: null,
      sampledAt: '2026-11-04T10:00:00.000Z',
    });
    expect(text).toBe('CPU 23 %  ·  RAM 5,1 / 16 Go');
  });

  it('labels the server with its location when known', () => {
    expect(serverLabel('srv', 'Datacenter A')).toBe('srv · Datacenter A');
    expect(serverLabel('srv', null)).toBe('srv');
  });

  it('formats the last contact as a relative time, or nothing', () => {
    const now = Date.parse('2026-11-04T10:03:00.000Z');
    expect(lastContactText('2026-11-04T10:00:00.000Z', now)).toBe('Dernier contact il y a 3 min');
    expect(lastContactText('2026-11-04T10:02:40.000Z', now)).toBe("Dernier contact à l'instant");
    expect(lastContactText(null, now)).toBeNull();
  });

  it('maps availability and Claude states to honest lines', () => {
    expect(serverTone('available')).toBe('success');
    expect(serverTone('unavailable')).toBe('danger');
    expect(claudeLine('connected', 'available')).toEqual({ text: 'Claude Code connecté', tone: 'success' });
    expect(claudeLine('disconnected', 'available').tone).toBe('warn');
    expect(claudeLine('connected', 'unavailable').tone).toBe('neutral');
  });
});

describe('navigation', () => {
  it('keeps the five Figma entries in order', () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual(['Accueil', 'Projets', 'Sessions', 'Intégrations', 'Paramètres']);
  });

  it('derives the active entry from the path (sub-pages keep their section, Workspace = Sessions)', () => {
    expect(activeNavKey('/')).toBe('accueil');
    expect(activeNavKey('/projets/abc')).toBe('projets');
    expect(activeNavKey('/projetsx')).toBeNull();
    expect(activeNavKey('/workspace/123')).toBe('sessions');
    expect(activeNavKey('/parametres')).toBe('parametres');
  });

  it('hides the tab bar on full-screen flows', () => {
    expect(hidesTabBar('/projets/nouveau')).toBe(true);
    expect(hidesTabBar('/workspace/1')).toBe(true);
    expect(hidesTabBar('/projets')).toBe(false);
  });
});

describe('availability sentence', () => {
  it('uses the Figma copy when everything is up', () => {
    expect(availabilitySentence('VPS-3', 'available', 'connected', false)).toBe('VPS-3 et Claude Code sont disponibles');
    expect(availabilitySentence('VPS-3', 'available', 'connected', true)).toBe('tout est disponible');
  });

  it('states what is down otherwise', () => {
    expect(availabilitySentence('VPS-3', 'unavailable', 'connected', false)).toBe('VPS-3 ne répond pas');
    expect(availabilitySentence('VPS-3', 'available', 'disconnected', false)).toContain("Claude Code n'est plus connecté");
  });
});

describe('multi-account shell', () => {
  it('adds « Administration » (group INSTANCE) for the owner and administrators only', () => {
    expect(navItemsFor('member').map((i) => i.label)).toEqual(['Accueil', 'Projets', 'Sessions', 'Intégrations', 'Paramètres']);
    for (const role of ['owner', 'admin'] as const) {
      const items = navItemsFor(role);
      expect(items.map((i) => i.label)).toEqual(['Accueil', 'Projets', 'Sessions', 'Intégrations', 'Paramètres', 'Administration']);
      expect(items.at(-1)).toMatchObject({ href: '/administration', group: 'INSTANCE' });
    }
  });

  it('builds the ⌘K groups from the role', () => {
    expect(navigationGroup('member').items.map((i) => i.href)).not.toContain('/administration');
    expect(navigationGroup('admin').items.map((i) => i.href)).toContain('/administration');
    expect(administrationGroup('member')).toBeNull();
    expect(administrationGroup('owner')?.items.map((i) => i.href)).toEqual([
      '/administration?onglet=comptes',
      '/administration?onglet=serveurs',
      '/administration?onglet=instance',
      '/administration?onglet=journal',
      '/administration?onglet=comptes&inviter=1',
      '/administration?onglet=serveurs&ajout=1',
    ]);
  });

  it('highlights Administration on desktop and Paramètres in the phone tab bar (5 tabs kept)', () => {
    expect(activeNavKey('/administration')).toBe('administration');
    expect(activeNavKey('/administration/x')).toBe('administration');
    expect(tabBarActiveKey('/administration')).toBe('parametres');
    expect(tabBarActiveKey('/sessions')).toBe('sessions');
    expect(activeNavKey('/administrationx')).toBeNull();
  });

  it('never lets T5 replace Administration, Compte et sécurité or Préférences', () => {
    expect(isRunnerIndependentPage('/administration', null)).toBe(true);
    expect(isRunnerIndependentPage('/administration', 'serveurs')).toBe(true);
    expect(isRunnerIndependentPage('/parametres', 'compte-et-securite')).toBe(true);
    expect(isRunnerIndependentPage('/parametres', 'preferences')).toBe(true);
    expect(isRunnerIndependentPage('/parametres/notification', null)).toBe(true);
    // The default tab is the way to both (desktop tab strip, phone overview): never replaced either.
    expect(isRunnerIndependentPage('/parametres', null)).toBe(true);
    expect(isRunnerIndependentPage('/parametres', 'vue-d-ensemble')).toBe(true);
    expect(isRunnerIndependentPage('/parametres', 'serveur')).toBe(false);
    expect(isRunnerIndependentPage('/parametres', 'claude-code')).toBe(false);
    expect(isRunnerIndependentPage('/', null)).toBe(false);
    expect(isRunnerIndependentPage('/sessions', 'preferences')).toBe(false);
  });

  it('labels the account by its role (Figma copy kept for the owner)', () => {
    expect(roleLine('owner', true)).toBe('Propriétaire · double facteur actif');
    expect(roleLine('admin', true)).toBe('Administrateur · double facteur actif');
    expect(roleLine('member', true)).toBe('Membre · double facteur actif');
    expect(roleLine('member', false)).toBe('Membre · double facteur inactif');
  });

  it('says « aucun serveur » instead of a server state when none is assigned', () => {
    expect(availabilitySentence(null, 'unknown', 'unknown', false)).toBe('aucun serveur attribué');
    expect(availabilitySentence(null, 'unavailable', 'unknown', true)).toBe('aucun serveur');
  });
});
