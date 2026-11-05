'use client';

import { useState } from 'react';
import { Banner, CodeBlock, CompactButton } from '@/components/ui';
import { joinParts } from '@/components/dev/lib/format';

export interface Failure {
  message: string;
  detail?: string;
  untouched?: string;
  raw?: string;
  reason?: string;
}

export interface FailureBannerProps {
  failure: Failure;
  /** What failed, as a title (« La synchronisation a échoué »); default: the message. */
  title?: string;
  onRetry?: () => void;
  retrying?: boolean;
  retryLabel?: string;
  onDismiss?: () => void;
  className?: string;
}

/**
 * T4 « Erreur récupérable » banner: what failed (title), why (message / detail), what was not
 * touched, « Réessayer », and the raw output one click away.
 */
export function FailureBanner({ failure, title, onRetry, retrying, retryLabel = 'Réessayer', onDismiss, className }: FailureBannerProps) {
  const [showRaw, setShowRaw] = useState(false);
  const body = joinParts(title ? failure.message : null, failure.detail && failure.detail !== failure.message ? failure.detail : null);
  return (
    <div className={className}>
      <Banner
        tone="danger"
        title={title ?? failure.message}
        live
        action={
          <div className="flex flex-wrap items-center gap-2">
            {onRetry ? (
              <CompactButton variant="secondaire" icon="refresh" onClick={onRetry} loading={retrying}>
                {retryLabel}
              </CompactButton>
            ) : null}
            {failure.raw ? (
              <CompactButton variant="discret" onClick={() => setShowRaw((v) => !v)} aria-expanded={showRaw}>
                {showRaw ? 'Masquer la sortie' : 'Voir la sortie complète'}
              </CompactButton>
            ) : null}
            {onDismiss ? (
              <CompactButton variant="discret" onClick={onDismiss}>
                Fermer
              </CompactButton>
            ) : null}
          </div>
        }
      >
        {body ? <span className="block">{body}</span> : null}
        {failure.untouched ? <span className="block">{failure.untouched}</span> : null}
      </Banner>
      {showRaw && failure.raw ? (
        <CodeBlock size="sm" tone="error" className="mt-2 max-h-64 overflow-auto" label="Sortie brute">
          {failure.raw}
        </CodeBlock>
      ) : null}
    </div>
  );
}
