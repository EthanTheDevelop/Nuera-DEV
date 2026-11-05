'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { PROJECT_TABLE_GRID, ProjectRow, ProjectTableHeader, projectSessionsSummary } from '@/components/dev';
import { Icon } from '@/components/icons';
import { PageHeader } from '@/components/shell';
import {
  Badge,
  Banner,
  Button,
  Card,
  ChipGroup,
  CompactButton,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  SearchField,
  Select,
  Tile,
  toast,
} from '@/components/ui';
import { NewSessionDialog } from '@/features/sessions';
import { useDeferLiveRefresh, useLiveEvent } from '@/hooks/useLiveEvents';
import { cn } from '@/lib/cn';
import type { ProjectFilter, ProjectListItem, ProjectListResult, ProjectSort } from '@/server/projects/types';
import { failureOf, projectsApi } from '../api';
import { ArchiveProjectDialog } from '../ArchiveProjectDialog';
import { projectBadge } from '../badges';
import { FailureBanner, type Failure } from '../FailureBanner';
import { projectsSubtitle } from '../format';
import { useServerName, useThrottledRefresh } from '../hooks';
import { NewBranchDialog } from '../NewBranchDialog';

export interface ProjectsViewProps {
  data: ProjectListResult;
  query: { q: string; filter: ProjectFilter; sort: ProjectSort };
}

const SORT_OPTIONS = [
  { value: 'activite', label: 'activité récente' },
  { value: 'nom', label: 'nom' },
  { value: 'ajout', label: 'ajout récent' },
] as const;

const ADD_HREF = '/projets/nouveau';

type SyncFailure = { project: ProjectListItem; failure: Failure };

/**
 * D02 (desktop table + row menu) and M02 (phone cards) — data from the server page (`listProjects`),
 * URL state ?q= / ?filtre= / ?tri=, live updates from the global stream (clone / sync progress,
 * session statuses) through `router.refresh()`.
 */
export function ProjectsView({ data, query }: ProjectsViewProps) {
  const router = useRouter();
  const serverName = useServerName();
  const throttledRefresh = useThrottledRefresh();
  // While the add-project modal is open over the list (/projets/nouveau), a refresh would re-render
  // the intercepted route as the full page: refreshes wait until the list is the current page again.
  const pathname = usePathname();
  const deferred = useRef(false);
  const onList = pathname === '/projets';
  useDeferLiveRefresh(!onList); // same for the shell's refreshes (stream.reset, runner back)
  const refresh = () => {
    if (onList) throttledRefresh();
    else deferred.current = true;
  };
  useEffect(() => {
    if (onList && deferred.current) {
      deferred.current = false;
      throttledRefresh();
    }
  }, [onList, throttledRefresh]);
  const [navigating, startNavigation] = useTransition();
  const [search, setSearch] = useState(query.q);
  const [favorites, setFavorites] = useState<Record<string, boolean>>({});
  const [syncing, setSyncing] = useState<Record<string, boolean>>({});
  const [progress, setProgress] = useState<Record<string, number | null>>({});
  const [syncFailure, setSyncFailure] = useState<SyncFailure | null>(null);
  const [cloned, setCloned] = useState<Array<{ id: string; name: string; path: string; slug: string }>>([]);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [cloneFailure, setCloneFailure] = useState<Failure | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<ProjectListItem | null>(null);
  const [branchTarget, setBranchTarget] = useState<ProjectListItem | null>(null);
  const [sessionTarget, setSessionTarget] = useState<ProjectListItem | null>(null);

  // Server data wins after each refresh: drop the optimistic overrides it now reflects; the search field
  // follows the URL (back / forward). Adjusted during render, no extra effect pass.
  const [seen, setSeen] = useState({ data, q: query.q });
  if (seen.data !== data || seen.q !== query.q) {
    setSeen({ data, q: query.q });
    if (seen.data !== data) setFavorites({});
    if (seen.q !== query.q) setSearch(query.q);
  }

  const navigate = (update: Partial<{ q: string; filtre: string; tri: string }>) => {
    const params = new URLSearchParams();
    const next = { q: query.q, filtre: query.filter, tri: query.sort, ...update };
    if (next.q) params.set('q', next.q);
    if (next.filtre && next.filtre !== 'tous') params.set('filtre', next.filtre);
    if (next.tri && next.tri !== 'activite') params.set('tri', next.tri);
    const qs = params.toString();
    startNavigation(() => router.replace(qs ? `/projets?${qs}` : '/projets', { scroll: false }));
  };

  // Search as you type (debounced); the ref always holds the latest `navigate`.
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  });
  useEffect(() => {
    if (search.trim() === query.q) return;
    const timer = setTimeout(() => navigateRef.current({ q: search.trim() }), 250);
    return () => clearTimeout(timer);
  }, [search, query.q]);

  const ids = useMemo(() => new Set(data.items.map((item) => item.id)), [data.items]);
  const names = useMemo(() => new Map(data.items.map((item) => [item.id, item])), [data.items]);

  useLiveEvent('operation.progress', (event) => {
    const op = event.data.operation;
    if (!op.projectId || !['clone', 'fetch', 'pull'].includes(op.kind)) return;
    if (op.status === 'running' || op.status === 'queued') {
      if (op.kind === 'clone') setProgress((current) => ({ ...current, [op.projectId!]: op.progress }));
      if (!ids.has(op.projectId)) refresh();
      return;
    }
    if (op.kind === 'clone' && op.status === 'succeeded') {
      const result = (op.result ?? {}) as { path?: string };
      const item = names.get(op.projectId);
      const path = result.path ?? item?.path ?? '';
      const id = op.projectId;
      setCloned((current) => [...current.filter((c) => c.id !== id), { id, name: item?.name ?? '', slug: item?.slug ?? path.split(/[\\/]/).pop() ?? '', path }]);
    }
    refresh();
  });
  useLiveEvent('session.status', (event) => {
    if (ids.has(event.data.projectId)) refresh();
  });
  useLiveEvent('stream.reset', () => refresh());

  const toggleFavorite = async (item: ProjectListItem) => {
    const next = !(favorites[item.id] ?? item.favorite);
    setFavorites((current) => ({ ...current, [item.id]: next }));
    try {
      await projectsApi.patch(item.id, { favorite: next });
      refresh();
    } catch (error) {
      setFavorites((current) => ({ ...current, [item.id]: !next }));
      toastless(failureOf(error, 'Le favori n\'a pas pu être enregistré.'));
    }
  };

  // Errors are never toasts (T3 is success only): an inline banner instead.
  const [inlineFailure, setInlineFailure] = useState<Failure | null>(null);
  const toastless = (failure: Failure) => setInlineFailure(failure);

  const sync = async (item: ProjectListItem) => {
    setSyncing((current) => ({ ...current, [item.id]: true }));
    setSyncFailure(null);
    try {
      const result = await projectsApi.sync(item.id);
      toast({
        message:
          result.outcome === 'fast_forward'
            ? `${item.name} synchronisé · ${result.commits} commit${result.commits > 1 ? 's' : ''} récupéré${result.commits > 1 ? 's' : ''}`
            : `${item.name} est à jour`,
      });
      refresh();
    } catch (error) {
      setSyncFailure({ project: item, failure: failureOf(error, 'La synchronisation a échoué.') });
      refresh();
    } finally {
      setSyncing((current) => ({ ...current, [item.id]: false }));
    }
  };

  const retryClone = async (item: ProjectListItem) => {
    setRetrying(item.id);
    setCloneFailure(null);
    try {
      const { operationId } = await projectsApi.retryClone(item.id);
      router.push(`${ADD_HREF}?etape=clonage&projet=${item.id}&operation=${operationId}`);
    } catch (error) {
      setCloneFailure(failureOf(error, 'Le clonage n\'a pas pu reprendre.'));
    } finally {
      setRetrying(null);
    }
  };

  const discard = async (item: ProjectListItem) => {
    setRetrying(item.id);
    try {
      await projectsApi.discard(item.id);
      toast({ message: `${item.name} retiré de la liste` });
      refresh();
    } catch (error) {
      setCloneFailure(failureOf(error, "Le projet n'a pas pu être retiré."));
    } finally {
      setRetrying(null);
    }
  };

  const restore = async (item: ProjectListItem) => {
    try {
      await projectsApi.restore(item.id);
      toast({ message: `${item.name} restauré`, action: { label: 'Ouvrir', href: `/projets/${item.id}` } });
      refresh();
    } catch (error) {
      toastless(failureOf(error, "Le projet n'a pas pu être restauré."));
    }
  };

  const items = data.items.map((item) => ({
    ...item,
    favorite: favorites[item.id] ?? item.favorite,
    sync: { ...item.sync, syncing: item.sync.syncing || Boolean(syncing[item.id]) },
  }));
  const cloning = items.filter((item) => item.status === 'cloning');
  const failed = items.filter((item) => item.status === 'error' && !item.archivedAt);
  const recentlyCloned = cloned.filter((c) => !cloning.some((item) => item.id === c.id));

  const chips = [
    { value: 'tous' as const, label: `Tous · ${data.counts.all}` },
    { value: 'favoris' as const, label: `Favoris · ${data.counts.favorites}` },
    { value: 'archives' as const, label: `Archivés · ${data.counts.archived}` },
  ];

  const hasAnyProject = data.counts.all + data.counts.archived > 0;
  const filtered = query.q !== '' || query.filter !== 'tous';

  return (
    <>
      <PageHeader
        title="Projets"
        subtitle={
          <>
            <span className="hidden nav:inline">{projectsSubtitle(data.counts.all, data.disk, serverName, 'long')}</span>
            <span className="nav:hidden">{projectsSubtitle(data.counts.all, data.disk, serverName, 'short')}</span>
          </>
        }
        actions={
          <Button variant="accent" href={ADD_HREF}>
            Ajouter un projet
          </Button>
        }
        mobileAction={<IconButton icon="plus" label="Ajouter un projet" variant="accent" size="md" href={ADD_HREF} iconSize={20} />}
      />

      {/* T1 / T3 / T4 banners: clone jobs running, finished in this tab, failed. */}
      {cloning.length || recentlyCloned.length || failed.length || syncFailure || inlineFailure || cloneFailure ? (
        <div className="-mt-2 flex flex-col gap-3">
          {cloning.map((item) => {
            const pct = progress[item.id] ?? item.operation?.progress ?? null;
            return (
              <Banner
                key={`cloning-${item.id}`}
                tone="info"
                live
                title={`Clonage de ${item.fullName} en cours`}
                action={
                  item.operation ? (
                    <CompactButton variant="secondaire" href={`${ADD_HREF}?etape=clonage&projet=${item.id}&operation=${item.operation.id}`}>
                      Suivre
                    </CompactButton>
                  ) : null
                }
              >
                {`${pct !== null ? `${pct} % · ` : ''}Le clonage continue sur ${serverName}, même si vous quittez cette page.`}
              </Banner>
            );
          })}
          {recentlyCloned.map((item) => (
            <Banner
              key={`cloned-${item.id}`}
              tone="success"
              title={`Projet cloné sur ${serverName}`}
              action={
                <CompactButton variant="secondaire" href={`/projets/${item.id}`}>
                  Ouvrir
                </CompactButton>
              }
            >
              {`${item.slug} est prêt dans ${item.path}.`}
            </Banner>
          ))}
          {failed.map((item) => (
            <Banner
              key={`failed-${item.id}`}
              tone="danger"
              title={`Le clonage de ${item.fullName} a échoué`}
              action={
                <div className="flex items-center gap-2">
                  <CompactButton variant="secondaire" icon="refresh" loading={retrying === item.id} onClick={() => void retryClone(item)}>
                    Réessayer
                  </CompactButton>
                  <CompactButton variant="discret" disabled={retrying === item.id} onClick={() => void discard(item)}>
                    Retirer
                  </CompactButton>
                </div>
              }
            >
              {[item.statusDetail, `Rien n'est resté sur ${serverName}.`].filter(Boolean).join(' ')}
            </Banner>
          ))}
          {cloneFailure ? <FailureBanner failure={cloneFailure} onDismiss={() => setCloneFailure(null)} /> : null}
          {syncFailure ? (
            <FailureBanner
              title="La synchronisation a échoué"
              failure={{ ...syncFailure.failure, message: `${syncFailure.project.name} : ${syncFailure.failure.message}` }}
              onRetry={() => void sync(syncFailure.project)}
              retrying={Boolean(syncing[syncFailure.project.id])}
              onDismiss={() => setSyncFailure(null)}
            />
          ) : null}
          {inlineFailure ? <FailureBanner failure={inlineFailure} onDismiss={() => setInlineFailure(null)} /> : null}
        </div>
      ) : null}

      {!hasAnyProject ? (
        <EmptyState
          icon="projets"
          title="Aucun projet pour l'instant"
          action={
            <Button variant="accent" href={ADD_HREF}>
              Ajouter un projet
            </Button>
          }
        >
          {`Ajoutez un dépôt GitHub : il sera cloné sur ${serverName}, prêt pour Claude Code.`}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-3 nav:gap-6">
          {/* Toolbar: search (360) · chips · sort (230) */}
          <div className="flex flex-col gap-3 nav:flex-row nav:items-center">
            <SearchField
              aria-label="Rechercher un projet"
              placeholder="Rechercher un projet ou un dépôt…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              size="md"
              shellClassName="hidden w-[360px] shrink-0 nav:flex"
            />
            <SearchField
              aria-label="Rechercher un projet"
              placeholder="Rechercher un projet…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              size="lg"
              shellClassName="nav:hidden"
            />
            <ChipGroup items={chips} value={query.filter} onValueChange={(value) => navigate({ filtre: value })} aria-label="Filtrer les projets" />
            <span className="hidden flex-1 nav:block" />
            <Select
              options={SORT_OPTIONS}
              value={query.sort}
              onValueChange={(value) => navigate({ tri: value })}
              prefix="Trier : "
              aria-label="Trier les projets"
              className="hidden w-[230px] nav:flex"
            />
          </div>

          <div aria-busy={navigating || undefined} className={cn('transition-opacity duration-(--dur-fast)', navigating && 'opacity-60')}>
            {items.length === 0 ? (
              <EmptyState
                icon={query.filter === 'archives' ? 'archive' : query.filter === 'favoris' ? 'star' : 'search'}
                title={
                  query.q
                    ? 'Aucun projet ne correspond'
                    : query.filter === 'archives'
                      ? 'Aucun projet archivé'
                      : 'Aucun projet en favori'
                }
                action={
                  filtered ? (
                    <CompactButton variant="secondaire" onClick={() => { setSearch(''); navigate({ q: '', filtre: 'tous' }); }}>
                      Voir tous les projets
                    </CompactButton>
                  ) : null
                }
              >
                {query.q
                  ? `Aucun nom, dépôt ou dossier ne contient « ${query.q} ».`
                  : query.filter === 'archives'
                    ? 'Un projet archivé quitte la liste et reste ici, avec son dépôt et son clone intacts.'
                    : "Touchez l'étoile d'un projet pour le retrouver ici, en tête de liste."}
              </EmptyState>
            ) : (
              <>
                {/* Desktop table (D02) */}
                <Tile padding="none" className="hidden px-5 py-2 nav:block">
                  <div role="table" aria-label="Projets">
                    <div role="rowgroup">
                      <div role="row">
                        <ProjectTableHeader />
                      </div>
                    </div>
                    <div role="rowgroup">
                      {items.map((item) => (
                        <div role="row" key={item.id} className="border-b border-border last:border-b-0 [&>*]:border-b-0">
                          {item.status === 'ready' && !item.archivedAt ? (
                            <ProjectRow
                              name={item.name}
                              repoFullName={item.fullName}
                              branch={item.branch}
                              sync={item.sync}
                              sessions={projectSessionsSummary(item.sessions)}
                              lastActivityAt={item.lastActivityAt}
                              favorite={item.favorite}
                              onToggleFavorite={() => void toggleFavorite(item)}
                              href={`/projets/${item.id}`}
                              actions={
                                <>
                                  <CompactButton variant="secondaire" href={`/projets/${item.id}`}>
                                    Ouvrir
                                  </CompactButton>
                                  <RowMenu
                                    item={item}
                                    onFavorite={() => void toggleFavorite(item)}
                                    onSync={() => void sync(item)}
                                    onBranch={() => setBranchTarget(item)}
                                    onSession={() => setSessionTarget(item)}
                                    onArchive={() => setArchiveTarget(item)}
                                  />
                                </>
                              }
                            />
                          ) : (
                            <PendingRow
                              item={item}
                              progress={progress[item.id] ?? item.operation?.progress ?? null}
                              onRestore={() => void restore(item)}
                              onRetry={() => void retryClone(item)}
                              onDiscard={() => void discard(item)}
                              busy={retrying === item.id}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </Tile>

                {/* Phone cards (M02) */}
                <ul className="m-0 flex list-none flex-col gap-3 p-0 nav:hidden" aria-label="Projets">
                  {items.map((item) => (
                    <li key={item.id}>
                      {item.status === 'ready' && !item.archivedAt ? (
                        <ProjectRow
                          variant="card"
                          name={item.name}
                          repoFullName={item.fullName}
                          branch={item.branch}
                          sync={item.sync}
                          sessions={projectSessionsSummary(item.sessions)}
                          lastActivityAt={item.lastActivityAt}
                          favorite={item.favorite}
                          onToggleFavorite={() => void toggleFavorite(item)}
                          href={`/projets/${item.id}`}
                        />
                      ) : (
                        <PendingCard
                          item={item}
                          progress={progress[item.id] ?? item.operation?.progress ?? null}
                          onRestore={() => void restore(item)}
                          onRetry={() => void retryClone(item)}
                          busy={retrying === item.id}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          <p className="m-0 hidden items-center gap-2 font-sans text-app-13 text-muted nav:flex">
            <Icon name="archive" size={16} className="text-muted" />
            {`Archiver retire un projet de cette liste et peut libérer son espace sur ${serverName}, après confirmation. Le dépôt GitHub n'est jamais supprimé.`}
          </p>
        </div>
      )}

      <ArchiveProjectDialog
        open={archiveTarget !== null}
        onOpenChange={(open) => !open && setArchiveTarget(null)}
        project={archiveTarget}
        onArchived={refresh}
      />
      {branchTarget ? (
        <NewBranchDialog
          open
          onOpenChange={(open) => !open && setBranchTarget(null)}
          project={branchTarget}
          onCreated={refresh}
        />
      ) : null}
      <NewSessionDialog
        open={sessionTarget !== null}
        onOpenChange={(open) => !open && setSessionTarget(null)}
        defaultProjectId={sessionTarget?.id ?? null}
      />
    </>
  );
}

function RowMenu({
  item,
  onFavorite,
  onSync,
  onBranch,
  onSession,
  onArchive,
}: {
  item: ProjectListItem;
  onFavorite: () => void;
  onSync: () => void;
  onBranch: () => void;
  onSession: () => void;
  onArchive: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton icon="more" label={`Actions pour ${item.name}`} size="sm" iconSize={18} iconClassName="text-muted" />
      </DropdownMenuTrigger>
      <DropdownMenuContent width={248}>
        <DropdownMenuItem icon="star" onSelect={onFavorite}>
          {item.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
        </DropdownMenuItem>
        <DropdownMenuItem icon="refresh" onSelect={onSync} disabled={item.sync.syncing}>
          Synchroniser maintenant
        </DropdownMenuItem>
        <DropdownMenuItem icon="git-branch" onSelect={onBranch}>
          Nouvelle branche…
        </DropdownMenuItem>
        <DropdownMenuItem icon="terminal" onSelect={onSession}>
          Nouvelle session ici
        </DropdownMenuItem>
        <DropdownMenuItem icon="archive" destructive onSelect={onArchive}>
          Archiver le projet…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Row of a project that is cloning, whose clone failed, or archived (same grid as `Dev · Ligne de projet`). */
function PendingRow({
  item,
  progress,
  onRestore,
  onRetry,
  onDiscard,
  busy,
}: {
  item: ProjectListItem;
  progress: number | null;
  onRestore: () => void;
  onRetry: () => void;
  onDiscard: () => void;
  busy: boolean;
}) {
  const badge = projectBadge(item, 'long');
  return (
    <div className={cn(PROJECT_TABLE_GRID, 'py-3.5')}>
      <div className="flex min-w-0 items-center gap-3">
        <Icon name={item.archivedAt ? 'archive' : 'projets'} size={18} className="text-muted" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {item.archivedAt ? (
            <Link href={`/projets/${item.id}`} className="truncate font-sans text-app-15 font-semibold text-text hover:underline">
              {item.name}
            </Link>
          ) : (
            <p className="m-0 truncate font-sans text-app-15 font-semibold text-text">{item.name}</p>
          )}
          <p className="m-0 flex min-w-0 items-center gap-1.5">
            <Icon name="github" size={12} className="text-muted" />
            <span className="truncate font-mono text-app-11 text-muted">{item.fullName}</span>
          </p>
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        {item.branch ? (
          <>
            <Icon name="git-branch" size={14} className="text-muted" />
            <span className="truncate font-mono text-app-12 text-text">{item.branch}</span>
          </>
        ) : null}
      </div>
      <div className="flex min-w-0">
        <Badge tone={badge.tone}>{item.status === 'cloning' && progress !== null ? `${badge.label} ${progress} %` : badge.label}</Badge>
      </div>
      <div className="min-w-0 truncate font-sans text-app-13 text-muted">{item.archivedAt ? 'archivé' : '—'}</div>
      <div className="min-w-0" />
      <div className="flex min-w-0 items-center justify-end gap-1">
        {item.archivedAt ? (
          <CompactButton variant="secondaire" onClick={onRestore}>
            Restaurer
          </CompactButton>
        ) : item.status === 'error' ? (
          <>
            <CompactButton variant="secondaire" onClick={onRetry} loading={busy}>
              Réessayer
            </CompactButton>
            <IconButton icon="trash" label={`Retirer ${item.name}`} size="sm" iconClassName="text-muted" onClick={onDiscard} disabled={busy} />
          </>
        ) : item.operation ? (
          <CompactButton variant="secondaire" href={`${ADD_HREF}?etape=clonage&projet=${item.id}&operation=${item.operation.id}`}>
            Suivre
          </CompactButton>
        ) : null}
      </div>
    </div>
  );
}

function PendingCard({
  item,
  progress,
  onRestore,
  onRetry,
  busy,
}: {
  item: ProjectListItem;
  progress: number | null;
  onRestore: () => void;
  onRetry: () => void;
  busy: boolean;
}) {
  const badge = projectBadge(item, 'short');
  return (
    <Card variant="card" as="article" className="flex flex-col gap-2">
      <div className="flex items-center gap-2.5">
        <Icon name={item.archivedAt ? 'archive' : 'projets'} size={18} className="text-muted" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="m-0 truncate font-sans text-app-16 font-semibold text-text">{item.name}</p>
          <span className="truncate font-mono text-app-11 text-muted">{item.fullName}</span>
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <Badge tone={badge.tone}>{item.status === 'cloning' && progress !== null ? `${badge.label} ${progress} %` : badge.label}</Badge>
        <span className="flex-1" />
        {item.archivedAt ? (
          <CompactButton variant="secondaire" size="lg" onClick={onRestore}>
            Restaurer
          </CompactButton>
        ) : item.status === 'error' ? (
          <CompactButton variant="secondaire" size="lg" onClick={onRetry} loading={busy}>
            Réessayer
          </CompactButton>
        ) : item.operation ? (
          <CompactButton variant="secondaire" size="lg" href={`${ADD_HREF}?etape=clonage&projet=${item.id}&operation=${item.operation.id}`}>
            Suivre
          </CompactButton>
        ) : null}
      </div>
    </Card>
  );
}

