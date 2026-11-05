import type { ReactNode } from 'react';
import { formatDuration, plural } from '@nuera/shared/format';
import { Badge, Pastille } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatFileCount, formatLineDelta, joinParts } from '../lib/format';

export interface SessionSummaryMetaInput {
  files: number;
  additions: number;
  deletions: number;
  /** Commands allowed during the session (permission log). */
  allowedCommands?: number;
  /** Commits made since the session started; unknown (omitted) → nothing is said about commits. */
  commits?: number | null;
}

/**
 * Meta line computed by Nuera from git and the permission log (never from Claude's text):
 * « 4 fichiers · +152 −12 · 2 commandes autorisées · aucun commit encore ».
 */
export function sessionSummaryMeta({ files, additions, deletions, allowedCommands = 0, commits }: SessionSummaryMetaInput): string {
  return joinParts(
    formatFileCount(files),
    formatLineDelta(additions, deletions),
    allowedCommands > 0 ? `${plural(allowedCommands, 'commande')} ${allowedCommands >= 2 ? 'autorisées' : 'autorisée'}` : null,
    typeof commits === 'number' ? (commits > 0 ? plural(commits, 'commit') : 'aucun commit encore') : null,
  );
}

export interface SessionSummaryCardProps {
  /** Total duration → « Session terminée · 18 min ». */
  durationMs: number;
  /** Change points, verbatim from Claude's final message (nothing invented). */
  points?: readonly string[];
  /** Badge on the right (« Prête pour un commit »), Succès tone. */
  badge?: string | null;
  /** Meta line (see `sessionSummaryMeta`). */
  meta?: string | null;
  /** Compact buttons: Principal « Préparer le commit », Secondaire « Voir le diff », Discret « Continuer la conversation ». */
  actions?: ReactNode;
  title?: string;
  className?: string;
}

/** W3 `Résumé de fin de session` (229:3622): success-bordered card that closes a finished task. */
export function SessionSummaryCard({
  durationMs,
  points = [],
  badge,
  meta,
  actions,
  title = 'Session terminée',
  className,
}: SessionSummaryCardProps) {
  const heading = joinParts(title, formatDuration(durationMs));
  return (
    <section
      aria-label={heading}
      className={cn('flex w-full min-w-0 flex-col gap-3 rounded-lg border-[1.5px] border-success bg-bg p-4', className)}
    >
      <div className="flex items-center gap-2.5">
        <Pastille icon="check" size={28} tone="success" />
        <h3 className="m-0 min-w-0 flex-1 font-sans text-app-15 font-semibold text-text">{heading}</h3>
        {badge ? <Badge tone="success">{badge}</Badge> : null}
      </div>
      {points.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {points.map((point, index) => (
            <li key={`${index}-${point}`} className="flex gap-2 font-sans text-app-14 leading-5 text-text">
              <span aria-hidden className="select-none">
                •
              </span>
              <span className="min-w-0 flex-1 break-words">{point}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {meta ? <p className="m-0 font-mono text-app-12 text-muted">{meta}</p> : null}
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </section>
  );
}
