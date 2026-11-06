import type { BadgeTone } from '@/components/ui';
import { formatDateTimeShort, formatRelative, plural } from '@nuera/shared/format';
import type { AdminServerView } from '@/server/admin';

/**
 * French copy of the administration (screens without Figma frame, docs/MULTICOMPTE.md §10): built
 * from the existing primitives, straight apostrophe, « » with inner spaces.
 */

export const ADMIN_TABS = [
  { value: 'comptes', label: 'Comptes' },
  { value: 'serveurs', label: 'Serveurs' },
  { value: 'instance', label: 'Instance' },
  { value: 'claude', label: 'Claude' },
  { value: 'journal', label: 'Journal' },
] as const;

export type AdminTab = (typeof ADMIN_TABS)[number]['value'];

export function parseAdminTab(value: string | null | undefined): AdminTab {
  return ADMIN_TABS.some((tab) => tab.value === value) ? (value as AdminTab) : 'comptes';
}

export const ROLE_LABELS = { owner: 'Propriétaire', admin: 'Administrateur', member: 'Membre' } as const;
export const ROLE_TONES: Record<keyof typeof ROLE_LABELS, BadgeTone> = { owner: 'accent', admin: 'accent', member: 'neutral' };

export const VALIDITY_OPTIONS = [
  { value: '24', label: '24 h' },
  { value: '48', label: '48 h' },
  { value: '168', label: '7 jours' },
] as const;

/** « il y a 2 h », « jamais ». */
export function lastSeenText(value: string | null, now: string): string {
  return value ? formatRelative(value, now) : 'jamais';
}

export function expiresText(value: string, now: string): string {
  return new Date(value).getTime() <= new Date(now).getTime() ? `a expiré ${formatDateTimeShort(value, now)}` : `expire ${formatDateTimeShort(value, now)}`;
}

/**
 * State of a server from its row: « En ligne » only when its heartbeat (every 60 s) is recent; an older
 * contact is shown as such (« Vérifier la connexion » gives the live answer) — never a guessed failure.
 */
export function serverHealth(server: Pick<AdminServerView, 'status' | 'lastSeenAt'>, now: string): { tone: BadgeTone; label: string } {
  if (server.status === 'retired') return { tone: 'neutral', label: 'Retiré' };
  if (server.status === 'suspended') return { tone: 'warn', label: 'Suspendu' };
  if (!server.lastSeenAt) return { tone: 'neutral', label: 'Jamais joint' };
  const age = new Date(now).getTime() - new Date(server.lastSeenAt).getTime();
  return age <= 3 * 60_000 ? { tone: 'success', label: 'En ligne' } : { tone: 'neutral', label: serverStatusLabel(server.status) };
}

export function serverStatusLabel(status: AdminServerView['status']): string {
  return { pending: 'Libre', active: 'Attribué', suspended: 'Suspendu', retired: 'Retiré' }[status];
}

export function claudeText(installed: boolean | null): string {
  if (installed === null) return '—';
  return installed ? 'Installé' : 'Non installé';
}

export function liveSessionsOption(count: number): string {
  return `Arrêter aussi ses sessions Claude Code en cours (${count})`;
}

export function accessesText(count: number): string {
  return count === 0 ? 'aucun accès ouvert' : plural(count, 'accès ouvert', 'accès ouverts');
}

export const SERVER_FOOTNOTE =
  "Chaque serveur a sa propre connexion Claude Code : la personne qui l'utilise s'y connecte avec son propre compte Claude, dans un terminal. Nuera Dev ne stocke aucun identifiant.";

export const BREAK_GLASS_HELP =
  "Sans administrateur disponible (propriétaire qui a perdu son téléphone et ses codes), un lien de récupération se crée sur le serveur : pnpm --filter @nuera/db cli recovery-link --email <adresse> (en production : docker compose run --rm -e APP_URL=<url> migrate node_modules/.bin/tsx src/cli/recovery-link.ts --email <adresse>). L'événement apparaît ici.";
