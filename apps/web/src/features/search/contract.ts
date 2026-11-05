/**
 * Global search (command palette ⌘K / Ctrl K) — contract of GET /api/search and the pure matching of
 * the navigation actions. Used by `@/server/search` and the browser provider (`GlobalSearch`).
 */
import type { ProjectStatus, SessionStatus } from '@nuera/db';
import type { IconName } from '@/components/icons';

export interface SearchProjectResult {
  id: string;
  name: string;
  /** GitHub `owner/repo`. */
  fullName: string;
  /** Primary clone on the server. */
  path: string;
  status: ProjectStatus;
  href: string;
}

export interface SearchSessionResult {
  id: string;
  title: string;
  status: SessionStatus;
  projectName: string;
  branch: string | null;
  href: string;
}

export interface SearchAction {
  id: string;
  label: string;
  description: string;
  icon: IconName;
  href: string;
  /** Extra words that find the action (without accents, lower case). */
  keywords: readonly string[];
}

export interface SearchResults {
  /** The normalised query the results answer. */
  query: string;
  projects: SearchProjectResult[];
  sessions: SearchSessionResult[];
  actions: SearchAction[];
}

/** Destinations reachable from the palette besides the 5 sections (each one is a real route). */
export const SEARCH_ACTIONS: readonly SearchAction[] = [
  {
    id: 'ajouter-projet',
    label: 'Ajouter un projet',
    description: 'Cloner un dépôt GitHub sur le serveur',
    icon: 'plus',
    href: '/projets/nouveau',
    keywords: ['nouveau projet', 'cloner', 'depot', 'github', 'importer'],
  },
  {
    id: 'projets-favoris',
    label: 'Projets favoris',
    description: 'Projets',
    icon: 'star',
    href: '/projets?filtre=favoris',
    keywords: ['favori', 'etoile'],
  },
  {
    id: 'projets-archives',
    label: 'Projets archivés',
    description: 'Projets',
    icon: 'archive',
    href: '/projets?filtre=archives',
    keywords: ['archive', 'archives'],
  },
  {
    id: 'sessions-reprise',
    label: 'Sessions à reprendre',
    description: 'Historique · reprise possible',
    icon: 'play',
    href: '/sessions?filtre=reprise-possible',
    keywords: ['reprendre', 'reprise', 'interrompue', 'resume'],
  },
  {
    id: 'sessions-terminees',
    label: 'Sessions terminées',
    description: 'Historique des sessions',
    icon: 'history',
    href: '/sessions?filtre=terminees',
    keywords: ['historique', 'terminee', 'fini'],
  },
  {
    id: 'serveurs-mcp',
    label: 'Serveurs MCP',
    description: 'Intégrations',
    icon: 'plug',
    href: '/integrations',
    keywords: ['mcp', 'figma', 'coolify', 'github', 'integration', 'connecteur'],
  },
];

/** Lower case, accents removed, spaces collapsed (« Créé » → « cree »). */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Query as searched (trimmed, inner spaces collapsed). */
export function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim();
}

/** Actions whose label, description or keywords contain every word of the query. */
export function matchActions(query: string, actions: readonly SearchAction[] = SEARCH_ACTIONS): SearchAction[] {
  const words = fold(query).split(' ').filter(Boolean);
  if (words.length === 0) return [];
  return actions.filter((action) => {
    const haystack = fold([action.label, action.description, ...action.keywords].join(' '));
    return words.every((word) => haystack.includes(word));
  });
}
