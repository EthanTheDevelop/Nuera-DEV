import { describe, expect, it } from 'vitest';
import type { BranchView, RunView } from '@/server/projects/types';
import { branchBadge, branchDetail, claudeMdPreview, mcpIcon, parseTab, projectTabs, runSummary } from './model';

const branch = (over: Partial<BranchView>): BranchView => ({
  name: 'feature/x', kind: 'local', current: false, protected: false, merged: false, isDefault: false, upstream: 'origin/feature/x', ahead: 0, behind: 0, committedAt: null, subject: '', worktreeId: null, worktreeName: null, sessionId: null, ...over,
});

describe('project page model', () => {
  it('parses the tab of ?onglet=', () => {
    expect(parseTab('variables')).toBe('variables');
    expect(parseTab('inconnu')).toBe('vue-d-ensemble');
    expect(parseTab(null)).toBe('vue-d-ensemble');
    const tabs = projectTabs({ branches: 6, mcpEnabled: 2, env: 4, sessions: 7 });
    expect(tabs.map((t) => `${t.label}${t.count ? ` · ${t.count}` : ''}`)).toEqual(["Vue d'ensemble", 'Branches · 6', 'Environnement', 'CLAUDE.md', 'Outils MCP · 2', 'Variables · 4', 'Sessions · 7']);
    expect(tabs.find((t) => t.value === 'outils-mcp')?.phoneLabel).toBe('MCP');
  });

  it('picks one badge and the D04 detail line per branch', () => {
    expect(branchBadge(branch({ current: true, protected: true }))).toBe('current');
    expect(branchBadge(branch({ sessionId: 's' }))).toBe('session');
    expect(branchBadge(branch({ protected: true }))).toBe('protected');
    expect(branchBadge(branch({ merged: true }))).toBe('merged');
    expect(branchDetail(branch({ current: true, worktreeName: 'crm-core', ahead: 2 }), 'main')).toBe("worktree crm-core · 2 commits d'avance sur origin");
    expect(branchDetail(branch({ sessionId: 's', worktreeName: 'devis-pdf' }), 'main')).toBe('worktree devis-pdf · une session y travaille');
    expect(branchDetail(branch({ name: 'main', protected: true }), 'main')).toBe('branche protégée · à jour avec origin');
    expect(branchDetail(branch({ merged: true }), 'main')).toBe('fusionnée dans main');
    expect(branchDetail(branch({ kind: 'remote' }), 'main')).toBe('sur origin uniquement');
  });

  it('reads test counts from the report or from the runner summary', () => {
    const run: RunView = { id: 'r', kind: 'test', command: 'npm run test', status: 'failed', exitCode: 1, port: null, summary: '6 / 7 réussis · 1 échec', worktreeId: null, worktreeName: null, startedAt: '2026-11-04T09:00:00Z', finishedAt: '2026-11-04T09:01:00Z', tests: null };
    expect(runSummary(run)).toMatchObject({ status: 'failed', passed: 6, failed: 1, total: 7, at: '2026-11-04T09:01:00Z' });
    expect(runSummary({ ...run, tests: { passed: 10, failed: 0, skipped: 0, total: 10 } })).toMatchObject({ passed: 10, total: 10 });
    expect(runSummary({ ...run, summary: null })).toMatchObject({ passed: null, total: null });
    expect(runSummary(null)).toBeNull();
  });

  it('keeps blank lines in the CLAUDE.md preview and maps MCP icons', () => {
    expect(claudeMdPreview('# A\n\n## B\nc\nd', 3)).toBe('# A\n\n## B');
    expect(mcpIcon('Coolify')).toBe('rocket');
    expect(mcpIcon('autre')).toBe('plug');
  });
});
