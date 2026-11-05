'use client';

import type { DiffViewFile } from '@/components/dev';
import { toChangeStatus } from '@/components/dev';
import type { ChangedFile, FileDiff } from '@nuera/shared/runner';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchDiff } from '../api';
import { useWorkspace } from '../WorkspaceContext';

export type DiffState = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; diff: FileDiff } | { status: 'error'; message: string };

/** Runner `FileDiff` → `DiffView` file (`additions: insertions`). */
export function toDiffViewFile(diff: FileDiff): DiffViewFile {
  return {
    path: diff.path,
    oldPath: diff.oldPath,
    status: toChangeStatus(diff.status),
    additions: diff.insertions,
    deletions: diff.deletions,
    binary: diff.binary,
    truncated: diff.truncated,
    tooLarge: diff.tooLarge,
    hunks: diff.hunks,
  };
}

/** Changed files of the worktree and the selected one (`?fichier=`, else the first). */
export function useSelectedChange(): { files: ChangedFile[]; selected: ChangedFile | null; index: number } {
  const ws = useWorkspace();
  const files = useMemo(() => ws.ctl.state.changes?.files ?? [], [ws.ctl.state.changes]);
  const index = Math.max(0, ws.url.file ? files.findIndex((f) => f.path === ws.url.file) : 0);
  return { files, selected: files[index] ?? null, index };
}

/** Diff of one file, re-read when its line counts change (the worktree moved) or on `retry()`. */
export function useFileDiff(file: ChangedFile | null): DiffState & { retry: () => void } {
  const ws = useWorkspace();
  const worktreeId = ws.data.worktree?.present ? ws.data.worktree.id : null;
  const [state, setState] = useState<DiffState>({ status: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const signature = file ? `${file.path}:${file.status}:${file.insertions}:${file.deletions}:${file.staged}:${file.unstaged}` : '';

  useEffect(() => {
    if (!file || !worktreeId) {
      setState({ status: 'idle' });
      return;
    }
    const controller = new AbortController();
    setState((s) => (s.status === 'ready' && s.diff.path === file.path ? s : { status: 'loading' }));
    fetchDiff(worktreeId, file.path, controller.signal)
      .then((diff) => setState({ status: 'ready', diff }))
      .catch((error: unknown) => {
        if ((error as { name?: string }).name === 'AbortError') return;
        setState({ status: 'error', message: (error as Error).message });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `signature` carries the file identity
  }, [signature, worktreeId, attempt]);

  return { ...state, retry };
}
