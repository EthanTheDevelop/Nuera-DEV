'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { COMMAND_KIND_LABEL } from '@/components/dev';
import { Icon } from '@/components/icons';
import {
  Badge,
  Banner,
  Button,
  CompactButton,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Sheet,
  SheetContent,
  Tabs,
  TabsList,
  TabsTrigger,
  toast,
} from '@/components/ui';
import { NewSessionButton, NewSessionDialog, workspaceUrl } from '@/features/sessions';
import { useLiveEvent } from '@/hooks/useLiveEvents';
import { useNow } from '@/hooks/useNow';
import { cn } from '@/lib/cn';
import type { EnvVarView, ProjectCommandKind, ProjectDetail, ProjectMcpToolView, RunView, WorktreeView } from '@/server/projects/types';
import { failureOf, projectsApi } from '../api';
import { ArchiveProjectDialog } from '../ArchiveProjectDialog';
import { projectBadge } from '../badges';
import { FailureBanner, type Failure } from '../FailureBanner';
import { syncedAgo } from '../format';
import { useServerName, useThrottledRefresh, writeSearchParams } from '../hooks';
import { NewBranchDialog } from '../NewBranchDialog';
import { ClaudeMdEditor, CommandsDialog, EnvVarDialog, RemoveWorktreeDialog, RunOutputDialog, type EnvDialogTarget } from './dialogs';
import { parseTab, projectTabs, type ProjectTab } from './model';
import { BranchesTile, ClaudeMdTile, EnvVarsTile, EnvironmentTile, McpTile, RunHistoryTile, SessionsTile, WorktreesTile, type TileContext } from './tiles';

export interface ProjectDetailViewProps {
  detail: ProjectDetail;
  /** Server time of the render (SSR / hydration of relative times). */
  generatedAt: number;
}

/**
 * D04 (desktop: header, 7 Badge tabs, the designed overview grid) and M04 (phone: top bar, identity,
 * branch selector, scrollable chips, 3 cards, sticky « Ouvrir le Workspace »). Tabs in ?onglet=.
 * Live: run.status (command badges), session.status, operation.progress (sync / branch / worktree
 * operations) → targeted state or a throttled `router.refresh()`.
 */
export function ProjectDetailView({ detail, generatedAt }: ProjectDetailViewProps) {
  const params = useSearchParams();
  const tab = parseTab(params.get('onglet'));
  const serverName = useServerName(detail.environment.name);
  const refresh = useThrottledRefresh();
  const now = useNow(30_000, generatedAt);
  const project = detail.project;

  const [runs, setRuns] = useState<Partial<Record<string, RunView>>>(detail.runs.latest);
  const [runPending, setRunPending] = useState<Partial<Record<string, boolean>>>({});
  const [mcp, setMcp] = useState(detail.mcp);
  const [mcpPending, setMcpPending] = useState<Partial<Record<string, boolean>>>({});
  const [syncing, setSyncing] = useState(false);
  const [remoteSync, setRemoteSync] = useState(false);
  const [checkoutPending, setCheckoutPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ title: string; failure: Failure; retry?: () => void } | null>(null);
  const [favorite, setFavorite] = useState(project.favorite);
  const [dialogs, setDialogs] = useState<{
    branch: boolean;
    archive: boolean;
    claudeMd: boolean;
    commands: boolean;
    session: boolean;
    actions: boolean;
    branches: boolean;
    env: EnvDialogTarget | null;
    run: RunView | null;
    worktree: WorktreeView | null;
  }>({ branch: false, archive: false, claudeMd: false, commands: false, session: false, actions: false, branches: false, env: null, run: null, worktree: null });
  const open = (patch: Partial<typeof dialogs>) => setDialogs((current) => ({ ...current, ...patch }));

  // Fresh server data replaces the local copies (adjusted during render, no extra effect pass).
  const [seenDetail, setSeenDetail] = useState(detail);
  if (seenDetail !== detail) {
    setSeenDetail(detail);
    setRuns(detail.runs.latest);
    setMcp(detail.mcp);
    setFavorite(detail.project.favorite);
  }

  useLiveEvent('run.status', (event) => {
    const run = event.data.run;
    if (run.projectId !== project.id) return;
    setRuns((current) => {
      const previous = current[run.kind];
      if (previous && previous.id !== run.id && Date.parse(previous.startedAt) > Date.parse(run.startedAt)) return current;
      const counts = run.tests?.counts;
      return {
        ...current,
        [run.kind]: {
          id: run.id,
          kind: run.kind,
          command: run.command,
          status: run.status,
          exitCode: run.exitCode,
          port: run.port,
          summary: run.summary,
          worktreeId: run.worktreeId,
          worktreeName: previous?.id === run.id ? previous.worktreeName : null,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          tests: counts ? { passed: counts.passed, failed: counts.failed, skipped: counts.skipped, total: counts.total } : (previous?.tests ?? null),
        },
      };
    });
    if (run.status !== 'running') refresh();
  });
  useLiveEvent('session.status', (event) => {
    if (event.data.projectId === project.id) refresh();
  });
  useLiveEvent('operation.progress', (event) => {
    const op = event.data.operation;
    if (op.projectId !== project.id) return;
    const running = op.status === 'running' || op.status === 'queued';
    if (op.kind === 'fetch' || op.kind === 'pull') setRemoteSync(running);
    if (!running) refresh();
  });
  useLiveEvent('stream.reset', () => refresh());

  const ready = project.status === 'ready' && !project.archivedAt;
  const blockedReason = project.archivedAt
    ? 'Projet archivé : restaurez-le pour lancer des commandes.'
    : project.status === 'cloning'
      ? 'Le clonage est en cours.'
      : project.status === 'error'
        ? "Le clone n'existe pas : le clonage a échoué."
        : !detail.runnerAvailable
          ? `${serverName} ne répond pas.`
          : null;

  const setTab = (value: string) => writeSearchParams({ onglet: value === 'vue-d-ensemble' ? null : value }, 'push');

  // M04: the chip row scrolls; keep the selected chip in view (deep link ?onglet=, back / forward).
  const phoneChips = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = phoneChips.current?.querySelector<HTMLElement>('[role="tablist"]');
    const active = list?.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
    if (!list || !active) return;
    const left = active.getBoundingClientRect().left - list.getBoundingClientRect().left + list.scrollLeft;
    if (left < list.scrollLeft || left + active.offsetWidth > list.scrollLeft + list.clientWidth) {
      list.scrollLeft = Math.max(0, left - (list.clientWidth - active.offsetWidth) / 2);
    }
  // eslint-disable-next-line react/exhaustive-effect-dependencies -- tab is the trigger: re-center the selected chip
  }, [tab]);

  // --- Actions ---------------------------------------------------------------------------------
  const sync = async () => {
    setSyncing(true);
    setFailure(null);
    try {
      const result = await projectsApi.sync(project.id);
      toast({
        message:
          result.outcome === 'fast_forward'
            ? `${project.name} synchronisé · ${result.commits} commit${result.commits > 1 ? 's' : ''} récupéré${result.commits > 1 ? 's' : ''}`
            : `${project.name} est à jour`,
      });
    } catch (error) {
      setFailure({ title: 'La synchronisation a échoué', failure: failureOf(error, 'La synchronisation a échoué.'), retry: () => void sync() });
    } finally {
      setSyncing(false);
      refresh();
    }
  };

  const run = async (kind: ProjectCommandKind) => {
    setRunPending((current) => ({ ...current, [kind]: true }));
    setFailure(null);
    try {
      const { runId } = await projectsApi.startRun({ projectId: project.id, kind });
      const command = (project.commands as Record<string, string | null | undefined>)[kind] ?? '';
      const optimistic: RunView = {
        id: runId,
        kind,
        command,
        status: 'running',
        exitCode: null,
        port: null,
        summary: null,
        worktreeId: project.primaryWorktreeId,
        worktreeName: null,
        // eslint-disable-next-line react/purity -- false positive: inside an async click handler, not during render
        startedAt: new Date().toISOString(),
        finishedAt: null,
        tests: null,
      };
      setRuns((current) => ({ ...current, [kind]: optimistic }));
      toast({ message: `${COMMAND_KIND_LABEL[kind]} lancé${kind === 'install' ? 'e' : ''} : ${command}`, action: { label: 'Voir la sortie', onClick: () => open({ run: optimistic }) } });
    } catch (error) {
      setFailure({ title: `${COMMAND_KIND_LABEL[kind]} : la commande n'a pas démarré`, failure: failureOf(error, "La commande n'a pas démarré."), retry: () => void run(kind) });
    } finally {
      setRunPending((current) => ({ ...current, [kind]: false }));
    }
  };

  const stop = async (target: RunView) => {
    setRunPending((current) => ({ ...current, [target.kind]: true }));
    try {
      await projectsApi.stopRun(target.id);
      toast({ message: `${target.command} arrêté` });
      refresh();
    } catch (error) {
      setFailure({ title: "La commande n'a pas pu être arrêtée", failure: failureOf(error, "La commande n'a pas pu être arrêtée.") });
    } finally {
      setRunPending((current) => ({ ...current, [target.kind]: false }));
    }
  };

  const checkout = async (branch: string) => {
    setCheckoutPending(branch);
    setFailure(null);
    try {
      await projectsApi.checkout(project.id, branch);
      toast({ message: `${project.name} est sur ${branch}` });
      open({ branches: false });
      refresh();
    } catch (error) {
      setFailure({ title: `Impossible de passer sur ${branch}`, failure: failureOf(error, 'Le changement de branche a échoué.') });
      open({ branches: false });
    } finally {
      setCheckoutPending(null);
    }
  };

  const toggleMcp = async (tool: ProjectMcpToolView, enabled: boolean) => {
    setMcpPending((current) => ({ ...current, [tool.id]: true }));
    if (mcp.ok) setMcp({ ok: true, data: mcp.data.map((item) => (item.id === tool.id ? { ...item, enabled } : item)) });
    try {
      await projectsApi.setMcp(project.id, tool.id, enabled);
      toast({ message: `${tool.label} ${enabled ? 'activé' : 'désactivé'} pour ${project.name} · prochaines sessions` });
      refresh();
    } catch (error) {
      if (mcp.ok) setMcp({ ok: true, data: mcp.data.map((item) => (item.id === tool.id ? { ...item, enabled: !enabled } : item)) });
      setFailure({ title: `${tool.label} n'a pas pu être ${enabled ? 'activé' : 'désactivé'}`, failure: failureOf(error, 'Le réglage MCP a échoué.') });
    } finally {
      setMcpPending((current) => ({ ...current, [tool.id]: false }));
    }
  };

  const toggleFavorite = async () => {
    const next = !favorite;
    setFavorite(next);
    try {
      await projectsApi.patch(project.id, { favorite: next });
      refresh();
    } catch (error) {
      setFavorite(!next);
      setFailure({ title: "Le favori n'a pas pu être enregistré", failure: failureOf(error, 'Erreur.') });
    }
  };

  const restore = async () => {
    try {
      await projectsApi.restore(project.id);
      toast({ message: `${project.name} restauré` });
      refresh();
    } catch (error) {
      setFailure({ title: "Le projet n'a pas pu être restauré", failure: failureOf(error, 'Erreur.') });
    }
  };

  const ctx: TileContext = {
    detail: { ...detail, mcp },
    now,
    serverName,
    blockedReason,
    runs,
    runPending,
    onRun: (kind) => void run(kind),
    onStop: (target) => void stop(target),
    onShowRun: (target) => open({ run: target }),
    onNewBranch: () => open({ branch: true }),
    onCheckout: (branch) => void checkout(branch),
    checkoutPending,
    onRemoveWorktree: (worktree) => open({ worktree }),
    onEditClaudeMd: () => open({ claudeMd: true }),
    mcpPending,
    onToggleMcp: (tool, enabled) => void toggleMcp(tool, enabled),
    onAddEnv: () => open({ env: { mode: 'add' } }),
    onEditEnv: (variable: EnvVarView) => open({ env: { mode: 'edit', variable } }),
    onEditCommands: () => open({ commands: true }),
    onShowTab: (value) => setTab(value),
    onRetry: refresh,
  };

  const badge = projectBadge({ status: project.status, archivedAt: project.archivedAt, sync: { ...project.sync, syncing: project.sync.syncing || syncing || remoteSync } }, 'long');
  const phoneBadge = projectBadge({ status: project.status, archivedAt: project.archivedAt, sync: { ...project.sync, syncing: project.sync.syncing || syncing || remoteSync } }, 'short');
  const liveSessionId = detail.sessions.liveSessionId;
  const sessionDisabled = !ready ? blockedReason : !detail.runnerAvailable ? `${serverName} ne répond pas.` : null;
  const localBranches = detail.branches.ok ? detail.branches.data.items.filter((branch) => branch.kind === 'local') : [];
  const branchCount = detail.counts.branches;
  const tabs = projectTabs(detail.counts);
  const synced = syncedAgo(project.lastSyncedAt ?? project.lastFetchedAt, now);

  // Desktop: the big header Button. Phone (M04 `Barre d'action`): `Bouton compact` Principal stretched to
  // 44 px with icon/terminal 16 (screens-mobile.md §1.6, §2 « Primary button (mobile) »).
  const workspaceButton = (block: boolean) =>
    block ? (
      liveSessionId ? (
        <CompactButton variant="principal" size="lg" block icon="terminal" href={workspaceUrl(liveSessionId)}>
          Ouvrir le Workspace
        </CompactButton>
      ) : (
        <NewSessionButton projectId={project.id} variant="principal" size="lg" icon="terminal" disabledReason={sessionDisabled} className="w-full justify-center">
          Ouvrir le Workspace
        </NewSessionButton>
      )
    ) : liveSessionId ? (
      <Button variant="accent" href={workspaceUrl(liveSessionId)}>
        Ouvrir le Workspace
      </Button>
    ) : (
      <NewSessionButton projectId={project.id} variant="accent" disabledReason={sessionDisabled}>
        Ouvrir le Workspace
      </NewSessionButton>
    );

  const newSession = <NewSessionButton projectId={project.id} variant="secondaire" disabledReason={sessionDisabled} />;

  const branchMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={!ready || !detail.branches.ok}>
        <button
          type="button"
          className="nu-hit relative inline-flex h-[26px] max-w-[280px] shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 font-mono text-app-12 text-text hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
          aria-label={`Branche courante : ${project.branch ?? project.defaultBranch}. Changer de branche`}
        >
          <Icon name="git-branch" size={14} className="text-text" />
          <span className="truncate">{project.branch ?? project.defaultBranch}</span>
          <Icon name="chevron-down" size={14} className="text-muted" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent width={280}>
        <DropdownMenuLabel>Passer sur une branche</DropdownMenuLabel>
        {localBranches.map((branch) => (
          <DropdownMenuItem
            key={branch.name}
            icon={branch.protected ? 'lock' : 'git-branch'}
            disabled={branch.current || Boolean(branch.worktreeId && !branch.current) || Boolean(branch.sessionId)}
            aside={branch.current ? <Badge tone="accent">Courante</Badge> : branch.sessionId ? <Badge tone="warn">Session</Badge> : undefined}
            onSelect={() => void checkout(branch.name)}
          >
            <span className="font-mono text-app-13">{branch.name}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem icon="plus" onSelect={() => open({ branch: true })}>
          Nouvelle branche…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const overviewDesktop = (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="flex min-w-0 flex-col gap-5">
        <EnvironmentTile ctx={ctx} variant="desktop" />
        <BranchesTile ctx={ctx} />
        <SessionsTile ctx={ctx} newSession={newSession} />
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        <ClaudeMdTile ctx={ctx} variant="desktop" />
        <McpTile ctx={ctx} variant="desktop" />
        <EnvVarsTile ctx={ctx} />
      </div>
    </div>
  );

  const tabContent = (value: ProjectTab, phone: boolean) => {
    switch (value) {
      case 'vue-d-ensemble':
        return phone ? (
          <div className="flex flex-col gap-4">
            <EnvironmentTile ctx={ctx} variant="phone" />
            <ClaudeMdTile ctx={ctx} variant="phone" />
            <McpTile ctx={ctx} variant="phone" />
          </div>
        ) : (
          overviewDesktop
        );
      case 'branches':
        return (
          <div className="flex flex-col gap-5">
            <BranchesTile ctx={ctx} full />
            <WorktreesTile ctx={ctx} />
          </div>
        );
      case 'environnement':
        return (
          <div className={cn('flex flex-col', phone ? 'gap-4' : 'gap-5')}>
            <EnvironmentTile ctx={ctx} variant={phone ? 'phone' : 'desktop'} full />
            <RunHistoryTile ctx={ctx} />
          </div>
        );
      case 'claude-md':
        return <ClaudeMdTile ctx={ctx} variant="desktop" full />;
      case 'outils-mcp':
        return <McpTile ctx={ctx} variant="desktop" />;
      case 'variables':
        return <EnvVarsTile ctx={ctx} full />;
      case 'sessions':
        return <SessionsTile ctx={ctx} full newSession={newSession} />;
    }
  };

  const banners = (
    <>
      {project.archivedAt ? (
        <Banner
          tone="info"
          icon="archive"
          title="Projet archivé"
          action={
            <CompactButton variant="secondaire" onClick={() => void restore()}>
              Restaurer
            </CompactButton>
          }
        >
          {`Il n'apparaît plus dans la liste. Son dépôt GitHub et son clone sur ${serverName} sont intacts.`}
        </Banner>
      ) : null}
      {project.status === 'cloning' && project.operation ? (
        <Banner
          tone="info"
          live
          title="Clonage en cours"
          action={
            <CompactButton variant="secondaire" href={`/projets/nouveau?etape=clonage&projet=${project.id}&operation=${project.operation.id}`}>
              Suivre
            </CompactButton>
          }
        >
          {`Le clonage continue sur ${serverName}.`}
        </Banner>
      ) : null}
      {project.status === 'error' ? (
        <Banner tone="danger" title="Le clonage a échoué">
          {[project.statusDetail, 'Réessayez depuis la liste des projets.'].filter(Boolean).join(' ')}
        </Banner>
      ) : null}
      {project.sync.syncing || remoteSync ? (
        <Banner tone="info" live title="Synchronisation en cours">
          {`Récupération des commits depuis origin/${project.branch ?? project.defaultBranch}…`}
        </Banner>
      ) : null}
      {project.sync.conflict ? (
        <Banner tone="danger" title="Conflit à résoudre">
          Le clone contient un conflit Git : ouvrez une session pour le résoudre avant de synchroniser.
        </Banner>
      ) : null}
      {failure ? <FailureBanner title={failure.title} failure={failure.failure} onRetry={failure.retry} retrying={syncing} onDismiss={() => setFailure(null)} /> : null}
    </>
  );

  return (
    <>
      {/* ------------------------------ Desktop (D04) ------------------------------ */}
      <div className="hidden flex-col gap-5 nav:flex">
        <header className="flex items-end gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <nav aria-label="Fil d'Ariane" className="font-mono text-app-12 whitespace-pre text-muted">
              <Link href="/projets" className="hover:text-text hover:underline">
                Projets
              </Link>
              {'  /  '}
              <span aria-current="page">{project.name}</span>
            </nav>
            <div className="flex min-w-0 items-center gap-2.5">
              <h1 className="m-0 truncate font-sans text-app-28 font-semibold text-text">{project.name}</h1>
              <Badge tone={badge.tone}>{badge.label}</Badge>
            </div>
            <div className="flex min-w-0 items-center gap-4">
              <a href={project.htmlUrl} target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-1.5 font-mono text-app-12 text-accent hover:underline">
                <Icon name="github" size={14} className="text-accent" />
                {project.fullName}
                <Icon name="external" size={12} className="text-accent" />
              </a>
              {branchMenu}
              <span className="min-w-0 flex-1 truncate font-sans text-app-13 text-muted" title={project.path}>
                {[project.path, synced].filter(Boolean).join(' · ')}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <Button onClick={() => void sync()} loading={syncing} disabled={!ready}>
              Synchroniser
            </Button>
            {workspaceButton(false)}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton icon="more" label="Actions du projet" variant="outline" size="md" />
              </DropdownMenuTrigger>
              <DropdownMenuContent width={248}>
                <ProjectMenuItems
                  favorite={favorite}
                  archived={Boolean(project.archivedAt)}
                  ready={ready}
                  onFavorite={() => void toggleFavorite()}
                  onSync={() => void sync()}
                  onBranch={() => open({ branch: true })}
                  onSession={() => open({ session: true })}
                  onArchive={() => open({ archive: true })}
                  onRestore={() => void restore()}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        {banners}
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList aria-label="Sections du projet">
            {tabs.map((spec) => (
              <TabsTrigger key={spec.value} value={spec.value} {...(spec.count !== undefined ? { count: spec.count } : {})}>
                {spec.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <section aria-label={tabs.find((spec) => spec.value === tab)?.label}>{tabContent(tab, false)}</section>
      </div>

      {/* ------------------------------ Phone (M04) ------------------------------ */}
      <div className="flex flex-col gap-4 pb-[76px] nav:hidden">
        <div className="-mx-2 -mt-2 flex h-[52px] items-center gap-1">
          <Link href="/projets" className="nu-hit relative inline-flex h-11 items-center gap-1 px-2 font-sans text-app-15 font-medium text-accent">
            <Icon name="arrow-left" size={18} />
            Projets
          </Link>
          <span className="flex-1" />
          <IconButton icon="refresh" label="Synchroniser" size="md" onClick={() => void sync()} loading={syncing} disabled={!ready} />
          <IconButton icon="more" label="Actions du projet" size="md" onClick={() => open({ actions: true })} />
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <h1 className="m-0 min-w-0 truncate font-sans text-app-26 font-semibold text-text">{project.name}</h1>
            <Badge tone={phoneBadge.tone}>{phoneBadge.label}</Badge>
          </div>
          <a href={project.htmlUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1.5 self-start font-mono text-app-12 text-accent">
            <Icon name="github" size={14} className="text-accent" />
            <span className="truncate">{project.fullName}</span>
          </a>
          <button
            type="button"
            onClick={() => open({ branches: true })}
            disabled={!ready || !detail.branches.ok}
            className="flex h-11 w-full min-w-0 items-center gap-2 rounded-md border border-border bg-bg px-3 text-left disabled:opacity-60"
            aria-label={`Branche courante : ${project.branch ?? project.defaultBranch}. Changer de branche`}
          >
            <Icon name="git-branch" size={16} className="text-text" />
            <span className="min-w-0 flex-1 truncate font-mono text-app-13 text-text">{project.branch ?? project.defaultBranch}</span>
            {branchCount !== null ? <span className="shrink-0 font-sans text-app-12 text-muted">{`${branchCount} branche${branchCount >= 2 ? 's' : ''}`}</span> : null}
            <Icon name="chevron-down" size={16} className="text-muted" />
          </button>
        </div>
        {banners}
        <div ref={phoneChips}>
          <Tabs value={tab === 'branches' ? 'branches' : tab} onValueChange={setTab}>
            <TabsList aria-label="Sections du projet" className="-mx-4 px-4">
              {tabs
                .filter((spec) => !spec.desktopOnly || tab === spec.value)
                .map((spec) => (
                  <TabsTrigger key={spec.value} value={spec.value} {...(spec.count !== undefined ? { count: spec.count } : {})}>
                    {spec.phoneLabel ?? spec.label}
                  </TabsTrigger>
                ))}
            </TabsList>
          </Tabs>
        </div>
        <section aria-label={tabs.find((spec) => spec.value === tab)?.label}>{tabContent(tab, true)}</section>
        <div className="fixed inset-x-0 z-20 border-t border-border bg-bg px-4 py-3" style={{ bottom: 'var(--shell-bottom)' }}>
          {workspaceButton(true)}
        </div>
      </div>

      {/* ------------------------------ Overlays ------------------------------ */}
      <Sheet open={dialogs.actions} onOpenChange={(value) => open({ actions: value })}>
        <SheetContent title={project.name} description="Actions du projet">
          <div className="flex flex-col pb-2">
            <SheetAction icon="star" onClick={() => { open({ actions: false }); void toggleFavorite(); }}>
              {favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
            </SheetAction>
            {ready ? (
              <>
                <SheetAction icon="refresh" onClick={() => { open({ actions: false }); void sync(); }}>
                  Synchroniser maintenant
                </SheetAction>
                <SheetAction icon="git-branch" onClick={() => open({ actions: false, branch: true })}>
                  Nouvelle branche…
                </SheetAction>
                <SheetAction icon="terminal" onClick={() => open({ actions: false, session: true })}>
                  Nouvelle session ici
                </SheetAction>
              </>
            ) : null}
            {project.archivedAt ? (
              <SheetAction icon="archive" onClick={() => { open({ actions: false }); void restore(); }}>
                Restaurer le projet
              </SheetAction>
            ) : (
              <SheetAction icon="archive" destructive onClick={() => open({ actions: false, archive: true })}>
                Archiver le projet…
              </SheetAction>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={dialogs.branches} onOpenChange={(value) => open({ branches: value })}>
        <SheetContent title="Branches" meta={branchCount !== null ? String(branchCount) : undefined} description={`Le clone de ${project.name} passe sur la branche choisie.`}>
          <div className="flex flex-col pb-2">
            {localBranches.map((branch) => (
              <SheetAction
                key={branch.name}
                icon={branch.protected ? 'lock' : 'git-branch'}
                mono
                disabled={branch.current || Boolean(branch.sessionId) || Boolean(branch.worktreeId && !branch.current) || checkoutPending !== null}
                aside={branch.current ? <Badge tone="accent">Courante</Badge> : branch.sessionId ? <Badge tone="warn">Session active</Badge> : branch.protected ? <Badge tone="neutral">Protégée</Badge> : null}
                onClick={() => void checkout(branch.name)}
              >
                {branch.name}
              </SheetAction>
            ))}
            <SheetAction icon="plus" onClick={() => open({ branches: false, branch: true })}>
              Nouvelle branche…
            </SheetAction>
          </div>
        </SheetContent>
      </Sheet>

      {dialogs.branch ? (
        <NewBranchDialog
          open
          onOpenChange={(value) => open({ branch: value })}
          project={{ id: project.id, name: project.name, defaultBranch: project.defaultBranch }}
          branches={localBranches.map((branch) => branch.name)}
          onCreated={refresh}
          serverName={serverName}
        />
      ) : null}
      <ArchiveProjectDialog open={dialogs.archive} onOpenChange={(value) => open({ archive: value })} project={{ id: project.id, name: project.name }} onArchived={refresh} serverName={serverName} />
      <NewSessionDialog open={dialogs.session} onOpenChange={(value) => open({ session: value })} defaultProjectId={project.id} />
      <ClaudeMdEditor
        projectId={project.id}
        initial={detail.claudeMd.ok ? (detail.claudeMd.data.content ?? '') : ''}
        branch={project.branch}
        open={dialogs.claudeMd}
        onOpenChange={(value) => open({ claudeMd: value })}
        onSaved={refresh}
      />
      <CommandsDialog projectId={project.id} commands={project.commands} open={dialogs.commands} onOpenChange={(value) => open({ commands: value })} onSaved={refresh} />
      <EnvVarDialog projectId={project.id} target={dialogs.env} onOpenChange={(value) => !value && open({ env: null })} onSaved={refresh} />
      <RunOutputDialog run={dialogs.run} onOpenChange={(value) => !value && open({ run: null })} onStopped={refresh} />
      <RemoveWorktreeDialog projectId={project.id} worktree={dialogs.worktree} onOpenChange={(value) => !value && open({ worktree: null })} onRemoved={refresh} />
    </>
  );
}

function ProjectMenuItems({
  favorite,
  archived,
  ready,
  onFavorite,
  onSync,
  onBranch,
  onSession,
  onArchive,
  onRestore,
}: {
  favorite: boolean;
  archived: boolean;
  ready: boolean;
  onFavorite: () => void;
  onSync: () => void;
  onBranch: () => void;
  onSession: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  return (
    <>
      <DropdownMenuItem icon="star" onSelect={onFavorite}>
        {favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
      </DropdownMenuItem>
      <DropdownMenuItem icon="refresh" onSelect={onSync} disabled={!ready}>
        Synchroniser maintenant
      </DropdownMenuItem>
      <DropdownMenuItem icon="git-branch" onSelect={onBranch} disabled={!ready}>
        Nouvelle branche…
      </DropdownMenuItem>
      <DropdownMenuItem icon="terminal" onSelect={onSession} disabled={!ready}>
        Nouvelle session ici
      </DropdownMenuItem>
      {archived ? (
        <DropdownMenuItem icon="archive" onSelect={onRestore}>
          Restaurer le projet
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem icon="archive" destructive onSelect={onArchive}>
          Archiver le projet…
        </DropdownMenuItem>
      )}
    </>
  );
}

function SheetAction({
  icon,
  destructive,
  mono,
  disabled,
  aside,
  onClick,
  children,
}: {
  icon: 'star' | 'refresh' | 'git-branch' | 'terminal' | 'archive' | 'lock' | 'plus';
  destructive?: boolean;
  mono?: boolean;
  disabled?: boolean;
  aside?: ReactNode;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex min-h-12 w-full min-w-0 items-center gap-3 rounded-sm px-2 text-left hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60',
        destructive ? 'text-danger' : 'text-text',
      )}
    >
      <Icon name={icon} size={18} className={destructive ? 'text-danger' : 'text-muted'} />
      <span className={cn('min-w-0 flex-1 truncate', mono ? 'font-mono text-app-13' : 'font-sans text-app-15')}>{children}</span>
      {aside}
    </button>
  );
}
