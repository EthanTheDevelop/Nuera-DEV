import type { IconName } from '@/components/icons';
import type { ShellRole } from './types';

export type NavKey = 'accueil' | 'projets' | 'sessions' | 'integrations' | 'parametres' | 'administration';

export interface NavItem {
  key: NavKey;
  /** Verbatim Figma label. */
  label: string;
  href: string;
  icon: IconName;
  /** Sidebar group: `ESPACE`, `CONFIGURATION`, or `INSTANCE` (owner and administrators only). */
  group: 'ESPACE' | 'CONFIGURATION' | 'INSTANCE';
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
 * « Administration » (docs/MULTICOMPTE.md §10): accounts, servers, instance settings and journal —
 * owner and administrators only (the page answers 404 to the others). Not a Figma entry: its own
 * « INSTANCE » group in the sidebar, an entry of the rail, of the profile menu and of ⌘K; on the
 * phone, the tab bar keeps its 5 Figma tabs (Paramètres leads there).
 */
export const ADMIN_NAV_ITEM: NavItem = {
  key: 'administration',
  label: 'Administration',
  href: '/administration',
  icon: 'shield',
  group: 'INSTANCE',
  description: 'comptes, serveurs, instance, journal',
};

/** True for the owner and the administrators of the instance. */
export function isAdminRole(role: ShellRole): boolean {
  return role === 'owner' || role === 'admin';
}

/** Entries an account may see: the 5 Figma entries, plus « Administration » for owner / admins. */
export function navItemsFor(role: ShellRole): readonly NavItem[] {
  return isAdminRole(role) ? [...NAV_ITEMS, ADMIN_NAV_ITEM] : NAV_ITEMS;
}

/**
 * Active entry for a pathname. Sub-pages keep their section (D04 keeps « Projets »); the Workspace rail
 * highlights « Sessions » (D05 `Actif=Sessions`).
 */
export function activeNavKey(pathname: string): NavKey | null {
  if (pathname === '/') return 'accueil';
  if (pathname.startsWith('/workspace')) return 'sessions';
  const match = [...NAV_ITEMS, ADMIN_NAV_ITEM].find((item) => item.href !== '/' && (pathname === item.href || pathname.startsWith(`${item.href}/`)));
  return match?.key ?? null;
}

/** Tab of the phone tab bar for a pathname: Administration is reached from Paramètres. */
export function tabBarActiveKey(pathname: string): NavKey | null {
  const key = activeNavKey(pathname);
  return key === 'administration' ? 'parametres' : key;
}

/**
 * Pages never replaced by T5 (« Serveur indisponible »): they do not need the runner, and an
 * administrator whose own server is down must still reach the console (docs/MULTICOMPTE.md §10).
 * A banner says the server does not answer instead. Paramètres' default tab is kept too: it is the
 * only way to Compte et sécurité and Préférences (desktop tab strip, phone overview groups), and each
 * of its sections already says inline when the server does not answer. The Claude Code and Serveur
 * tabs stay under T5.
 */
export function isRunnerIndependentPage(pathname: string, tab: string | null): boolean {
  if (pathname === '/administration' || pathname.startsWith('/administration/')) return true;
  if (pathname === '/parametres/notification') return true;
  return pathname === '/parametres' && (tab === null || tab === '' || tab === 'vue-d-ensemble' || tab === 'compte-et-securite' || tab === 'preferences');
}

/** Full-screen phone flows without the tab bar (M03 « Ajouter un projet »). */
export function hidesTabBar(pathname: string): boolean {
  return pathname.startsWith('/projets/nouveau') || pathname.startsWith('/workspace');
}

/** Where « Se reconnecter dans un terminal » (T6) leads: the Claude Code tab of Paramètres. */
export const CLAUDE_RECONNECT_HREF = '/parametres?onglet=claude-code&action=reconnexion';
