import { formatPercent, formatRelative, formatUsage } from '@nuera/shared/format';
import type { StatusTone } from '@/components/ui/StatusDot';
import type { ClaudeState, ServerAvailability, ShellMetrics, ShellRole } from './types';

/** « Propriétaire » · « Administrateur » · « Membre » (docs/MULTICOMPTE.md §2). */
export const ROLE_LABELS: Record<ShellRole, string> = {
  owner: 'Propriétaire',
  admin: 'Administrateur',
  member: 'Membre',
};

/**
 * Role line of the user card: « Propriétaire · double facteur actif » (Figma, unchanged for the
 * owner), « Administrateur · double facteur actif », « Membre · double facteur actif ».
 */
export function roleLine(role: ShellRole, twoFactorEnabled: boolean): string {
  return `${ROLE_LABELS[role] ?? ROLE_LABELS.member} · double facteur ${twoFactorEnabled ? 'actif' : 'inactif'}`;
}

/** Server card without a server: what the account sees until an administrator assigns one. */
export const NO_SERVER_LABEL = 'Aucun serveur attribué';
export const NO_SERVER_DETAIL = "en attente d'un administrateur";
/** « Aucun serveur ne vous est encore attribué. Un administrateur doit vous en attribuer un. » */
export const NO_SERVER_MESSAGE = 'Aucun serveur ne vous est encore attribué. Un administrateur doit vous en attribuer un.';

/** « CPU 23 %  ·  RAM 5,1 / 16 Go » — two spaces around the middle dot, as in Figma (white-space: pre). */
export function formatServerMetrics(metrics: ShellMetrics): string {
  return `CPU ${formatPercent(metrics.cpuPercent)}  ·  RAM ${formatUsage(metrics.memoryUsedBytes, metrics.memoryTotalBytes)}`;
}

/** « VPS-3 · OVH Gravelines » (location optional). */
export function serverLabel(name: string, location: string | null): string {
  return location ? `${name} · ${location}` : name;
}

/**
 * « Dernier contact il y a 3 min » (T5), or null when no contact was ever recorded. Under 45 s the
 * relative time is « maintenant », which does not read after « Dernier contact »: « à l’instant ».
 */
export function lastContactText(lastContactAt: string | null, now: number | Date = Date.now()): string | null {
  if (!lastContactAt) return null;
  const relative = formatRelative(lastContactAt, now);
  return `Dernier contact ${relative === 'maintenant' ? "à l'instant" : relative}`;
}

export function serverTone(availability: ServerAvailability): StatusTone {
  return availability === 'available' ? 'success' : availability === 'unavailable' ? 'danger' : 'neutral';
}

/**
 * Claude CLI line of the server card. « Claude Code connecté » is Figma copy; the other states are the
 * honest readings of `claude auth status` (T6 is « Claude Code déconnecté »).
 */
export function claudeLine(state: ClaudeState, serverAvailability: ServerAvailability): { text: string; tone: StatusTone } {
  if (serverAvailability === 'unavailable') return { text: 'Claude Code injoignable', tone: 'neutral' };
  switch (state) {
    case 'connected':
      return { text: 'Claude Code connecté', tone: 'success' };
    case 'disconnected':
      return { text: 'Claude Code déconnecté', tone: 'warn' };
    case 'wrong_method':
      return { text: "Claude Code connecté par clé d'API", tone: 'warn' };
    case 'not_installed':
      return { text: 'Claude Code non installé', tone: 'danger' };
    case 'error':
      return { text: 'Claude Code : état illisible', tone: 'warn' };
    case 'unknown':
      return { text: 'Claude Code : vérification…', tone: 'neutral' };
  }
}
