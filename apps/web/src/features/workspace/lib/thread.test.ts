import type { PermissionRequestDto, SessionEventItem } from '@nuera/shared/runner';
import { describe, expect, it } from 'vitest';
import { commitCtaLabel } from '../commit/useCommitFlow';
import { shortPath } from '../review/ReviewMode';
import {
  bulletPoints,
  canPrepareCommit,
  composerStateFor,
  defaultPanel,
  formatFileSize,
  headerMeta,
  newSessionSuggestions,
  orderedItems,
  permissionCardStatus,
  permissionOptionsOf,
  persistenceContextFor,
  reconcilePending,
  upsertItems,
} from './thread';

const SESSION = '11111111-1111-4111-8111-111111111111';
const at = '2026-11-05T10:42:00.000Z';

function instruction(id: number, position: number, version: number, text: string, when = at): SessionEventItem {
  return { id, sessionId: SESSION, position, version, key: null, createdAt: when, updatedAt: when, kind: 'instruction', payload: { text, source: 'nuera', at: when } };
}
function tool(version: number, status: 'running' | 'done'): SessionEventItem {
  return {
    id: 9,
    sessionId: SESSION,
    position: 2,
    version,
    key: 'tool:abc',
    createdAt: at,
    updatedAt: at,
    kind: 'tool',
    payload: {
      toolUseId: 'abc',
      tool: 'Edit',
      target: 'src/a.ts',
      status,
      meta: null,
      summary: null,
      output: null,
      outputTruncated: false,
      error: null,
      permissionId: null,
      subagent: null,
      startedAt: at,
      finishedAt: null,
    },
  };
}

describe('conversation store', () => {
  it('upserts by key and version, orders by position', () => {
    let map = upsertItems(new Map(), [tool(3, 'running'), instruction(1, 1, 1, 'Bonjour')]);
    map = upsertItems(map, [tool(5, 'done')]);
    map = upsertItems(map, [tool(4, 'running')]); // older version ignored
    const items = orderedItems(map);
    expect(items.map((i) => i.kind)).toEqual(['instruction', 'tool']);
    expect(items[1]!.kind === 'tool' && items[1]!.payload.status).toBe('done');
    expect(upsertItems(map, [])).toBe(map);
  });

  it('drops local echoes once the CLI reports the instruction', () => {
    const pending = [
      { localId: 'a', text: 'Ajoute un test', at, queued: true },
      { localId: 'b', text: 'Ajoute un test', at, queued: true },
    ];
    expect(reconcilePending(pending, [instruction(1, 1, 1, 'Ajoute un test ')])).toEqual([pending[1]]);
    // An older identical instruction does not count.
    expect(reconcilePending([pending[0]!], [instruction(1, 1, 1, 'Ajoute un test', '2026-11-05T09:00:00.000Z')])).toHaveLength(1);
  });
});

describe('session state copy', () => {
  const base = { reconnecting: false, claudeBlocked: false, worktreeMissing: false, resumable: true };
  it('picks the composer variant (Prêt / En cours / Attente / W7 / T6)', () => {
    expect(composerStateFor({ ...base, status: 'new' }).state).toBe('ready');
    expect(composerStateFor({ ...base, status: 'running' }).state).toBe('running');
    expect(composerStateFor({ ...base, status: 'waiting_permission' }).state).toBe('waiting_permission');
    expect(composerStateFor({ ...base, status: 'finished' }).state).toBe('ready');
    expect(composerStateFor({ ...base, status: 'interrupted', resumable: false }).state).toBe('unavailable');
    expect(composerStateFor({ ...base, status: 'running', reconnecting: true }).state).toBe('reconnecting');
    expect(composerStateFor({ ...base, status: 'running', claudeBlocked: true }).state).toBe('unavailable');
  });

  it('writes the header meta of D05 / W1 / W3', () => {
    const now = Date.parse('2026-11-05T10:54:00.000Z');
    expect(headerMeta({ status: 'new', backend: 'tmux', startedAt: null, endedAt: null }, 'VPS-3', now)).toBe('pas encore démarrée');
    expect(headerMeta({ status: 'running', backend: 'tmux', startedAt: at, endedAt: null }, 'VPS-3', now)).toBe('tmux · 12 min · vit sur VPS-3');
    expect(headerMeta({ status: 'finished', backend: 'tmux', startedAt: at, endedAt: '2026-11-05T10:00:00.000Z' }, 'VPS-3', now)).toBe('tmux · terminée à 11:00');
  });

  it('builds the persistence context', () => {
    expect(persistenceContextFor({ status: 'new', host: 'VPS-3', reconnecting: false, lastSignalSeconds: 0, permissionPending: false })).toEqual({ kind: 'new' });
    expect(persistenceContextFor({ status: 'waiting_input', host: 'VPS-3', reconnecting: false, lastSignalSeconds: 0, permissionPending: false })).toEqual({ kind: 'live', host: 'VPS-3' });
    expect(persistenceContextFor({ status: 'finished', host: 'VPS-3', reconnecting: true, lastSignalSeconds: 12, permissionPending: true })).toEqual({
      kind: 'reconnecting',
      lastSignalSeconds: 12,
      permissionPending: true,
    });
  });

  it('chooses the default panel and the Git availability', () => {
    expect(defaultPanel('new', 3)).toBe('fichiers');
    expect(defaultPanel('running', 0)).toBe('fichiers');
    expect(defaultPanel('running', 4)).toBe('modifications');
    expect(canPrepareCommit({ worktreePresent: true, changedFiles: 0, branch: { ahead: 0, upstream: null } })).toBe(false);
    expect(canPrepareCommit({ worktreePresent: true, changedFiles: 0, branch: { ahead: 2, upstream: null } })).toBe(true);
    expect(canPrepareCommit({ worktreePresent: true, changedFiles: 0, branch: { ahead: 2, upstream: { ahead: 0 } } })).toBe(false);
    expect(canPrepareCommit({ worktreePresent: false, changedFiles: 3, branch: null })).toBe(false);
  });
});

describe('permission card', () => {
  const payload = { permissionId: '22222222-2222-4222-8222-222222222222', status: 'answered_in_terminal' as const };
  const open = { id: payload.permissionId } as PermissionRequestDto;
  it('keeps a request moved to the terminal open while the CLI waits', () => {
    expect(permissionCardStatus(payload, 'waiting_permission', open)).toBe('expired');
    expect(permissionCardStatus(payload, 'running', null)).toBe('answered_in_terminal');
    expect(permissionCardStatus({ ...payload, status: 'pending' }, 'finished', null)).toBe('cancelled');
  });
  it('maps the CLI options (max 3, its order)', () => {
    expect(
      permissionOptionsOf({
        options: [
          { id: 'allow', label: 'Autoriser' },
          { id: 'allow_always', label: 'Toujours pour npm run test' },
          { id: 'deny', label: 'Refuser' },
        ],
      }).map((o) => `${o.kind}:${o.label}`),
    ).toEqual(['allow:Autoriser', 'allow_always:Toujours pour npm run test', 'deny:Refuser']);
  });
});

describe('W1 / W3 / W4 / W5 helpers', () => {
  it('only proposes what the project has', () => {
    expect(newSessionSuggestions({ hasClaudeMd: false, testCommand: null })).toHaveLength(1);
    expect(newSessionSuggestions({ hasClaudeMd: true, testCommand: 'npm run test' }).map((s) => s.label)).toContain('Lance les tests du projet et résume les échecs');
  });
  it('reads the bullets of the final message verbatim', () => {
    expect(bulletPoints('Voici :\n- Tableau du pipeline\n* Totaux\n1. Tests\ntexte')).toEqual(['Tableau du pipeline', 'Totaux', 'Tests']);
  });
  it('formats sizes and labels', () => {
    expect(formatFileSize(4198)).toBe('4,1 Ko');
    expect(formatFileSize(212)).toBe('212 o');
    expect(formatFileSize(null)).toBeNull();
    expect(shortPath('src/modules/crm/PipelineBoard.tsx')).toBe('crm/PipelineBoard.tsx');
    expect(commitCtaLabel({ files: 4, push: true, openPr: true })).toBe('Committer et ouvrir la PR');
    expect(commitCtaLabel({ files: 4, push: true, openPr: false })).toBe('Committer et pousser');
    expect(commitCtaLabel({ files: 0, push: true, openPr: false })).toBe('Pousser');
  });
});
