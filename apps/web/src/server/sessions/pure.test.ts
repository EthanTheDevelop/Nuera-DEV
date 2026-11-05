import { describe, expect, it } from 'vitest';
import { buildSessionEnv, isSessionEnvNameAllowed } from './env';
import { decodeCursor, encodeCursor, likePattern, summaryPoints } from './queries';

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
