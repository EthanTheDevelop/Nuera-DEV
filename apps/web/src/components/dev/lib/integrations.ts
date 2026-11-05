/**
 * Status badges of integrations (D01 `Tuile · Intégrations`, D07 GitHub tile) and MCP servers
 * (D07 grid cards, M07 list, D04 `Outils MCP du projet`).
 */
import type { IntegrationStatus, McpStatus } from '@nuera/db';
import { plural } from '@nuera/shared/format';
import type { BadgeTone } from './tones';

export type { IntegrationStatus, McpStatus };

export interface StatusBadge {
  label: string;
  tone: BadgeTone;
}

/** D01: `Connecté` (Succès) / `Expiré` (Danger). */
export function integrationStatusBadge(status: IntegrationStatus): StatusBadge {
  switch (status) {
    case 'connected':
      return { label: 'Connecté', tone: 'success' };
    case 'expiring':
      return { label: 'Expire bientôt', tone: 'warn' };
    case 'expired':
      return { label: 'Expiré', tone: 'danger' };
    case 'error':
      return { label: 'En erreur', tone: 'danger' };
    case 'disconnected':
      return { label: 'Déconnecté', tone: 'neutral' };
    case 'pending':
      return { label: 'À configurer', tone: 'neutral' };
  }
}

/**
 * MCP server status. `long` = D07 card (`Autorisation expirée`), `short` = M07 row (`Expiré`).
 */
export function mcpStatusBadge(status: McpStatus, variant: 'long' | 'short' = 'long'): StatusBadge {
  switch (status) {
    case 'connected':
      return { label: 'Connecté', tone: 'success' };
    case 'needs_auth':
      return { label: variant === 'long' ? 'Connexion requise' : 'À connecter', tone: 'warn' };
    case 'expired':
      return { label: variant === 'long' ? 'Autorisation expirée' : 'Expiré', tone: 'danger' };
    case 'error':
      return { label: variant === 'long' ? 'Ne répond plus' : 'Erreur', tone: 'danger' };
    case 'disabled':
      return { label: 'Désactivé', tone: 'neutral' };
    case 'unknown':
      return { label: 'Non vérifié', tone: 'neutral' };
  }
}

/** D07 Neutre badge: `3 projets`, `1 projet`, `aucun projet`. */
export function projectCountLabel(count: number): string {
  return count <= 0 ? 'aucun projet' : plural(count, 'projet');
}
