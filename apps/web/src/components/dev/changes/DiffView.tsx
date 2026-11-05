'use client';

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { CompactButton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { toSplitRows, type DiffLine, type DiffLineLike, type SplitCell } from '../lib/diff';
import { basename, formatHunkCount, formatLineDelta, MINUS, SEP } from '../lib/format';
import type { ChangeStatus } from '../lib/git';

/** A hunk as drawn: `parseUnifiedDiff` hunks and the runner's `FileDiff` hunks both fit. */
export interface DiffViewHunk {
  /** `@@ -12,6 +12,8 @@ export function PipelineBoard()` */
  header: string;
  lines: readonly DiffLineLike[];
}

export interface DiffViewFile {
  path: string;
  oldPath?: string | null;
  status?: ChangeStatus;
  additions: number;
  deletions: number;
  binary?: boolean;
  /** The runner cut the hunks (output cap, `FileDiff.truncated`): a note says the rest is not shown. */
  truncated?: boolean;
  /** Too large to diff (`FileDiff.tooLarge`): no line view, and never « aucune ligne modifiée ». */
  tooLarge?: boolean;
  hunks: readonly DiffViewHunk[];
}

export interface DiffViewProps {
  file: DiffViewFile;
  /** `unified` = `Dev · Ligne de diff` rows (D05 panel, S2) · `split` = side by side (W4). */
  layout?: 'unified' | 'split';
  /**
   * `panel` = D05 header (file name · « n blocs » · « Avant / après ») · `review` = W4 header (full path
   * and +/− in a raised box) · `none` (S2: the phone pager replaces it).
   */
  header?: 'panel' | 'review' | 'none';
  /** « Avant / après » (panel header): opens the review / toggles the side-by-side view. */
  onBeforeAfter?: () => void;
  beforeAfterActive?: boolean;
  /** Split column labels: `AVANT · main` / `APRÈS · feature/crm-core`. */
  baseLabel?: string | null;
  headLabel?: string | null;
  /** Hunk to bring into view (W4 « Précédent · K » / « Suivant · J »), 0-based. */
  activeHunk?: number | null;
  /** Truncated lines open in full on click / tap (S2: « Une ligne coupée s'ouvre en entier au toucher »). */
  expandOnTap?: boolean;
  /** Draws the 1 px border + radius 12 box around the lines (D05, S2). Default true for `unified`. */
  framed?: boolean;
  className?: string;
  /** Classes of the scrolling body (e.g. `flex-1 overflow-y-auto`). */
  bodyClassName?: string;
}

const LINE_BG: Record<DiffLine['type'], string> = {
  context: '',
  add: 'bg-success-pale',
  del: 'bg-danger-pale',
};

const SPLIT_BG: Record<SplitCell['type'], string> = {
  context: '',
  add: 'bg-success-pale',
  del: 'bg-danger-pale',
  empty: 'bg-surface-raised',
};

const NO_KEYS: ReadonlySet<string> = new Set();

const NUMBER = 'block truncate pr-2 text-right font-mono text-app-11 text-muted select-none';
const CODE = 'min-w-0 font-mono text-app-12 text-text';

/**
 * Unified / side-by-side diff of one file, built from `Dev · Ligne de diff` (203:534) — « Ligne de diff
 * unifiée. Le signe double la couleur : la lecture ne dépend jamais du vert et du rouge seuls. »
 */
export function DiffView({
  file,
  layout = 'unified',
  header = 'panel',
  onBeforeAfter,
  beforeAfterActive,
  baseLabel,
  headLabel,
  activeHunk,
  expandOnTap = true,
  framed,
  className,
  bodyClassName,
}: DiffViewProps) {
  // Lines opened in full, remembered per file: switching files starts from a clean view.
  const [expanded, setExpanded] = useState<{ path: string; keys: ReadonlySet<string> }>(() => ({
    path: file.path,
    keys: new Set(),
  }));
  const open = expanded.path === file.path ? expanded.keys : NO_KEYS;
  const hunkRefs = useRef<Array<HTMLDivElement | null>>([]);
  const isFramed = framed ?? layout === 'unified';
  const hasLines = !file.binary && !file.tooLarge && file.hunks.length > 0;

  useEffect(() => {
    if (activeHunk === null || activeHunk === undefined) return;
    const el = hunkRefs.current[activeHunk];
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  }, [activeHunk, file.path]);

  const toggle = (key: string) => {
    if (!expandOnTap) return;
    // A click that ends a text selection (copying code) must not reflow the line under the cursor.
    if ((window.getSelection()?.toString() ?? '') !== '') return;
    setExpanded((prev) => {
      const next = new Set(prev.path === file.path ? prev.keys : NO_KEYS);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { path: file.path, keys: next };
    });
  };

  const codeClass = (key: string) =>
    cn(CODE, open.has(key) ? 'py-0.5 break-all whitespace-pre-wrap' : 'truncate whitespace-pre', expandOnTap && 'cursor-pointer');

  let body: ReactNode;
  if (file.binary) {
    body = <p className="m-0 px-3 py-3 font-sans text-app-13 text-muted">Fichier binaire : aucun aperçu ligne à ligne.</p>;
  } else if (file.tooLarge) {
    body = (
      <p className="m-0 px-3 py-3 font-sans text-app-13 text-muted">
        Fichier trop volumineux pour l&apos;aperçu ligne à ligne.
      </p>
    );
  } else if (file.hunks.length === 0) {
    body = <p className="m-0 px-3 py-3 font-sans text-app-13 text-muted">Aucune ligne modifiée dans ce fichier.</p>;
  } else if (layout === 'unified') {
    body = file.hunks.map((hunk, h) => (
      <Fragment key={`${h}-${hunk.header}`}>
        <div
          ref={(el) => {
            hunkRefs.current[h] = el;
          }}
          aria-current={activeHunk === h || undefined}
          className="grid min-h-[22px] scroll-mt-2 grid-cols-[40px_40px_20px_minmax(0,1fr)] items-center bg-accent-pale"
        >
          <span />
          <span />
          <span />
          <span className={cn(codeClass(`h${h}`), 'text-accent')} title={hunk.header} onClick={() => toggle(`h${h}`)}>
            {hunk.header}
          </span>
        </div>
        {hunk.lines.map((line, i) => {
          const key = `${h}:${i}`;
          return (
            <div
              key={key}
              className={cn('grid min-h-[22px] grid-cols-[40px_40px_20px_minmax(0,1fr)] items-center', LINE_BG[line.type])}
            >
              <span className={NUMBER}>{line.oldNumber ?? ''}</span>
              <span className={NUMBER}>{line.newNumber ?? ''}</span>
              <span
                aria-hidden={line.type === 'context' || undefined}
                className={cn(
                  'text-center font-mono text-app-12 font-bold select-none',
                  line.type === 'add' ? 'text-success' : line.type === 'del' ? 'text-danger' : '',
                )}
              >
                {line.type === 'add' ? '+' : line.type === 'del' ? MINUS : ''}
              </span>
              <span className={codeClass(key)} title={line.text || undefined} onClick={() => toggle(key)}>
                {line.text === '' ? '​' : line.text}
              </span>
            </div>
          );
        })}
      </Fragment>
    ));
  } else {
    body = (
      <>
        {baseLabel || headLabel ? (
          <div className="grid grid-cols-2">
            <p className="m-0 truncate px-3 py-2.5 font-mono text-app-11 tracking-label text-muted">
              {baseLabel ? `AVANT${SEP}${baseLabel}` : 'AVANT'}
            </p>
            <p className="m-0 truncate px-3 py-2.5 font-mono text-app-11 tracking-label text-muted">
              {headLabel ? `APRÈS${SEP}${headLabel}` : 'APRÈS'}
            </p>
          </div>
        ) : null}
        {file.hunks.map((hunk, h) => (
          <Fragment key={`${h}-${hunk.header}`}>
            <div
              ref={(el) => {
                hunkRefs.current[h] = el;
              }}
              aria-current={activeHunk === h || undefined}
              className="flex min-h-6 scroll-mt-2 items-center bg-accent-pale pl-3"
            >
              <span className="min-w-0 truncate font-mono text-app-12 whitespace-pre text-accent" title={hunk.header}>
                {hunk.header}
              </span>
            </div>
            {toSplitRows(hunk.lines).map((row, i) => (
              <div key={`${h}:${i}`} className="grid min-h-6 grid-cols-2">
                {([row.left, row.right] as const).map((cell, side) => {
                  const key = `${h}:${i}:${side}`;
                  return (
                    <div
                      key={key}
                      className={cn(
                        'grid min-w-0 grid-cols-[44px_minmax(0,1fr)] items-center border-r border-border',
                        SPLIT_BG[cell.type],
                      )}
                    >
                      <span className={cn(NUMBER, 'pr-2.5')}>
                        {cell.number ?? ''}
                        {cell.type === 'add' || cell.type === 'del' ? (
                          <span className="sr-only">{cell.type === 'add' ? ' ajout' : ' suppression'}</span>
                        ) : null}
                      </span>
                      <span className={codeClass(key)} title={cell.text || undefined} onClick={() => toggle(key)}>
                        {cell.text === '' ? '​' : cell.text}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </Fragment>
        ))}
      </>
    );
  }

  return (
    <div
      role="group"
      aria-label={`Diff de ${file.path}`}
      className={cn(
        'flex min-h-0 w-full min-w-0 flex-col',
        isFramed && 'overflow-hidden rounded-md border border-border bg-bg',
        className,
      )}
    >
      {header === 'panel' ? (
        <div className="flex min-h-[52px] items-center gap-2 border-b border-border px-3 py-2">
          <p className="m-0 min-w-0 flex-1 truncate font-mono text-app-12 font-medium text-text" title={file.path}>
            {basename(file.path)}
          </p>
          {/* No line view (binary, too large): the counts say what changed, never « 0 bloc ». */}
          <span className="shrink-0 font-mono text-app-11 text-muted">
            {hasLines ? formatHunkCount(file.hunks.length) : formatLineDelta(file.additions, file.deletions)}
          </span>
          {onBeforeAfter && hasLines ? (
            <CompactButton variant="discret" onClick={onBeforeAfter} aria-pressed={beforeAfterActive ?? undefined}>
              Avant / après
            </CompactButton>
          ) : null}
        </div>
      ) : header === 'review' ? (
        <div className="pb-1">
          <div className="flex items-center gap-2 rounded-md border border-border bg-surface-raised px-3 py-2">
            <p className="m-0 min-w-0 flex-1 truncate font-mono text-app-12 font-medium text-text" title={file.path}>
              {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
            </p>
            <span className="shrink-0 font-mono text-app-11 text-muted">{formatLineDelta(file.additions, file.deletions)}</span>
          </div>
        </div>
      ) : null}
      <div className={cn('min-h-0 min-w-0', bodyClassName)}>
        {body}
        {file.truncated && !file.binary && !file.tooLarge ? (
          <p className="m-0 border-t border-border px-3 py-2 font-sans text-app-12 text-muted">
            Diff tronqué : seul le début des modifications est affiché.
          </p>
        ) : null}
      </div>
    </div>
  );
}
