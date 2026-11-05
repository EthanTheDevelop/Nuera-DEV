import { describe, expect, it } from 'vitest';
import type { ProjectSessionView } from '@/server/projects/types';
import { claudeMdModified, detectedCommandsText, freeSpaceText, humanizeRepoName, projectsSubtitle, repoAge, repoMeta, sessionSubline, updatedAgo, validDate } from './format';

const GB = 1024 ** 3;
const NOW = new Date('2026-11-04T10:00:00+01:00');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const DAY = 86_400_000;

describe('copy of the Projets pages', () => {
  it('writes the D02 / M02 subtitles from real counts and disk', () => {
    const disk = { usedBytes: 41 * GB, totalBytes: 160 * GB, freeBytes: 99 * GB };
    expect(projectsSubtitle(5, disk, 'VPS-3', 'long')).toBe('5 dépôts clonés sur VPS-3 · 41 Go utilisés sur 160');
    expect(projectsSubtitle(5, disk, 'VPS-3', 'short')).toBe('5 dépôts sur VPS-3 · 41 Go');
    expect(projectsSubtitle(1, null, 'VPS-3', 'long')).toBe('1 dépôt cloné sur VPS-3');
    expect(freeSpaceText(disk)).toBe('Dossier vide requis. Espace libre : 99 Go sur 160.');
    expect(freeSpaceText(null)).toBe('Dossier vide requis.');
  });

  it('writes the A1 / M03 repository ages', () => {
    expect(repoAge(ago(2 * DAY), NOW)).toBe('il y a 2 j');
    expect(repoAge(ago(7 * DAY), NOW)).toBe('il y a 1 semaine');
    expect(repoAge(ago(21 * DAY), NOW)).toBe('il y a 3 semaines');
    expect(repoAge(ago(21 * DAY), NOW, 'short')).toBe('il y a 3 sem.');
    expect(repoAge(ago(31 * DAY + 5 * DAY), NOW)).toBe('il y a 1 mois');
    expect(repoAge('pas une date', NOW)).toBeNull();
    expect(updatedAgo(ago(2 * DAY), NOW)).toBe('mis à jour il y a 2 jours');
    expect(repoMeta({ private: true, language: 'TypeScript', pushedAt: ago(2 * DAY) }, NOW)).toBe('Privé · TypeScript · il y a 2 j');
  });

  it('humanizes names, lists commands and CLAUDE.md footnote', () => {
    expect(humanizeRepoName('roux-conseil')).toBe('Roux Conseil');
    expect(detectedCommandsText({ dev: 'npm run dev', build: null, test: 'npm test', lint: 'npm run lint' })).toBe('dev · test · lint');
    expect(detectedCommandsText({ dev: null })).toBeNull();
    expect(claudeMdModified('2026-10-28T09:00:00Z', '4c1d0e2abcdef', NOW)).toBe('Modifié le 28 oct. · commit 4c1d0e2.');
    expect(claudeMdModified(null, 'x', NOW)).toBeNull();
    expect(validDate('2026-13-45')).toBeNull();
  });

  it('writes the D04 session sub-lines', () => {
    const base: ProjectSessionView = { id: 'a', title: 't', status: 'running', branch: 'feature/crm-core', worktreeName: 'crm-core', startedAt: ago(12 * 60_000), endedAt: null, lastActivityAt: null, createdAt: ago(DAY), pendingPermissionId: null, resumable: false };
    expect(sessionSubline(base, NOW)).toBe('feature/crm-core · depuis 12 min');
    expect(sessionSubline({ ...base, status: 'waiting_permission' }, NOW)).toBe('feature/crm-core · attend une autorisation');
    expect(sessionSubline({ ...base, status: 'finished', startedAt: '2026-10-19T08:00:00Z', endedAt: '2026-10-19T09:05:00Z' }, NOW)).toBe('19 oct. · terminée · 1 h 05');
  });
});
