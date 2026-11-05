'use client';

import { Icon } from '@/components/icons';
import { Badge, EmptyState, ErrorPanel, SkeletonList } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { FileContent, TreeEntry } from '@nuera/shared/runner';
import { plural } from '@nuera/shared/format';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchFile, fetchTree } from '../api';
import { formatFileSize } from '../lib/thread';
import { useWorkspace } from '../WorkspaceContext';

type DirState = { status: 'loading' } | { status: 'ready'; entries: TreeEntry[]; truncated: boolean } | { status: 'error'; message: string };
type FileState = { status: 'loading'; path: string } | { status: 'ready'; file: FileContent & { secret?: boolean } } | { status: 'error'; path: string; message: string };

function entryMeta(entry: TreeEntry): string | null {
  if (entry.kind !== 'file') return null;
  if (typeof entry.lines === 'number') return plural(entry.lines, 'ligne');
  return formatFileSize(entry.size);
}

const ROW = 'flex w-full min-w-0 items-center gap-1.5 rounded-sm py-[5px] pr-2 text-left transition-colors duration-(--dur-fast)';

/**
 * W1 `Explorateur de fichiers` (227:3134): lazy tree of the worktree (16 px per level) and a
 * read-only preview in the dark tone (`Aperçu · <fichier>`, Badge Neutre « Lecture seule »).
 */
export function FileExplorer({ variant = 'desktop' }: { variant?: 'desktop' | 'phone' }) {
  const ws = useWorkspace();
  const worktree = ws.data.worktree;
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(['']));
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<FileState | null>(null);
  const autoPicked = useRef(false);
  const fileAbort = useRef<AbortController | null>(null);

  const worktreeId = worktree?.present ? worktree.id : null;
  const loadDir = useCallback(
    async (path: string) => {
      if (!worktreeId) return;
      setDirs((d) => ({ ...d, [path]: { status: 'loading' } }));
      try {
        const tree = await fetchTree(worktreeId, path);
        setDirs((d) => ({ ...d, [path]: { status: 'ready', entries: tree.entries, truncated: tree.truncated } }));
      } catch (error) {
        setDirs((d) => ({ ...d, [path]: { status: 'error', message: (error as Error).message } }));
      }
    },
    [worktreeId],
  );

  const openFile = useCallback(
    async (path: string) => {
      if (!worktreeId) return;
      setSelected(path);
      fileAbort.current?.abort();
      const controller = new AbortController();
      fileAbort.current = controller;
      setFile({ status: 'loading', path });
      try {
        const content = await fetchFile(worktreeId, path, controller.signal);
        setFile({ status: 'ready', file: content });
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') return;
        setFile({ status: 'error', path, message: (error as Error).message });
      }
    },
    [worktreeId],
  );

  useEffect(() => {
    void loadDir('');
    return () => fileAbort.current?.abort();
  }, [loadDir]);

  // W1 opens CLAUDE.md when the repository has one.
  const root = dirs[''];
  useEffect(() => {
    if (autoPicked.current || root?.status !== 'ready') return;
    autoPicked.current = true;
    const claudeMd = root.entries.find((e) => e.kind === 'file' && e.name === 'CLAUDE.md');
    if (claudeMd && variant === 'desktop') void openFile(claudeMd.path);
  }, [openFile, root, variant]);

  if (!worktree?.present) {
    return (
      <EmptyState icon="file" title="Fichiers indisponibles" variant="plain">
        Le worktree de cette session a été supprimé sur le serveur : ses fichiers ne peuvent plus être lus.
      </EmptyState>
    );
  }

  const toggle = (path: string) => {
    const opening = !expanded.has(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (opening && (!dirs[path] || dirs[path]?.status === 'error')) void loadDir(path);
  };

  const renderDir = (path: string, depth: number): React.ReactNode => {
    const state = dirs[path];
    if (!state || state.status === 'loading') {
      return (
        <li className="py-1 font-mono text-app-11 text-muted" style={{ paddingLeft: 8 + depth * 16 + 18 }}>
          Lecture du dossier…
        </li>
      );
    }
    if (state.status === 'error') {
      return (
        <li className="py-1 font-sans text-app-12 text-danger" style={{ paddingLeft: 8 + depth * 16 + 18 }}>
          {state.message}{' '}
          <button type="button" className="nu-hit text-accent underline" onClick={() => void loadDir(path)}>
            Réessayer
          </button>
        </li>
      );
    }
    if (state.entries.length === 0) {
      return (
        <li className="py-1 font-sans text-app-12 text-muted" style={{ paddingLeft: 8 + depth * 16 + 18 }}>
          Dossier vide
        </li>
      );
    }
    return (
      <>
        {state.entries.map((entry) => {
          const isDir = entry.kind === 'dir';
          const open = isDir && expanded.has(entry.path);
          const isSelected = selected === entry.path;
          const meta = entryMeta(entry);
          return (
            <li key={entry.path}>
              <button
                type="button"
                className={cn(ROW, isSelected ? 'bg-accent-pale' : 'hover:bg-hover', entry.ignored && 'opacity-60', variant === 'phone' && 'min-h-11')}
                style={{ paddingLeft: 8 + depth * 16 }}
                aria-expanded={isDir ? open : undefined}
                aria-current={isSelected ? 'true' : undefined}
                onClick={() => (isDir ? toggle(entry.path) : void openFile(entry.path))}
                title={entry.path}
              >
                {isDir ? (
                  <Icon name={open ? 'chevron-down' : 'chevron'} size={12} className="shrink-0 text-muted" />
                ) : (
                  <span className="size-3 shrink-0" aria-hidden />
                )}
                <Icon name={isDir ? 'projets' : 'file'} size={15} className={cn('shrink-0', isDir ? 'text-accent' : 'text-muted')} />
                <span className={cn('min-w-0 flex-1 truncate font-mono text-app-12 text-text', isSelected && 'font-medium')}>{entry.name}</span>
                {meta ? <span className="shrink-0 font-mono text-app-11 text-muted">{meta}</span> : null}
              </button>
              {open ? <ul className="m-0 list-none p-0">{renderDir(entry.path, depth + 1)}</ul> : null}
            </li>
          );
        })}
        {state.truncated ? (
          <li className="py-1 font-sans text-app-12 text-muted" style={{ paddingLeft: 8 + depth * 16 + 18 }}>
            Liste tronquée : dossier trop volumineux.
          </li>
        ) : null}
      </>
    );
  };

  const rootOpen = expanded.has('');
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col gap-3', variant === 'desktop' ? 'p-4' : 'px-4 py-3')}>
      <nav aria-label="Arborescence du worktree" className={cn('min-h-0 overflow-y-auto', file ? 'max-h-[45%] shrink-0' : 'flex-1')}>
        <ul className="m-0 list-none p-0">
          <li>
            <button type="button" className={cn(ROW, 'pl-2 hover:bg-hover')} aria-expanded={rootOpen} onClick={() => toggle('')}>
              <Icon name={rootOpen ? 'chevron-down' : 'chevron'} size={12} className="shrink-0 text-muted" />
              <Icon name="projets" size={15} className="shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate font-mono text-app-12 text-text">{ws.data.project.repoName}</span>
            </button>
            {rootOpen ? <ul className="m-0 list-none p-0">{renderDir('', 1)}</ul> : null}
          </li>
        </ul>
      </nav>
      {file ? <FilePreview state={file} onRetry={() => selected && void openFile(selected)} onClose={() => {
        setFile(null);
        setSelected(null);
      }} /> : null}
    </div>
  );
}

function FilePreview({ state, onRetry, onClose }: { state: FileState; onRetry: () => void; onClose: () => void }) {
  const path = state.status === 'ready' ? state.file.path : state.path;
  const name = path.split('/').pop() ?? path;
  return (
    <section aria-label={`Aperçu · ${name}`} className="flex min-h-[200px] flex-1 flex-col overflow-hidden rounded-md border border-border">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <p className="m-0 min-w-0 flex-1 truncate font-mono text-app-12 font-medium text-text" title={path}>
          {name}
        </p>
        <Badge tone="neutral">Lecture seule</Badge>
        <button type="button" className="nu-hit rounded-sm text-muted hover:text-text" aria-label="Fermer l'aperçu" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div data-tone="dark" className="min-h-0 flex-1 overflow-auto bg-bg px-3.5 py-3">
        {state.status === 'loading' ? (
          <SkeletonList rows={5} card={false} label="Lecture du fichier" />
        ) : state.status === 'error' ? (
          <ErrorPanel title="Le fichier n'a pas pu être lu" excerpt={state.message} onRetry={onRetry} />
        ) : state.file.secret ? (
          <p className="m-0 font-sans text-app-13 text-muted">
            Fichier de secrets : son contenu n&apos;est pas affiché dans le navigateur. Consultez-le si besoin depuis le terminal du worktree.
          </p>
        ) : state.file.binary ? (
          <p className="m-0 font-sans text-app-13 text-muted">Fichier binaire : aperçu indisponible.</p>
        ) : state.file.content === null ? (
          <p className="m-0 font-sans text-app-13 text-muted">Fichier trop volumineux pour être affiché ici.</p>
        ) : (
          <>
            <pre className="m-0 font-mono text-app-12 leading-[19px] break-words whitespace-pre-wrap text-muted [font-variant-ligatures:none]">
              {state.file.content}
            </pre>
            {state.file.truncated ? (
              <p className="mt-3 mb-0 font-sans text-app-12 text-muted">Aperçu tronqué : le fichier est trop long pour être affiché en entier.</p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
