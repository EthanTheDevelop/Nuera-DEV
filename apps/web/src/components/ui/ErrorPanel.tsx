'use client';

import { useId, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Icon } from '@/components/icons';
import { Badge } from './Badge';
import { CodeBlock } from './CodeBlock';
import { CompactButton } from './CompactButton';

export interface ErrorPanelProps {
  /** What failed (« npm run build a échoué », « La synchronisation a échoué »). */
  title: ReactNode;
  /** Exit code, rendered as Badge Danger « code N ». */
  exitCode?: number | null;
  /** First meaningful error line (+ file:line), JetBrains Mono 12 / 18 muted. */
  excerpt?: ReactNode;
  /** What was NOT touched (T4 rule), e.g. « Rien n'a été écrasé. ». */
  untouched?: ReactNode;
  /** Raw command output, « à un clic » behind the toggle. Never reformatted. */
  raw?: string | null;
  /** Retry action (Secondaire + refresh icon). */
  onRetry?: () => void;
  retryLabel?: string;
  retrying?: boolean;
  /** Extra actions between retry and the raw-output toggle (« Demander à Claude de corriger »). */
  actions?: ReactNode;
  /** Label of the raw-output toggle (default Figma copy « Voir la sortie complète »). */
  rawLabel?: string;
  className?: string;
}

/**
 * T4 « Toute erreur dit ce qui a échoué, ce qui n'a pas été touché, et propose l'action pour réessayer. La
 * sortie brute reste à un clic. » Card `Commande échouée`: bg surface, 1 px danger border, radius 20,
 * padding 16, gap 10. Pairs naturally with the AppError body (`message`, `untouched`, `raw`).
 */
export function ErrorPanel({
  title,
  exitCode,
  excerpt,
  untouched,
  raw,
  onRetry,
  retryLabel = 'Relancer',
  retrying = false,
  actions,
  rawLabel = 'Voir la sortie complète',
  className,
}: ErrorPanelProps) {
  const [showRaw, setShowRaw] = useState(false);
  const rawId = useId();
  const hasRaw = typeof raw === 'string' && raw.length > 0;
  return (
    <div role="alert" className={cn('flex min-w-0 flex-col gap-2.5 rounded-lg border border-danger bg-bg p-4', className)}>
      <div className="flex items-start gap-3">
        <p className="m-0 min-w-0 flex-1 font-sans text-app-15 font-semibold text-text">{title}</p>
        {exitCode !== undefined && exitCode !== null ? <Badge tone="danger">{`code ${exitCode}`}</Badge> : null}
      </div>
      {excerpt ? (
        <p className="m-0 font-mono text-app-12 leading-[18px] break-words text-muted">{excerpt}</p>
      ) : null}
      {untouched ? (
        <p className="m-0 flex items-start gap-2 font-sans text-app-13 leading-[18px] text-text">
          <Icon name="check" size={16} className="mt-px text-success" />
          <span>{untouched}</span>
        </p>
      ) : null}
      {onRetry || actions || hasRaw ? (
        <div className="flex flex-wrap items-center gap-2">
          {onRetry ? (
            <CompactButton variant="secondaire" icon="refresh" onClick={onRetry} loading={retrying}>
              {retryLabel}
            </CompactButton>
          ) : null}
          {actions}
          {hasRaw ? (
            <CompactButton
              variant="discret"
              aria-expanded={showRaw}
              aria-controls={rawId}
              onClick={() => setShowRaw((v) => !v)}
            >
              {showRaw ? 'Masquer la sortie complète' : rawLabel}
            </CompactButton>
          ) : null}
        </div>
      ) : null}
      {hasRaw ? (
        <div id={rawId} hidden={!showRaw}>
          <CodeBlock label="Sortie brute" className="max-h-80 overflow-y-auto">
            {raw}
          </CodeBlock>
        </div>
      ) : null}
    </div>
  );
}
