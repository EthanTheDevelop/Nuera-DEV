/**
 * Pure helpers of the project page (tested in model.test.ts): branch badge / detail line, the
 * command badge input from a stored run, the tabs and their URL values.
 */
import { plural } from '@nuera/shared/format';
import type { BranchBadgeKind, CommandRunSummary } from '@/components/dev';
import { joinParts } from '@/components/dev/lib/format';
import type { BranchView, ProjectDetail, RunView } from '@/server/projects/types';

export const PROJECT_TABS = ['vue-d-ensemble', 'branches', 'environnement', 'claude-md', 'outils-mcp', 'variables', 'sessions'] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];

export function parseTab(value: string | null | undefined): ProjectTab {
  return (PROJECT_TABS as readonly string[]).includes(value ?? '') ? (value as ProjectTab) : 'vue-d-ensemble';
}

export interface TabSpec {
  value: ProjectTab;
  label: string;
  /** M04 label when it differs (« MCP · 2 »). */
  phoneLabel?: string;
  count?: number;
  /** Not offered on the phone (M04: the branch selector replaces it). */
  desktopOnly?: boolean;
}

/** D04 « Vue d'ensemble · Branches · 6 · Environnement · CLAUDE.md · Outils MCP · 2 · Variables · 4 · Sessions · 7 ». */
export function projectTabs(counts: ProjectDetail['counts']): TabSpec[] {
  return [
    { value: 'vue-d-ensemble', label: "Vue d'ensemble" },
    { value: 'branches', label: 'Branches', ...(counts.branches !== null ? { count: counts.branches } : {}), desktopOnly: true },
    { value: 'environnement', label: 'Environnement' },
    { value: 'claude-md', label: 'CLAUDE.md' },
    { value: 'outils-mcp', label: 'Outils MCP', phoneLabel: 'MCP', ...(counts.mcpEnabled !== null ? { count: counts.mcpEnabled } : {}) },
    { value: 'variables', label: 'Variables', count: counts.env },
    { value: 'sessions', label: 'Sessions', count: counts.sessions },
  ];
}

/** One badge per branch, most relevant first (Courante > Session active > Protégée > Fusionnée). */
export function branchBadge(branch: BranchView): BranchBadgeKind | null {
  if (branch.current) return 'current';
  if (branch.sessionId) return 'session';
  if (branch.protected) return 'protected';
  if (branch.merged) return 'merged';
  return null;
}

function upstreamText(branch: BranchView): string | null {
  if (branch.kind === 'remote') return 'sur origin uniquement';
  if (!branch.upstream) return 'pas encore sur origin';
  const ahead = branch.ahead ?? 0;
  const behind = branch.behind ?? 0;
  if (ahead === 0 && behind === 0) return 'à jour avec origin';
  return joinParts(
    ahead > 0 ? `${plural(ahead, 'commit')} d'avance sur origin` : null,
    behind > 0 ? `${plural(behind, 'commit')} de retard` : null,
  );
}

/**
 * D04 Branches detail line: « worktree crm-core · 2 commits d'avance sur origin »,
 * « worktree devis-pdf · une session y travaille », « branche protégée · à jour avec origin »,
 * « fusionnée dans main ». Ahead/behind are measured against origin (the runner's upstream).
 */
export function branchDetail(branch: BranchView, defaultBranch: string): string {
  const worktree = branch.worktreeName ? `worktree ${branch.worktreeName}` : null;
  if (branch.sessionId && !branch.current) return joinParts(worktree, 'une session y travaille');
  if (branch.protected && !branch.current) return joinParts('branche protégée', upstreamText(branch));
  if (branch.merged && !branch.current) return joinParts(worktree, `fusionnée dans ${defaultBranch}`);
  return joinParts(worktree, upstreamText(branch));
}

/** Badge input of `CommandRow` from a stored run (nothing estimated: counts only when parsed). */
export function runSummary(run: RunView | undefined | null): CommandRunSummary | null {
  if (!run) return null;
  // Counts from the stored report, else from the runner's own summary line (« 13 / 13 réussis · 1 échec »).
  const parsed = run.tests ? null : /^(\d+)\s*\/\s*(\d+) réussis(?:\s*·\s*(\d+) échecs?)?/.exec(run.summary ?? '');
  return {
    status: run.status,
    at: run.status === 'running' ? run.startedAt : (run.finishedAt ?? run.startedAt),
    port: run.port,
    passed: run.tests?.passed ?? (parsed ? Number(parsed[1]) : null),
    failed: run.tests?.failed ?? (parsed ? Number(parsed[3] ?? 0) : null),
    total: run.tests?.total ?? (parsed ? Number(parsed[2]) : null),
  };
}

/** First lines of CLAUDE.md for the dark preview (blank lines kept). */
export function claudeMdPreview(content: string | null, maxLines: number): string {
  if (!content) return '';
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  return lines.slice(0, maxLines).join('\n').trimEnd();
}

export const MCP_ICONS: Record<string, 'figma' | 'github' | 'rocket' | 'globe2' | 'plug'> = {
  figma: 'figma',
  github: 'github',
  coolify: 'rocket',
  playwright: 'globe2',
};

export function mcpIcon(name: string): 'figma' | 'github' | 'rocket' | 'globe2' | 'plug' {
  return MCP_ICONS[name.toLowerCase()] ?? 'plug';
}
