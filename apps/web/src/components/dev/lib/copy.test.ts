import { describe, expect, it } from 'vitest';
import { stripAnsi, terminalText } from './ansi';
import { commandRunBadge, testCountsMeta } from './commands';
import { basename, formatLineDelta, formatHunkCount, joinParts } from './format';
import { describeBranchStatus, syncBadge, toChangeStatus } from './git';
import { integrationStatusBadge, mcpStatusBadge, projectCountLabel } from './integrations';
import { defaultPermissionOptions, permissionModeLabel, permissionSummary, permissionTitle } from './permission';
import { defaultSessionAction, historyStatusMeta, mostUrgentStatus, sessionBadgeLabel } from './session-status';

const MIN = 60_000;

describe('format', () => {
  it('writes deltas with the minus sign and omits zeros', () => {
    expect(formatLineDelta(46, 12)).toBe('+46 −12');
    expect(formatLineDelta(38, 0)).toBe('+38');
    expect(formatLineDelta(0, 64)).toBe('−64');
    expect(formatLineDelta(0, 0)).toBe('');
  });
  it('joins with middle dots and counts hunks', () => {
    expect(joinParts('a', null, '', 'b')).toBe('a · b');
    expect(formatHunkCount(1)).toBe('1 bloc');
    expect(formatHunkCount(2)).toBe('2 blocs');
    expect(basename('src/modules/crm/PipelineBoard.tsx')).toBe('PipelineBoard.tsx');
  });
});

describe('session status', () => {
  it('builds the Figma badges', () => {
    expect(sessionBadgeLabel('running', 7 * MIN)).toBe('En cours · 7 min');
    expect(sessionBadgeLabel('finished', 18 * MIN)).toBe('Terminée · 18 min');
    expect(sessionBadgeLabel('waiting_permission', 2 * MIN)).toBe('Autorisation demandée');
    expect(sessionBadgeLabel('waiting_permission', null, { short: true })).toBe('Autorisation');
  });
  it('picks the card action', () => {
    expect(defaultSessionAction('waiting_permission')).toEqual({ label: 'Répondre', variant: 'primary' });
    expect(defaultSessionAction('running')).toEqual({ label: 'Ouvrir', variant: 'secondary' });
    expect(defaultSessionAction('interrupted', true).label).toBe('Reprendre');
    expect(defaultSessionAction('finished').label).toBe('Voir le résumé');
  });
  it('maps the history statuses (D06)', () => {
    expect(historyStatusMeta('finished', false)).toMatchObject({ label: 'Terminée', tone: 'success' });
    expect(historyStatusMeta('interrupted', true)).toMatchObject({
      label: 'Interrompue · reprise possible',
      shortLabel: 'Reprise possible',
      tone: 'warn',
      action: { label: 'Reprendre', variant: 'secondary' },
    });
    expect(historyStatusMeta('interrupted', false)).toMatchObject({ label: 'Reprise impossible', tone: 'danger' });
    expect(historyStatusMeta('archived', false).action.label).toBe('Voir');
  });
  it('keeps the most urgent status', () => {
    expect(mostUrgentStatus(['finished', 'running', 'waiting_permission'])).toBe('waiting_permission');
    expect(mostUrgentStatus([])).toBeNull();
  });
});

describe('permission', () => {
  it('builds the CLI options in order', () => {
    expect(defaultPermissionOptions('npm run test').map((o) => o.label)).toEqual([
      'Autoriser',
      'Toujours pour npm run test',
      'Refuser',
    ]);
    expect(defaultPermissionOptions(null)).toHaveLength(2);
  });
  it('writes the collapsed one-liners (203:413, 203:422)', () => {
    expect(permissionSummary('allowed', 'npm run test -- crm', 'Bash')).toBe(
      'Commande autorisée une fois · npm run test -- crm',
    );
    expect(permissionSummary('denied', 'npm run test -- crm', 'Bash')).toBe(
      'Commande refusée · Claude a été prévenu',
    );
    expect(permissionSummary('pending', 'x')).toBeNull();
  });
  it('titles and modes', () => {
    expect(permissionTitle('Bash')).toBe('Claude demande à exécuter une commande');
    expect(permissionModeLabel('manual')).toBe("demander avant d'agir");
    expect(permissionModeLabel('default')).toBe("demander avant d'agir");
  });
});

describe('git', () => {
  it('describes the branch line (D05, W1)', () => {
    expect(describeBranchStatus({ ahead: 2, uncommitted: 4, base: 'main' })).toBe(
      "2 commits d'avance · 4 fichiers non commités",
    );
    expect(describeBranchStatus({ ahead: 0, behind: 0, uncommitted: 0, base: 'main' })).toBe(
      'à jour avec main · aucune modification',
    );
    expect(describeBranchStatus({ ahead: 1, uncommitted: 1 })).toBe("1 commit d'avance · 1 fichier non commité");
  });
  it('never claims « à jour » when git could not be read (null counts)', () => {
    expect(describeBranchStatus({ ahead: null, behind: null, uncommitted: null, base: 'main' })).toBe('');
    expect(describeBranchStatus({ uncommitted: 2, base: 'main' })).toBe('2 fichiers non commités');
  });
  it('maps sync badges (D02 long, D01 short)', () => {
    expect(syncBadge({ state: 'up_to_date' })).toEqual({ label: 'À jour', tone: 'success' });
    expect(syncBadge({ state: 'behind', behind: 2 })).toEqual({ label: '2 commits en retard', tone: 'warn' });
    expect(syncBadge({ state: 'behind', behind: 2 }, 'short')).toEqual({ label: '2 en retard', tone: 'warn' });
    expect(syncBadge({ state: 'ahead', ahead: 2 }, 'short').label).toBe('2 en avance');
    expect(syncBadge({ state: 'up_to_date', conflict: true })).toEqual({ label: 'Conflit à résoudre', tone: 'danger' });
    expect(syncBadge({ state: 'up_to_date', syncing: true }).label).toBe('Synchronisation…');
  });
  it('maps porcelain letters', () => {
    expect(['M', 'A', '?', 'D', 'R', 'T'].map(toChangeStatus)).toEqual(['M', 'A', 'A', 'D', 'R', 'M']);
  });
});

describe('integrations', () => {
  it('maps statuses', () => {
    expect(integrationStatusBadge('expired')).toEqual({ label: 'Expiré', tone: 'danger' });
    expect(mcpStatusBadge('expired')).toEqual({ label: 'Autorisation expirée', tone: 'danger' });
    expect(mcpStatusBadge('expired', 'short').label).toBe('Expiré');
    expect(projectCountLabel(0)).toBe('aucun projet');
    expect(projectCountLabel(1)).toBe('1 projet');
    expect(projectCountLabel(3)).toBe('3 projets');
  });
});

describe('commands', () => {
  const now = new Date('2026-11-04T12:00:00+01:00');
  it('writes the last-run badge (D04)', () => {
    expect(commandRunBadge('install', { status: 'succeeded', at: new Date(now.getTime() - 120 * MIN) }, now)).toEqual({
      label: 'Réussie · il y a 2 h',
      tone: 'success',
    });
    expect(commandRunBadge('dev', { status: 'running', at: now, port: 3000 }, now)).toEqual({
      label: 'En cours · port 3000',
      tone: 'accent',
    });
    expect(
      commandRunBadge('test', { status: 'succeeded', at: new Date(now.getTime() - 5 * MIN), passed: 10, total: 10 }, now)
        .label,
    ).toBe('10 / 10 réussis · il y a 5 min');
    expect(commandRunBadge('build', null, now)).toEqual({ label: 'Aucun lancement', tone: 'neutral' });
  });
  it('writes test meta', () => {
    expect(testCountsMeta(10, 0)).toBe('10 réussis');
    expect(testCountsMeta(8, 2)).toBe('8 réussis · 2 échecs');
  });
});

describe('ansi', () => {
  it('strips escape sequences and resolves carriage returns', () => {
    expect(stripAnsi('\u001b[32m✓\u001b[39m ok')).toBe('✓ ok');
    expect(terminalText('a\r\nb')).toBe('a\nb');
    expect(terminalText('50%\r100%')).toBe('100%');
    expect(terminalText('abcdef\rXY')).toBe('XYcdef');
  });
});
