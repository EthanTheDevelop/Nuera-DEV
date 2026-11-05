'use client';

import { BranchStatusBar, ChangedFileRow, DiffView, describeBranchStatus, formatAdditions, formatDeletions, toChangeStatus } from '@/components/dev';
import { Badge, CompactButton, EmptyState, ErrorPanel, SkeletonList } from '@/components/ui';
import { cn } from '@/lib/cn';
import { plural } from '@nuera/shared/format';
import { useState } from 'react';
import { stageRequest, unstageRequest } from '../api';
import { useWorkspace } from '../WorkspaceContext';
import { toDiffViewFile, useFileDiff, useSelectedChange } from './useFileDiff';

/** Branch line + Git buttons (D05 `Actions Git` 214:1850, W1 disabled group). */
export function GitActions({ className }: { className?: string }) {
  const ws = useWorkspace();
  const { branch, changes } = ws.ctl.state;
  const worktree = ws.data.worktree;
  if (!worktree) return null;
  const status = branch
    ? describeBranchStatus({
        ahead: branch.ahead,
        behind: branch.behind,
        uncommitted: changes ? changes.totals.files : null,
        base: branch.base,
      })
    : worktree.present
      ? 'état Git indisponible'
      : 'worktree supprimé';
  const disabled = !ws.canPrepareCommit || Boolean(ws.serverDisabledReason);
  const prDisabled = disabled || (Boolean(branch) && branch!.ahead === 0 && (changes?.totals.files ?? 0) === 0);
  return (
    <BranchStatusBar
      className={className}
      branch={worktree.branch}
      status={status}
      actionsDisabled={disabled}
      actions={
        <>
          <CompactButton variant="principal" icon="git-commit" disabled={disabled} onClick={() => ws.openCommit('commit')}>
            Préparer le commit
          </CompactButton>
          <CompactButton variant="secondaire" icon="git-pull-request" disabled={prDisabled} onClick={() => ws.openCommit('pull-request')}>
            Préparer la pull request
          </CompactButton>
        </>
      }
    />
  );
}

/** Index state of a file and its toggle (« Indexer » / « Retirer de l'index »), not drawn in Figma. */
function StageControl({ path, staged, unstaged }: { path: string; staged: boolean; unstaged: boolean }) {
  const ws = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const worktreeId = ws.data.worktree?.id;
  if (!worktreeId) return null;
  const fullyStaged = staged && !unstaged;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (fullyStaged) await unstageRequest(worktreeId, [path]);
      else await stageRequest(worktreeId, [path]);
      ws.ctl.refreshChanges();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Badge tone={fullyStaged ? 'accent' : staged ? 'warn' : 'neutral'}>
        {fullyStaged ? 'Indexé' : staged ? 'Indexé en partie' : 'Non indexé'}
      </Badge>
      <CompactButton variant="discret" loading={busy} disabled={Boolean(ws.serverDisabledReason)} onClick={() => void run()}>
        {fullyStaged ? "Retirer de l'index" : 'Indexer'}
      </CompactButton>
      {error ? (
        <span role="alert" className="font-sans text-app-12 text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** Selected file diff (unified, panel header « n blocs · Avant / après »). */
export function SelectedDiff({ className, bodyClassName }: { className?: string; bodyClassName?: string }) {
  const ws = useWorkspace();
  const { selected } = useSelectedChange();
  const diff = useFileDiff(selected);
  if (!selected) return null;
  if (diff.status === 'error') {
    return <ErrorPanel title="Le diff de ce fichier n'a pas pu être lu" excerpt={diff.message} onRetry={diff.retry} />;
  }
  if (diff.status !== 'ready') return <SkeletonList rows={6} card={false} label="Lecture du diff" className="rounded-md border border-border px-3" />;
  return (
    <DiffView
      file={toDiffViewFile(diff.diff)}
      layout="unified"
      header="panel"
      onBeforeAfter={() => ws.url.set({ revue: '1', fichier: selected.path })}
      className={className}
      bodyClassName={bodyClassName}
    />
  );
}

/** D05 `Modifications` (214:1678): summary, changed files, diff of the selected one. */
export function ChangesPanel() {
  const ws = useWorkspace();
  const { changes, changesError } = ws.ctl.state;
  const { files, selected } = useSelectedChange();

  if (!ws.data.worktree?.present) {
    return (
      <div className="p-4">
        <EmptyState icon="file-diff" title="Modifications indisponibles" variant="plain">
          Le worktree de cette session a été supprimé sur le serveur.
        </EmptyState>
      </div>
    );
  }
  if (!changes) {
    return (
      <div className="p-4">
        {changesError ? (
          <ErrorPanel title="Les modifications du worktree sont indisponibles" excerpt={changesError} onRetry={ws.ctl.refreshChanges} />
        ) : (
          <SkeletonList rows={4} card={false} label="Lecture des modifications" />
        )}
      </div>
    );
  }
  if (files.length === 0) {
    return (
      <div className="p-4">
        <EmptyState icon="file-diff" title="Aucune modification" variant="plain">
          Le worktree est identique au dernier commit : rien à committer pour l&apos;instant.
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <p className="m-0 min-w-0 flex-1 font-sans text-app-14 font-semibold text-text">
          {plural(changes.totals.files, 'fichier modifié', 'fichiers modifiés')}
        </p>
        <span className="font-mono text-app-12 text-success">{formatAdditions(changes.totals.insertions)}</span>
        {changes.totals.deletions > 0 ? <span className="font-mono text-app-12 text-danger">{formatDeletions(changes.totals.deletions)}</span> : null}
      </div>
      <ul className={cn('m-0 flex max-h-[40%] shrink-0 list-none flex-col gap-0.5 overflow-y-auto p-0')}>
        {files.map((file) => (
          <li key={file.path}>
            <ChangedFileRow
              status={toChangeStatus(file.status)}
              path={file.path}
              oldPath={file.oldPath}
              additions={file.insertions}
              deletions={file.deletions}
              binary={file.binary}
              selected={selected?.path === file.path}
              onSelect={() => ws.url.set({ fichier: file.path }, 'replace')}
            />
          </li>
        ))}
      </ul>
      {selected ? <StageControl path={selected.path} staged={selected.staged} unstaged={selected.unstaged} /> : null}
      <SelectedDiff className="min-h-0 flex-1" bodyClassName="min-h-0 flex-1 overflow-y-auto" />
    </div>
  );
}
