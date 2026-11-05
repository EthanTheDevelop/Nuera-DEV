'use client';

import { formatLongDate } from '@nuera/shared/format';
import { formatShortDay } from '@/lib/format';
import { useLiveEvents } from '@/hooks/useLiveEvents';
import { useNow } from '@/hooks/useNow';
import { useShellData } from './ShellContext';
import type { ClaudeState, ServerAvailability } from './types';

/**
 * Availability sentence of the home header, live:
 *  - desktop (D01): « Mercredi 4 novembre 2026 · VPS-3 et Claude Code sont disponibles »
 *  - phone (M01):   « Mer. 4 nov. · tout est disponible »
 * Degraded wordings are not drawn in Figma; they state exactly what the runner reports.
 */
export function availabilitySentence(
  server: string,
  runner: ServerAvailability,
  claude: ClaudeState,
  short: boolean,
): string {
  if (runner === 'unavailable') return `${server} ne répond pas`;
  if (runner === 'unknown') return `connexion à ${server}…`;
  if (claude === 'connected') return short ? 'tout est disponible' : `${server} et Claude Code sont disponibles`;
  const claudeText =
    claude === 'disconnected' || claude === 'wrong_method'
      ? "Claude Code n'est plus connecté"
      : claude === 'not_installed'
        ? "Claude Code n'est pas installé"
        : 'état de Claude Code en cours de vérification';
  return short ? claudeText : `${server} est disponible · ${claudeText}`;
}

export function ShellAvailability({ variant }: { variant: 'long' | 'short' }) {
  const data = useShellData();
  const live = useLiveEvents();
  const now = useNow(60_000, Date.parse(data.generatedAt));
  const date = variant === 'long' ? formatLongDate(now) : formatShortDay(now);
  return (
    <span suppressHydrationWarning>
      {`${date} · ${availabilitySentence(data.server.name, live.runner, live.claude.state, variant === 'short')}`}
    </span>
  );
}
