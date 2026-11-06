import { describe, expect, it } from 'vitest';
import { buildSessionEnv, isSessionEnvNameAllowed } from './env';
import { canDriveSession } from './access';
import { resolveGitIdentity } from './git-identity';
import { projectUnavailableReason } from './options';
import { capacityMessage, decodeCursor, encodeCursor, likePattern, summaryPoints } from './queries';

describe('session env', () => {
  it('keeps the project variables the runner accepts and drops the protected names', () => {
    expect(isSessionEnvNameAllowed('STRIPE_KEY')).toBe(true);
    for (const name of ['GITHUB_TOKEN', 'git_dir', 'DATABASE_URL', 'ANTHROPIC_API_KEY', 'PATH', 'Path', 'NUERA_X', 'npm_config_x', 'CLAUDE_CONFIG_DIR', '1BAD', 'A-B']) {
      expect(isSessionEnvNameAllowed(name)).toBe(false);
    }
    expect(buildSessionEnv({ A: '1', GITHUB_TOKEN: 'x', B: 'y'.repeat(9000) }, { A: '2', ENABLE_TOOL_SEARCH: 'true' })).toEqual({
      env: { A: '2', ENABLE_TOOL_SEARCH: 'true' },
      skipped: ['GITHUB_TOKEN', 'B'],
    });
  });
});

describe('queries helpers', () => {
  it('words the capacity refusal like the D06 tile, singular included', () => {
    expect(capacityMessage({ active: 1, max: 1 })).toBe("1 session active sur 1 autorisée : arrêtez-en une avant d'en démarrer une autre.");
    expect(capacityMessage({ active: 4, max: 4 })).toBe("4 sessions actives sur 4 autorisées : arrêtez-en une avant d'en démarrer une autre.");
  });

  it('round-trips cursors and rejects forged ones', () => {
    const cursor = { t: '2026-11-04T09:00:00.123456Z', id: '6f1c0b39-9f4c-4c1f-9c2e-8a8a2b0c1d2e' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(decodeCursor(null)).toBeNull();
    expect(() => decodeCursor('abc')).toThrow();
    expect(() => decodeCursor(encodeCursor({ t: "2026-11-04'; drop", id: cursor.id }))).toThrow();
  });

  it('escapes LIKE wildcards', () => {
    expect(likePattern('100%_a\\b')).toBe('%100\\%\\_a\\\\b%');
  });

  it('extracts the bullet points of the final message verbatim', () => {
    const message = "C'est terminé : voici ce qui a changé.\n\n- Tableau du pipeline (PipelineBoard.tsx)\n* Total par étape\n1. 6 tests ajoutés · 10 / 10 réussis\nFin.";
    expect(summaryPoints(message)).toEqual(['Tableau du pipeline (PipelineBoard.tsx)', 'Total par étape', '6 tests ajoutés · 10 / 10 réussis']);
    expect(summaryPoints(null)).toEqual([]);
  });
});

describe('multi-account helpers', () => {
  it('builds the Git identity from Paramètres, else from the account, validated like the runner', () => {
    const account = { name: 'Camille Laurent', email: 'camille@example.test' };
    expect(resolveGitIdentity(account, null)).toEqual({ name: 'Camille Laurent', email: 'camille@example.test' });
    expect(resolveGitIdentity(account, { gitAuthorName: '  Camille L. ', gitAuthorEmail: null })).toEqual({ name: 'Camille L.', email: 'camille@example.test' });
    expect(resolveGitIdentity(account, { gitAuthorName: null, gitAuthorEmail: 'c@atelier.test' })).toEqual({ name: 'Camille Laurent', email: 'c@atelier.test' });
    expect(resolveGitIdentity({ name: '', email: 'x@y.test' }, null)).toEqual({ name: 'x@y.test', email: 'x@y.test' });
    expect(resolveGitIdentity({ name: 'X', email: 'pas une adresse' }, null)).toBeNull();
  });

  it('lets the members of the space drive its sessions, nobody else', () => {
    const space = { id: 'space-a', name: 'Espace', kind: 'personal' as const, role: 'owner' as const };
    expect(canDriveSession({ space }, { spaceId: 'space-a' })).toBe(true);
    expect(canDriveSession({ space: { ...space, role: 'member' } }, { spaceId: 'space-a' })).toBe(true);
    expect(canDriveSession({ space }, { spaceId: 'space-b' })).toBe(false);
  });

  it('names the server holding the project in the « not ready » reasons', () => {
    expect(projectUnavailableReason('cloning', 'VPS-4')).toBe('Clonage en cours sur VPS-4.');
    expect(projectUnavailableReason('error', 'VPS-4')).toBe('Le projet est en erreur : voir sa page.');
    expect(projectUnavailableReason('other', 'VPS-4')).toBe("Le projet n'est pas prêt.");
  });
});
