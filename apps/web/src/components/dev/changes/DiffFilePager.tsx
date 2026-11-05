import { IconButton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { basename, formatLineDelta, formatPosition, joinParts } from '../lib/format';

export interface DiffFilePagerProps {
  /** Full path of the current file (the basename is shown, the full path is the tooltip). */
  path: string;
  /** 1-based position in the changed files. */
  index: number;
  total: number;
  additions?: number;
  deletions?: number;
  /** Omitted or at the first file → the button is disabled (S2 ends: disable, never wrap). */
  onPrevious?: () => void;
  onNext?: () => void;
  className?: string;
}

/** Note under the phone diff (S2, verbatim). */
export const DIFF_PHONE_HINT = "Une ligne coupée s'ouvre en entier au toucher. Le côte à côte reste réservé au bureau.";

/**
 * S2 `Fichier courant`: previous 44 · file box (name, « 1 sur 4 · +46 −12 ») · next 44.
 * Swipe can be added by the page; the buttons stay the accessible path.
 */
export function DiffFilePager({ path, index, total, additions, deletions, onPrevious, onNext, className }: DiffFilePagerProps) {
  const canPrevious = Boolean(onPrevious) && index > 1;
  const canNext = Boolean(onNext) && index < total;
  return (
    <div className={cn('flex w-full min-w-0 items-center gap-1', className)}>
      <IconButton icon="arrow-left" label="Fichier précédent" variant="outline" disabled={!canPrevious} onClick={onPrevious} />
      <div className="flex h-11 min-w-0 flex-1 flex-col justify-center gap-0.5 rounded-md border border-border bg-bg px-3 py-1">
        <p className="m-0 truncate font-mono text-app-13 font-medium text-text" title={path}>
          {basename(path)}
        </p>
        <p className="m-0 truncate font-sans text-app-11 text-muted" aria-live="polite">
          {joinParts(formatPosition(index, total), formatLineDelta(additions, deletions))}
        </p>
      </div>
      <IconButton icon="chevron" label="Fichier suivant" variant="outline" disabled={!canNext} onClick={onNext} />
    </div>
  );
}
