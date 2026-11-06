'use client';

import { cn } from '@/lib/cn';
import { StatusDot } from '@/components/ui/StatusDot';
import { useNow } from '@/hooks/useNow';
import { claudeLine, formatServerMetrics, lastContactText, NO_SERVER_DETAIL, NO_SERVER_LABEL, serverLabel, serverTone } from './status-text';
import type { ClaudeState, ServerAvailability, ShellMetrics } from './types';

export interface ServerCardProps {
  /** « VPS-3 » (name of the server of the account's space); null when no server is assigned. */
  name: string | null;
  /** « OVH Gravelines » (location of that server). */
  location: string | null;
  availability: ServerAvailability;
  metrics: ShellMetrics | null;
  claudeState: ClaudeState;
  lastContactAt: string | null;
  className?: string;
}

/**
 * Sidebar « État du serveur » card (inside the dark sidebar scope): surface-raised-dark, radius 12,
 * padding 12, gap 8 — dot + « VPS-3 · OVH Gravelines » (Outfit 600 13 paper), « CPU 23 %  ·  RAM 5,1 / 16 Go »
 * (JetBrains Mono 11 accent-on-dark), dot + « Claude Code connecté » (Outfit 12 accent-on-dark).
 * T5: the dot turns danger and the metrics line becomes the last contact. Without a server: neutral
 * dot, « Aucun serveur attribué » and « en attente d'un administrateur » (no Claude line: there is no
 * CLI to report). Props only (live data comes from the shell).
 */
export function ServerCard({ name, location, availability, metrics, claudeState, lastContactAt, className }: ServerCardProps) {
  const now = useNow(30_000);
  if (name === null) {
    return (
      <section aria-label="État du serveur" className={cn('flex flex-col gap-2 rounded-md bg-surface-raised p-3', className)}>
        <p className="m-0 flex min-w-0 items-center gap-2">
          <StatusDot tone="neutral" />
          <span className="truncate font-sans text-app-13 font-semibold text-text">{NO_SERVER_LABEL}</span>
        </p>
        <p className="m-0 font-mono text-app-11 text-accent">{NO_SERVER_DETAIL}</p>
      </section>
    );
  }
  const claude = claudeLine(claudeState, availability);
  const metricsText =
    availability === 'unavailable'
      ? (lastContactText(lastContactAt, now) ?? 'Ne répond pas')
      : metrics
        ? formatServerMetrics(metrics)
        : 'Mesures en attente…';
  return (
    <section
      aria-label="État du serveur"
      className={cn('flex flex-col gap-2 rounded-md bg-surface-raised p-3', className)}
    >
      <p className="m-0 flex min-w-0 items-center gap-2">
        <StatusDot tone={serverTone(availability)} />
        <span className="truncate font-sans text-app-13 font-semibold text-text">{serverLabel(name, location)}</span>
        {availability === 'unavailable' ? <span className="sr-only">: ne répond pas</span> : null}
      </p>
      <p
        suppressHydrationWarning
        className={cn(
          'm-0 font-mono text-app-11 whitespace-pre',
          availability === 'unavailable' ? 'text-danger-on-dark' : 'text-accent',
        )}
      >
        {metricsText}
      </p>
      <p className="m-0 flex min-w-0 items-center gap-2">
        <StatusDot tone={claude.tone} />
        <span className="truncate font-sans text-app-12 text-accent">{claude.text}</span>
      </p>
    </section>
  );
}
