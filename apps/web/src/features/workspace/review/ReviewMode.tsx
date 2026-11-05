'use client';

import { ChangedFileRow, DiffView, formatLineDelta, toChangeStatus } from '@/components/dev';
import { CompactButton, EmptyState, ErrorPanel, SectionLabel, SegmentedControl, SkeletonList } from '@/components/ui';
import { plural } from '@nuera/shared/format';
import { useCallback, useEffect, useState } from 'react';
import { useWorkspace } from '../WorkspaceContext';
import { toDiffViewFile, useFileDiff, useSelectedChange } from '../panel/useFileDiff';

/** W4 list label: the last two path segments (`crm/PipelineBoard.tsx`). */
export function shortPath(path: string, segments = 2): string {
  const parts = path.split('/');
  return parts.length <= segments ? path : parts.slice(-segments).join('/');
}

/**
 * W4 `Revue des modifications` (229:3676): full-width read-only review, one file at a time, hunk by
 * hunk (`Précédent · K` / `Suivant · J` cross file boundaries), unified or side by side (`?affichage=`).
 */
export function ReviewMode() {
  const ws = useWorkspace();
  const { files, selected, index } = useSelectedChange();
  const diff = useFileDiff(selected);
  const totals = ws.ctl.state.changes?.totals;
  // Hunk position; -1 = « last hunk of the file » (coming back with Précédent).
  const [hunk, setHunk] = useState(0);
  const hunkCount = diff.status === 'ready' ? diff.diff.hunks.length : 0;
  const activeHunk = diff.status === 'ready' ? (hunk < 0 ? Math.max(0, hunkCount - 1) : Math.min(hunk, Math.max(0, hunkCount - 1))) : 0;

  const selectFile = useCallback(
    (i: number, atHunk = 0) => {
      const file = files[i];
      if (!file) return;
      setHunk(atHunk);
      ws.url.set({ fichier: file.path }, 'replace');
    },
    [files, ws.url],
  );

  const next = useCallback(() => {
    if (diff.status === 'ready' && activeHunk < hunkCount - 1) setHunk(activeHunk + 1);
    else if (index < files.length - 1) selectFile(index + 1, 0);
  }, [activeHunk, diff.status, files.length, hunkCount, index, selectFile]);
  const previous = useCallback(() => {
    if (activeHunk > 0) setHunk(activeHunk - 1);
    else if (index > 0) selectFile(index - 1, -1);
  }, [activeHunk, index, selectFile]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [data-terminal-state]') || target.isContentEditable)) return;
      if (event.key === 'j' || event.key === 'J') {
        event.preventDefault();
        next();
      } else if (event.key === 'k' || event.key === 'K') {
        event.preventDefault();
        previous();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, previous]);

  const back = () => ws.url.set({ revue: null });
  const atStart = index === 0 && activeHunk === 0;
  const atEnd = index >= files.length - 1 && (diff.status !== 'ready' || activeHunk >= hunkCount - 1);
  const layout = ws.url.layout === 'unifie' ? 'unified' : 'split';

  return (
    <section aria-label="Revue des modifications" className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
      <div className="flex min-h-[57px] shrink-0 flex-wrap items-center gap-3 border-b border-border px-6 py-2.5">
        <CompactButton variant="discret" icon="arrow-left" onClick={back}>
          Retour à la session
        </CompactButton>
        <h2 className="m-0 min-w-0 flex-1 truncate font-sans text-app-15 font-semibold text-text">
          {totals
            ? `Modifications · ${plural(totals.files, 'fichier')} · ${formatLineDelta(totals.insertions, totals.deletions)}`
            : 'Modifications'}
        </h2>
        <SegmentedControl
          aria-label="Affichage"
          value={ws.url.layout}
          onValueChange={(value) => ws.url.set({ affichage: value === 'cote-a-cote' ? null : value }, 'replace')}
          items={[
            { value: 'unifie', label: 'Unifié' },
            { value: 'cote-a-cote', label: 'Côte à côte' },
          ]}
        />
        {files.length > 0 ? (
          <p className="m-0 shrink-0 font-mono text-app-11 text-muted" aria-live="polite">
            {`Fichier ${index + 1} sur ${files.length}${hunkCount > 0 ? ` · bloc ${activeHunk + 1} sur ${hunkCount}` : ''}`}
          </p>
        ) : null}
        <CompactButton variant="secondaire" disabled={atStart || files.length === 0} onClick={previous} aria-keyshortcuts="K">
          Précédent · K
        </CompactButton>
        <CompactButton variant="secondaire" disabled={atEnd || files.length === 0} onClick={next} aria-keyshortcuts="J">
          Suivant · J
        </CompactButton>
      </div>

      {files.length === 0 ? (
        <div className="p-6">
          <EmptyState
            icon="file-diff"
            title="Aucune modification à relire"
            variant="plain"
            action={
              <CompactButton variant="secondaire" icon="arrow-left" onClick={back}>
                Retour à la session
              </CompactButton>
            }
          >
            Le worktree est identique au dernier commit.
          </EmptyState>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <nav aria-label="Fichiers modifiés" className="flex w-80 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-bg p-3">
            <SectionLabel as="p" className="px-0.5 pb-1">
              {plural(files.length, 'fichier').toUpperCase()}
            </SectionLabel>
            {files.map((file, i) => (
              <ChangedFileRow
                key={file.path}
                status={toChangeStatus(file.status)}
                path={file.path}
                label={shortPath(file.path)}
                oldPath={file.oldPath}
                additions={file.insertions}
                deletions={file.deletions}
                binary={file.binary}
                selected={i === index}
                onSelect={() => selectFile(i)}
              />
            ))}
          </nav>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-5 py-4">
            {diff.status === 'error' ? (
              <ErrorPanel title="Le diff de ce fichier n'a pas pu être lu" excerpt={diff.message} onRetry={diff.retry} />
            ) : diff.status !== 'ready' ? (
              <SkeletonList rows={8} card={false} label="Lecture du diff" />
            ) : (
              <DiffView
                file={toDiffViewFile(diff.diff)}
                layout={layout}
                header="review"
                baseLabel={diff.diff.baseLabel}
                headLabel={diff.diff.headLabel}
                activeHunk={activeHunk}
                framed={layout === 'unified'}
              />
            )}
            <p className="m-0 pt-4 font-sans text-app-12 text-muted">
              Lecture seule. Pour corriger, demandez-le à Claude depuis la session ou modifiez le fichier dans le terminal.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
