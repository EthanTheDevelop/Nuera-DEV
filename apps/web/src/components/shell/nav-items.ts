import type { IconName } from '@/components/icons';

export type NavKey = 'accueil' | 'projets' | 'sessions' | 'integrations' | 'parametres';

export interface NavItem {
  key: NavKey;
  /** Verbatim Figma label. */
  label: string;
  href: string;
  icon: IconName;
  /** Sidebar group: `ESPACE` or `CONFIGURATION`. */
  group: 'ESPACE' | 'CONFIGURATION';
  /** What the destination contains (cover « Navigation et parcours ») — used by the command palette. */
  description: string;
}

/** « NAVIGATION GLOBALE · 5 ENTRÉES », in this exact order. The Workspace is never a nav entry. */
export const NAV_ITEMS: readonly NavItem[] = [
  { key: 'accueil', label: 'Accueil', href: '/', icon: 'home', group: 'ESPACE', description: 'serveur, Claude, reprise rapide' },
  { key: 'projets', label: 'Projets', href: '/projets', icon: 'projets', group: 'ESPACE', description: 'bibliothèque, ajout, détail' },
  { key: 'sessions', label: 'Sessions', href: '/sessions', icon: 'terminal', group: 'ESPACE', description: 'en cours, historique, capacité' },
  { key: 'integrations', label: 'Intégrations', href: '/integrations', icon: 'plug', group: 'CONFIGURATION', description: 'GitHub, serveurs MCP' },
  { key: 'parametres', label: 'Paramètres', href: '/parametres', icon: 'reglages', group: 'CONFIGURATION', description: 'compte, Claude, serveur' },
];

/**
 * Active entry for a pathname. Sub-pages keep their section (D04 keeps « Projets »); the Workspace rail
 * highlights « Sessions » (D05 `Actif=Sessions`).
 */
export function activeNavKey(pathname: string): NavKey | null {
  if (pathname === '/') return 'accueil';
  if (pathname.startsWith('/workspace')) return 'sessions';
  const match = NAV_ITEMS.find((item) => item.href !== '/' && (pathname === item.href || pathname.startsWith(`${item.href}/`)));
  return match?.key ?? null;
}

/** Full-screen phone flows without the tab bar (M03 « Ajouter un projet »). */
export function hidesTabBar(pathname: string): boolean {
  return pathname.startsWith('/projets/nouveau') || pathname.startsWith('/workspace');
}

/** Where « Se reconnecter dans un terminal » (T6) leads: the Claude Code tab of Paramètres. */
export const CLAUDE_RECONNECT_HREF = '/parametres?onglet=claude-code&action=reconnexion';
