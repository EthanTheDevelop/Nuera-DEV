import 'server-only';
import { plural } from '@nuera/shared/format';
import type { HomeIntegrationRow, HomeIntegrations } from '@/features/home/types';
import type { IntegrationsOverview } from '@/server/integrations';

/**
 * `Tuile · Intégrations` (D01): GitHub, then the MCP servers enabled in a project (those needing attention first),
 * at most 4 rows, plus the footer sentence of the most urgent problem. Built from
 * `getIntegrationsOverview(ctx)` of the account's space (database only, no network call). GitHub is
 * one row with the aggregate status of the space's sources (the worst one), as in Figma.
 */

export const INTEGRATION_ROWS = 4;

type Badge = HomeIntegrationRow['badge'];

const GITHUB_BADGES: Record<IntegrationsOverview['github']['status'], Badge> = {
  not_configured: { label: 'À configurer', tone: 'neutral' },
  pending: { label: 'À installer', tone: 'neutral' },
  connected: { label: 'Connecté', tone: 'success' },
  expiring: { label: 'Expire bientôt', tone: 'warn' },
  expired: { label: 'Expiré', tone: 'danger' },
  error: { label: 'En erreur', tone: 'danger' },
};

const MCP_BADGES: Record<string, Badge> = {
  connected: { label: 'Connecté', tone: 'success' },
  needs_auth: { label: 'À connecter', tone: 'warn' },
  expired: { label: 'Expiré', tone: 'danger' },
  error: { label: 'Erreur', tone: 'danger' },
  disabled: { label: 'Désactivé', tone: 'neutral' },
  unknown: { label: 'Non vérifié', tone: 'neutral' },
};

const ATTENTION = new Set(['expired', 'error', 'needs_auth', 'expiring']);
const KNOWN_ICONS = new Set(['figma', 'github', 'rocket', 'globe2', 'plug', 'server', 'monitor', 'book', 'sparkle']);

/** « serveur MCP » / « serveur MCP · développement » (Coolify only ever reaches development, by design). */
function mcpDetail(preset: string | null): string {
  return preset === 'coolify' ? 'serveur MCP · développement' : 'serveur MCP';
}

/** Footer: « Coolify : reconnecter pour relancer les déploiements de développement. » (D01). */
export function integrationFooter(overview: Pick<IntegrationsOverview, 'diagnostics' | 'mcp'>): HomeIntegrations['footer'] {
  const banner = overview.diagnostics.find((d) => d.tone === 'danger') ?? overview.diagnostics[0];
  if (!banner) return null;
  const reconnect = banner.actions.find((a) => a.kind === 'reconnect' && a.href?.startsWith('/'));
  const href = reconnect?.href ?? '/integrations';
  const coolify = banner.target === 'coolify' || banner.target === 'mcp:coolify';
  // One banner per failing GitHub source (target `github:<sourceId>`), or the legacy `github`.
  const github = banner.target === 'github' || banner.target.startsWith('github:');
  const label =
    github
      ? 'GitHub'
      : banner.target === 'coolify'
        ? 'Coolify'
        : (overview.mcp.servers.find((s) => `mcp:${s.name}` === banner.target)?.label ?? banner.target.replace(/^mcp:/, ''));
  if (banner.tone === 'warn') return { text: `${label} : autorisation bientôt expirée, renouvelez-la.`, href };
  if (coolify) return { text: 'Coolify : reconnecter pour relancer les déploiements de développement.', href };
  if (github) return { text: "GitHub : rétablir l'accès pour cloner, pousser et ouvrir des pull requests.", href };
  return { text: `${label} : reconnecter pour rétablir l'accès des sessions.`, href };
}

export function buildIntegrations(overview: Pick<IntegrationsOverview, 'github' | 'mcp' | 'diagnostics' | 'attention'>): HomeIntegrations {
  const github = overview.github;
  const githubRow: HomeIntegrationRow = {
    id: 'github',
    name: 'GitHub',
    icon: 'github',
    detail:
      github.status === 'not_configured'
        ? 'application GitHub non connectée'
        : typeof github.repoCount === 'number'
          ? `${plural(github.repoCount, 'dépôt')} ${github.repoCount >= 2 ? 'accessibles' : 'accessible'}`
          : null,
    badge: GITHUB_BADGES[github.status],
    href: '/integrations',
  };
  const enabled = overview.mcp.servers.filter((server) => server.displayStatus !== 'disabled');
  const servers = enabled
    .map((server, index) => ({ server, index }))
    .sort((a, b) => Number(ATTENTION.has(b.server.displayStatus)) - Number(ATTENTION.has(a.server.displayStatus)) || a.index - b.index)
    .map(({ server }): HomeIntegrationRow => ({
      id: `mcp:${server.name}`,
      name: server.label,
      icon: server.icon && KNOWN_ICONS.has(server.icon) ? server.icon : 'plug',
      detail: mcpDetail(server.preset),
      badge: MCP_BADGES[server.displayStatus] ?? MCP_BADGES.unknown!,
      href: `/integrations/mcp/${encodeURIComponent(server.name)}`,
    }));
  return {
    rows: [githubRow, ...servers].slice(0, INTEGRATION_ROWS),
    footer: integrationFooter(overview),
    attentionCount: overview.attention.count,
    inactiveMcp: overview.mcp.servers.length - enabled.length,
  };
}
