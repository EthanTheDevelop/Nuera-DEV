'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { formatDuration } from '@nuera/shared/format';
import { HistoryRow, HistoryTableHeader, LiveTime, SEP, historyStatusMeta, joinParts } from '@/components/dev';
import { Icon } from '@/components/icons';
import {
  Badge,
  Card,
  ChipGroup,
  CompactButton,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  ErrorPanel,
  IconButton,
  SearchField,
  SectionLabel,
  Select,
  Sheet,
  SheetContent,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { fetchHistoryPage } from '../api';
import {
  DEFAULT_HISTORY_PERIOD,
  HISTORY_FILTERS,
  HISTORY_FILTER_LABELS,
  HISTORY_PERIODS,
  HISTORY_PERIOD_LABELS,
  PHONE_HISTORY_FILTERS,
  historySearch,
  workspaceUrl,
  type HistoryFilter,
  type HistoryPeriod,
  type HistoryUrlState,
  type SessionListItem,
  type SessionListPage,
} from '../lib/contract';
import { historyAction } from '../lib/view';
import type { SessionActions } from '../useSessionActions';
import { resumeBlockedText } from '../useSessionActions';
import type { SectionLoad } from './SessionsView';

const ALL_PROJECTS = 'tous';
/** D06 columns, each fixed one a little narrower to make room for the « … » menu (SESSION keeps ≈ 200 px at 1440). */
const GRID = 'grid-cols-[minmax(0,1fr)_130px_160px_160px_190px_120px]';
const SEARCH_DEBOUNCE_MS = 300;

interface HistorySectionProps {
  filters: HistoryUrlState;
  history: SectionLoad<SessionListPage>;
  projects: Array<{ id: string; name: string }>;
  actions: SessionActions;
}

/**
 * « HISTORIQUE » — D06: search + Projet / Statut / période dropdowns, table (`Dev · Ligne
 * d'historique`), « Afficher plus », footnote; M06: search icon, status chips, two-line rows that
 * open a sheet with the row actions. Filters live in the URL (?filtre=&periode=&projet=&q=).
 */
export function HistorySection({ filters, history, projects, actions }: HistorySectionProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [q, setQ] = useState(filters.q);
  const [searchOpen, setSearchOpen] = useState(Boolean(filters.q));
  const [items, setItems] = useState<SessionListItem[]>(history.ok ? history.data.items : []);
  const [cursor, setCursor] = useState<string | null>(history.ok ? history.data.nextCursor : null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [sheetItem, setSheetItem] = useState<SessionListItem | null>(null);

  // New server data (filters changed, refresh after an action or a live event) replaces the pages.
  const [snapshot, setSnapshot] = useState(history);
  if (snapshot !== history) {
    setSnapshot(history);
    if (history.ok) {
      setItems(history.data.items);
      setCursor(history.data.nextCursor);
      setMoreError(null);
    }
  }
  // The URL changed from elsewhere (back / forward): the field follows.
  const [urlQ, setUrlQ] = useState(filters.q);
  if (urlQ !== filters.q) {
    setUrlQ(filters.q);
    setQ(filters.q);
  }

  /**
   * Filter changes push a history entry (« Précédent » restores the previous filter); the debounced
   * search replaces it (one entry per search, not per keystroke). An identical URL is never pushed.
   */
  const navigate = useCallback(
    (next: Partial<HistoryUrlState>, mode: 'push' | 'replace' = 'push') => {
      const state = { ...filters, ...next };
      const current = typeof window === 'undefined' ? '' : window.location.search;
      const target = `${pathname}${historySearch(state, new URLSearchParams(current))}`;
      if (typeof window !== 'undefined' && target === `${window.location.pathname}${current}`) return;
      startTransition(() => (mode === 'push' ? router.push(target, { scroll: false }) : router.replace(target, { scroll: false })));
    },
    [filters, pathname, router],
  );

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSearch = (value: string) => {
    setQ(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => navigate({ q: value.trim() }, 'replace'), SEARCH_DEBOUNCE_MS);
  };
  useEffect(() => () => {
    if (debounce.current) clearTimeout(debounce.current);
  }, []);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await fetchHistoryPage({ filter: filters.filter, period: filters.period, projectId: filters.projectId, q: filters.q, cursor });
      setItems((current) => [...current, ...page.items.filter((item) => !current.some((c) => c.id === item.id))]);
      setCursor(page.nextCursor);
    } catch (error) {
      setMoreError(error instanceof Error ? error.message : "La suite de l'historique n'a pas pu être chargée.");
    } finally {
      setLoadingMore(false);
    }
  };

  const filtered = filters.filter !== 'toutes' || Boolean(filters.projectId) || Boolean(filters.q);
  const projectOptions = [{ value: ALL_PROJECTS, label: 'tous' }, ...projects.map((p) => ({ value: p.id, label: p.name }))];
  const statusOptions = HISTORY_FILTERS.map((value) => ({ value, label: HISTORY_FILTER_LABELS[value].select }));
  const periodOptions = HISTORY_PERIODS.map((value) => ({ value, label: HISTORY_PERIOD_LABELS[value] }));

  return (
    <section aria-labelledby="sessions-historique" className="flex min-w-0 flex-col gap-3 nav:gap-4">
      <div className="flex min-h-11 items-center gap-3 nav:min-h-0">
        <SectionLabel as="h2" id="sessions-historique" className="flex-1">
          Historique
        </SectionLabel>
        <IconButton
          icon={searchOpen ? 'x' : 'search'}
          label={searchOpen ? 'Fermer la recherche' : 'Rechercher une session'}
          size="md"
          iconSize={20}
          className="nav:hidden"
          aria-expanded={searchOpen}
          onClick={() => {
            if (searchOpen && q) onSearch('');
            setSearchOpen((open) => !open);
          }}
        />
      </div>

      {/* Desktop filters */}
      <div className="hidden flex-wrap items-center gap-3 nav:flex" role="search" aria-label="Filtrer l'historique">
        <SearchField
          value={q}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Rechercher une session…"
          aria-label="Rechercher une session"
          shellClassName="w-[320px]"
        />
        <Select
          options={projectOptions}
          value={filters.projectId ?? ALL_PROJECTS}
          onValueChange={(value) => navigate({ projectId: value === ALL_PROJECTS ? null : value })}
          prefix="Projet : "
          aria-label="Projet"
          className="w-[180px]"
        />
        <Select
          options={statusOptions}
          value={filters.filter}
          onValueChange={(value) => navigate({ filter: value as HistoryFilter })}
          prefix="Statut : "
          aria-label="Statut"
          className="w-[180px]"
        />
        <Select
          options={periodOptions}
          value={filters.period}
          onValueChange={(value) => navigate({ period: value as HistoryPeriod })}
          aria-label="Période"
          className="w-[200px]"
        />
      </div>

      {/* Phone filters */}
      <div className="flex min-w-0 flex-col gap-3 nav:hidden">
        {searchOpen ? (
          <SearchField value={q} onChange={(e) => onSearch(e.target.value)} placeholder="Rechercher une session…" aria-label="Rechercher une session" size="lg" autoFocus />
        ) : null}
        <ChipGroup
          aria-label="Statut des sessions"
          items={PHONE_HISTORY_FILTERS.map((value) => ({ value, label: HISTORY_FILTER_LABELS[value].chip }))}
          value={(PHONE_HISTORY_FILTERS as readonly string[]).includes(filters.filter) ? filters.filter : 'toutes'}
          onValueChange={(value) => navigate({ filter: value })}
        />
      </div>

      <div className={cn('flex min-w-0 flex-col gap-3 transition-opacity duration-(--dur-fast)', isPending && 'opacity-60')} aria-busy={isPending || undefined}>
        {!history.ok ? (
          <ErrorPanel
            title="L'historique n'a pas pu être chargé"
            excerpt={history.error.detail ? `${history.error.message} ${history.error.detail}` : history.error.message}
            untouched="Aucune session n'a été modifiée."
            raw={history.error.raw ?? null}
            onRetry={() => router.refresh()}
            retryLabel="Réessayer"
          />
        ) : items.length === 0 ? (
          <HistoryEmpty
            filtered={filtered}
            period={filters.period}
            onReset={() => {
              setQ('');
              navigate({ filter: 'toutes', projectId: null, q: '', period: DEFAULT_HISTORY_PERIOD });
            }}
            onAllTime={() => navigate({ period: 'tout' })}
          />
        ) : (
          <>
            <Card variant="tile" padding="none" className="hidden px-5 py-2 nav:flex" as="div">
              <div className="flex items-center gap-2 border-b border-border" aria-hidden>
                <HistoryTableHeader className={cn('min-w-0 flex-1 border-b-0', GRID)} />
                <span className="w-9 shrink-0" />
              </div>
              <ul className="m-0 flex min-w-0 list-none flex-col p-0" aria-label="Historique des sessions">
                {items.map((item) => (
                  <DesktopRow key={item.id} item={item} actions={actions} />
                ))}
              </ul>
            </Card>
            <Card variant="card" padding="none" className="px-4 py-1 nav:hidden" as="div">
              <ul className="m-0 flex list-none flex-col p-0" aria-label="Historique des sessions">
                {items.map((item) => (
                  <li key={item.id} className="relative border-b border-border last:border-b-0">
                    <HistoryRow
                      variant="list"
                      title={item.title}
                      projectName={item.project.name}
                      branch={item.branch}
                      status={item.status}
                      resumable={item.resumable}
                      startedAt={item.startedAt ?? item.createdAt}
                      durationMs={item.durationMs}
                      className="border-b-0 pr-7"
                    />
                    <Icon name="chevron" size={18} className="pointer-events-none absolute top-1/2 right-0 -translate-y-1/2 text-muted" />
                    <button
                      type="button"
                      className="absolute inset-0 cursor-pointer rounded-sm"
                      aria-label={`${item.title} · ${historyStatusMeta(item.status, item.resumable).shortLabel} · actions`}
                      onClick={() => setSheetItem(item)}
                    />
                  </li>
                ))}
              </ul>
            </Card>
            {cursor || moreError ? (
              <div className="flex flex-col items-center gap-2">
                {moreError ? <p className="m-0 font-sans text-app-13 text-danger" role="alert">{moreError}</p> : null}
                {cursor ? (
                  <CompactButton variant="secondaire" icon="chevron-down" loading={loadingMore} onClick={() => void loadMore()}>
                    Afficher plus de sessions
                  </CompactButton>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>

      <p className="m-0 hidden font-sans text-app-12 leading-[17px] text-muted nav:block">
        Reprendre rouvre la conversation enregistrée par Claude Code (claude --resume) dans son worktree. Une reprise devient impossible quand ce worktree a été supprimé ; l'historique reste lisible.
      </p>

      <RowSheet item={sheetItem} onClose={() => setSheetItem(null)} actions={actions} />
    </section>
  );
}

function mainAction(item: SessionListItem, actions: SessionActions) {
  const kind = historyAction(item);
  const pending = actions.pending?.id === item.id && actions.pending.kind === 'resume';
  switch (kind) {
    case 'resume':
      return { onClick: () => void actions.resume(item), loading: pending };
    case 'why':
      return { onClick: () => actions.explainResume(item) };
    default:
      return { href: workspaceUrl(item.id) };
  }
}

function DesktopRow({ item, actions }: { item: SessionListItem; actions: SessionActions }) {
  return (
    <li className="flex items-center gap-2 border-b border-border last:border-b-0" data-session-id={item.id}>
      <HistoryRow
        variant="table"
        title={item.title}
        projectName={item.project.name}
        branch={item.branch}
        status={item.status}
        resumable={item.resumable}
        startedAt={item.startedAt ?? item.createdAt}
        durationMs={item.durationMs}
        action={mainAction(item, actions)}
        className={cn('min-w-0 flex-1 border-b-0', GRID)}
      />
      <RowMenu item={item} actions={actions} />
    </li>
  );
}

function RowMenu({ item, actions }: { item: SessionListItem; actions: SessionActions }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton icon="more" label={`Autres actions · ${item.title}`} size="sm" iconClassName="text-muted" className="shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent width={220}>
        <DropdownMenuLinkItem href={workspaceUrl(item.id)} icon="terminal">
          Ouvrir le Workspace
        </DropdownMenuLinkItem>
        {item.status === 'finished' && item.resumable ? (
          <DropdownMenuItem icon="play" onSelect={() => void actions.resume(item)}>
            Reprendre
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem icon="edit" onSelect={() => actions.requestRename(item)}>
          Renommer
        </DropdownMenuItem>
        {item.status !== 'archived' ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon="archive" onSelect={() => actions.requestArchive(item)}>
              Archiver
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** M06 row sheet (not drawn: « On mobile they go on the detail screen or a row sheet »). */
function RowSheet({ item, onClose, actions }: { item: SessionListItem | null; onClose: () => void; actions: SessionActions }) {
  const meta = item ? historyStatusMeta(item.status, item.resumable) : null;
  const kind = item ? historyAction(item) : null;
  const run = (fn: () => void) => {
    onClose();
    fn();
  };
  return (
    <Sheet open={item !== null} onOpenChange={(open) => !open && onClose()}>
      {item && meta ? (
        <SheetContent title={item.title} meta={<Badge tone={meta.tone}>{meta.shortLabel}</Badge>}>
          <div className="flex flex-col gap-4 pt-1">
            <div className="flex flex-col gap-1">
              <p className="m-0 truncate font-mono text-app-11 text-muted">{joinParts(item.project.name, item.branch)}</p>
              <p className="m-0 font-sans text-app-13 text-muted">
                <LiveTime value={item.startedAt ?? item.createdAt} format="datetime" />
                {item.durationMs !== null ? `${SEP}${formatDuration(item.durationMs)}` : null}
              </p>
            </div>
            {kind === 'why' ? (
              <p className="m-0 rounded-md border border-border bg-surface-raised px-3.5 py-3 font-sans text-app-13 leading-[18px] text-text">{resumeBlockedText(item)}</p>
            ) : null}
            <div className="flex flex-col gap-2">
              {kind === 'resume' ? (
                <CompactButton variant="principal" size="lg" block icon="play" loading={actions.pending?.id === item.id} onClick={() => run(() => void actions.resume(item))}>
                  Reprendre
                </CompactButton>
              ) : kind === 'summary' ? (
                <CompactButton variant="principal" size="lg" block href={workspaceUrl(item.id)}>
                  Voir le résumé
                </CompactButton>
              ) : (
                <CompactButton variant="principal" size="lg" block href={workspaceUrl(item.id)}>
                  {kind === 'why' ? "Voir l'historique" : 'Voir'}
                </CompactButton>
              )}
              <CompactButton variant="secondaire" size="lg" block icon="edit" onClick={() => run(() => actions.requestRename(item))}>
                Renommer
              </CompactButton>
              {item.status !== 'archived' ? (
                <CompactButton variant="secondaire" size="lg" block icon="archive" onClick={() => run(() => actions.requestArchive(item))}>
                  Archiver
                </CompactButton>
              ) : null}
            </div>
          </div>
        </SheetContent>
      ) : null}
    </Sheet>
  );
}

function HistoryEmpty({ filtered, period, onReset, onAllTime }: { filtered: boolean; period: HistoryPeriod; onReset: () => void; onAllTime: () => void }) {
  if (filtered) {
    return (
      <EmptyState
        icon="history"
        title="Aucune session ne correspond"
        action={
          <CompactButton variant="secondaire" icon="x" onClick={onReset}>
            Effacer les filtres
          </CompactButton>
        }
      >
        Aucune session de l'historique ne correspond à ces filtres.
      </EmptyState>
    );
  }
  return (
    <EmptyState
      icon="history"
      title="Aucune session dans l'historique"
      action={
        period !== 'tout' ? (
          <CompactButton variant="secondaire" onClick={onAllTime}>
            Voir toute la période
          </CompactButton>
        ) : undefined
      }
    >
      {period !== 'tout'
        ? `Aucune session arrêtée, terminée ou archivée sur les ${HISTORY_PERIOD_LABELS[period].replace(' derniers jours', '')} derniers jours.`
        : 'Les sessions arrêtées, terminées ou archivées apparaissent ici.'}
    </EmptyState>
  );
}
