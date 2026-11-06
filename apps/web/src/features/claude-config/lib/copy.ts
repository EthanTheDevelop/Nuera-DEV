import type { ClaudeConfigVersionAction } from '@nuera/db/schema';

/**
 * French copy of the « Configuration Claude commune » (lot K1, no Figma frame: built from the design
 * system primitives). Straight apostrophe, « » with inner spaces, `…`.
 */

export const CLAUDE_SECTIONS = [
  { value: 'regles', label: 'Règles' },
  { value: 'skills', label: 'Skills' },
  { value: 'mcp', label: 'MCP' },
  { value: 'permissions', label: 'Permissions' },
  { value: 'historique', label: 'Historique' },
] as const;
export type ClaudeSection = (typeof CLAUDE_SECTIONS)[number]['value'] | 'propositions';

export function parseClaudeSection(value: string | null | undefined): ClaudeSection {
  if (value === 'propositions') return 'propositions';
  return CLAUDE_SECTIONS.some((section) => section.value === value) ? (value as ClaudeSection) : 'regles';
}

export const APPLY_NOTE =
  "Les règles, permissions, variables et serveurs MCP s'appliquent au prochain démarrage ou à la prochaine reprise de chaque session. Les skills sont rechargés par le CLI sans redémarrage.";

export const ENFORCEMENT_OPTIONS = [
  { value: 'default', label: 'Par défaut', description: "Chaque espace peut le désactiver pour lui-même." },
  { value: 'locked', label: 'Imposé', description: 'Toujours appliqué, aucun espace ne peut le désactiver.' },
] as const;

export const AUDIENCE_OPTIONS = [
  { value: 'all', label: 'Tous les comptes' },
  { value: 'admins', label: 'Administrateurs seulement' },
] as const;

export const ACTION_LABELS: Record<ClaudeConfigVersionAction, string> = {
  created: 'créé',
  updated: 'modifié',
  deleted: 'supprimé',
  rolled_back: 'restauré',
  approved: 'approuvé',
};

export const KIND_LABELS = { rule: 'Règle', skill: 'Skill', mcp: 'MCP', policy: 'Permissions' } as const;

export const SCRIPTS_WARNING =
  "Les scripts d'un skill sont écrits, exécutables, sur chaque serveur qui le reçoit : Claude peut les lancer dans ses sessions (après autorisation, selon les permissions). N'autorisez que des scripts relus.";

export const COOLIFY_WARNING =
  "Coolify agit sur la production : ce serveur n'est donné qu'au propriétaire et aux administrateurs. Les outils de lecture sont permis ; lire des secrets, déployer, redémarrer ou modifier passe toujours par une demande d'autorisation ; les outils de suppression restent refusés, sauf si le propriétaire les propose.";

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count > 1 ? many : one}`;
}
