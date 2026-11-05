import { describe, expect, it } from 'vitest';
import { activeNavKey, hidesTabBar, NAV_ITEMS } from './nav-items';
import { availabilitySentence } from './ShellAvailability';
import { claudeLine, formatServerMetrics, lastContactText, serverLabel, serverTone } from './status-text';

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
