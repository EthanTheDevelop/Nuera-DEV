'use client';

import { useId, useState } from 'react';
import { LiveTime } from '@/components/dev';
import { Icon } from '@/components/icons';
import { Badge, CodeBlock, CompactButton, SectionLabel } from '@/components/ui';
import { formatDateTimeShort } from '@nuera/shared/format';
import { cn } from '@/lib/cn';
import { checkRaw, stepLine, TRIGGER_LABELS } from '../model';
import type { CheckHistoryEntry, IntegrationCheck } from '../types';

const STATUS_WORDS: Record<string, { label: string; tone: 'success' | 'danger' | 'warn' | 'neutral' }> = {
  connected: { label: 'OK', tone: 'success' },
  expiring: { label: 'bientôt expiré', tone: 'warn' },
  expired: { label: 'autorisation expirée', tone: 'danger' },
  needs_auth: { label: 'connexion requise', tone: 'warn' },
  error: { label: 'injoignable', tone: 'danger' },
  pending: { label: 'non installée', tone: 'warn' },
  disabled: { label: 'désactivé', tone: 'neutral' },
  unknown: { label: 'non vérifié', tone: 'neutral' },
};

const statusWord = (status: string) => STATUS_WORDS[status] ?? { label: status, tone: 'neutral' as const };

const safeDateTime = (value: string) => (Number.isNaN(new Date(value).getTime()) ? '' : formatDateTimeShort(value));

/**
 * « Voir le journal » (not designed): the steps of the last diagnostic (request, HTTP code, duration,
 * sanitised provider message — never a secret) with the redacted raw output one click away, then the
 * history of the last checks (newest first).
 */
export function CheckJournal({ last, history, className }: { last: IntegrationCheck | null; history: CheckHistoryEntry[]; className?: string }) {
  const [showRaw, setShowRaw] = useState(false);
  const rawId = useId();
  const raw = checkRaw(last);
  if (!last && history.length === 0) {
    return <p className={cn('m-0 font-sans text-app-13 text-muted', className)}>Aucune vérification enregistrée pour le moment.</p>;
  }
  return (
    <div className={cn('flex min-w-0 flex-col gap-4', className)}>
      {last ? (
        <section aria-label="Dernière vérification" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <SectionLabel as="h3">Dernière vérification</SectionLabel>
            <Badge tone={statusWord(last.result.status).tone}>{statusWord(last.result.status).label}</Badge>
            <span className="font-mono text-app-11 text-muted">
              <LiveTime value={last.startedAt} format="relative" />
              {` · ${TRIGGER_LABELS[last.trigger] ?? last.trigger} · ${last.durationMs} ms`}
            </span>
          </div>
          {last.result.reason ? <p className="m-0 font-sans text-app-13 leading-[18px] text-text">{last.result.reason}</p> : null}
          <ol className="m-0 flex list-none flex-col p-0">
            {last.steps.map((step, index) => (
              <li key={`${step.name}-${index}`} className="flex items-start gap-2 border-b border-border py-2 last:border-b-0">
                <Icon name={step.ok ? 'check' : 'x'} size={16} className={cn('mt-px shrink-0', step.ok ? 'text-success' : 'text-danger')} />
                <span className="sr-only">{step.ok ? 'Réussi :' : 'Échec :'}</span>
                <span className="min-w-0 font-mono text-app-12 leading-[18px] break-words text-text">{stepLine(step)}</span>
              </li>
            ))}
          </ol>
          {raw ? (
            <div className="flex flex-col gap-2">
              <CompactButton variant="discret" aria-expanded={showRaw} aria-controls={rawId} onClick={() => setShowRaw((value) => !value)}>
                {showRaw ? 'Masquer la sortie complète' : 'Voir la sortie complète'}
              </CompactButton>
              {showRaw ? (
                <div id={rawId}>
                  <CodeBlock wrap label="Sortie complète de la vérification">
                    {raw}
                  </CodeBlock>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
      {history.length ? (
        <section aria-label="Historique des vérifications" className="flex flex-col gap-1">
          <SectionLabel as="h3">{`Historique · ${history.length}`}</SectionLabel>
          <ul className="m-0 flex list-none flex-col p-0">
            {history.map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="flex min-w-0 items-baseline gap-3 border-b border-border py-2 last:border-b-0">
                <span className="w-32 shrink-0 font-mono text-app-12 text-muted">{safeDateTime(entry.at)}</span>
                <span className="min-w-0 flex-1 font-sans text-app-13 text-text">
                  {[statusWord(entry.status).label, entry.reason].filter(Boolean).join(' · ')}
                </span>
                <span className="shrink-0 font-mono text-app-11 text-muted">{`${TRIGGER_LABELS[entry.trigger] ?? entry.trigger} · ${entry.durationMs} ms`}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
