'use client';

import { CompactButton, IconButton, StatusDot, Tooltip, TooltipProvider } from '@/components/ui';
import { useIsApplePlatform } from '@/hooks/usePlatform';
import { cn } from '@/lib/cn';
import { DICTATION_COPY } from './dictation';
import type { Dictation } from './use-dictation';

export interface DictationButtonProps {
  dictation: Dictation;
  /** `sm` = desktop toolbar (36 px, 44 px hit area), `md` = phone (44 × 44). */
  size?: 'sm' | 'md';
  /** Shows the desktop shortcut in the tooltip. */
  shortcut?: boolean;
  className?: string;
}

/**
 * Microphone of a composer: starts / stops the browser dictation (`aria-pressed`). Unavailable in
 * this browser → `aria-disabled` and still tappable: the reason is then written under the field
 * (phones show no tooltip). Its own tooltip provider: it also lives in dialogs and galleries.
 */
export function DictationButton({ dictation, size = 'sm', shortcut = false, className }: DictationButtonProps) {
  const apple = useIsApplePlatform();
  const on = dictation.listening;
  const label = on ? DICTATION_COPY.stop : DICTATION_COPY.start;
  const keys = apple ? '⌘ Maj Espace' : 'Ctrl Maj Espace';
  const tip =
    dictation.unavailable ??
    (dictation.availability === 'pending' ? DICTATION_COPY.pending : shortcut ? `${label} · ${keys}` : label);
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip content={tip}>
        <span className="inline-flex">
          <IconButton
            icon="mic"
            label={label}
            size={size}
            iconSize={size === 'sm' ? 18 : 20}
            variant={on ? 'tinted' : 'ghost'}
            iconClassName={on ? 'text-accent' : 'text-muted'}
            aria-pressed={on}
            aria-busy={dictation.asking || undefined}
            aria-keyshortcuts={shortcut ? (apple ? 'Meta+Shift+Space' : 'Control+Shift+Space') : undefined}
            aria-disabled={dictation.unavailable ? true : undefined}
            disabled={!dictation.unavailable && dictation.disabled && !on}
            data-dictation={dictation.availability}
            onClick={dictation.toggle}
            className={className}
          />
        </span>
      </Tooltip>
    </TooltipProvider>
  );
}

export interface DictationStatusProps {
  dictation: Dictation;
  className?: string;
}

/**
 * State line of a dictation, under the field: « À l'écoute… » with the words being heard (shown,
 * never in the field until settled), a sober error with « Réessayer », the unavailable reason,
 * and the one-time privacy notice. Renders nothing when there is nothing to say.
 */
export function DictationStatus({ dictation, className }: DictationStatusProps) {
  const active = dictation.listening || dictation.stopping;
  const lines = active || dictation.asking || dictation.errorText || dictation.reasonShown || dictation.notice;
  if (!lines) return null;
  return (
    <div className={cn('flex min-w-0 flex-col gap-1 font-sans text-app-12', className)} data-dictation-status>
      <div aria-live="polite" className="flex min-w-0 flex-col gap-1">
        {active ? (
          <p className="m-0 flex min-w-0 items-center gap-1.5 text-text">
            <StatusDot tone="danger" className={cn(dictation.listening && 'motion-safe:animate-pulse')} />
            <span className="shrink-0 font-medium">{DICTATION_COPY.listening}</span>
          </p>
        ) : null}
        {dictation.asking ? (
          <p className="m-0 flex min-w-0 items-center gap-1.5 text-muted">
            <StatusDot tone="neutral" />
            <span className="shrink-0">{DICTATION_COPY.asking}</span>
          </p>
        ) : null}
        {dictation.errorText ? (
          <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-2 text-danger" role="status">
            <span className="min-w-0">{dictation.errorText}</span>
            {dictation.retryable ? (
              <CompactButton variant="discret" onClick={dictation.retry} className="text-danger">
                {DICTATION_COPY.retry}
              </CompactButton>
            ) : null}
          </p>
        ) : null}
        {dictation.reasonShown && dictation.unavailable ? <p className="m-0 text-muted">{dictation.unavailable}</p> : null}
      </div>
      {active && dictation.interim ? (
        <p className="m-0 min-w-0 break-words text-muted italic" data-dictation-interim>
          {dictation.interim}
        </p>
      ) : null}
      {dictation.notice ? (
        <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-2 text-muted">
          <span className="min-w-0">{DICTATION_COPY.privacy}</span>
          <CompactButton variant="discret" onClick={dictation.dismissNotice}>
            {DICTATION_COPY.understood}
          </CompactButton>
        </p>
      ) : null}
    </div>
  );
}
