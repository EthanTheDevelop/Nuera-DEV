'use client';

import { CommonConfigChip } from './header/CommonConfigChip';
import { DIFF_PHONE_HINT, DiffFilePager, DiffView, BranchStatusBar, useKeyboardInset, usageLimitLabel } from '@/components/dev';
import { ConnectionLostBanner } from '@/components/shell';
import { CompactButton, EmptyState, ErrorPanel, IconButton, Sheet, SheetContent, SkeletonList, Switch, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { useOptionalLiveEvents } from '@/hooks/useLiveEvents';
import { useNow } from '@/hooks/useNow';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { CommitForm } from './commit/CommitForm';
import { STEP_LABEL, useCommitFlow } from './commit/useCommitFlow';
import { SessionStatus } from './header/SessionHeader';
import { useSessionMenu } from './header/SessionActions';
import { SessionSwitcherSheet, useSwitcherSessions } from './header/SessionSwitcher';
import { phoneStatusMeta } from './lib/thread';
import { FileExplorer } from './panel/FileExplorer';
import { toDiffViewFile, useFileDiff, useSelectedChange } from './panel/useFileDiff';
import { ComposerArea } from './session/ComposerArea';
import { ActionErrorBanner } from './session/SessionColumn';
import { PreviewPanel } from './preview/PreviewPanel';
import { SessionTerminal } from './session/SessionTerminal';
import { UsageLimitBanner, useAutoResume } from './session/UsageLimitBanner';
import { Thread } from './thread/Thread';
import { useWorkspace } from './WorkspaceContext';

function ActionsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const ws = useWorkspace();
  const menu = useSessionMenu();
  const auto = useAutoResume();
  const autoLabel = useId();
  const terminal = ws.url.view === 'terminal';
  const close = () => onOpenChange(false);
  const row = (label: string, onClick: () => void, icon: Parameters<typeof CompactButton>[0]['icon'], options: { disabled?: boolean; loading?: boolean } = {}) => (
    <CompactButton variant="secondaire" size="lg" block icon={icon} onClick={onClick} disabled={options.disabled} loading={options.loading} className="justify-start">
      {label}
    </CompactButton>
  );
  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent title="Actions de session" description={ws.ctl.state.session.title}>
          <div className="flex flex-col gap-2 pb-4">
            {ws.canInterrupt
              ? row('Interrompre · Échap', () => {
                  close();
                  void ws.interrupt();
                }, 'stop', { loading: ws.interrupting })
              : null}
            {row(terminal ? 'Voir la conversation' : 'Voir le terminal brut', () => {
              close();
              ws.url.set({ onglet: null, vue: terminal ? null : 'terminal' });
            }, terminal ? 'messages' : 'terminal')}
            {row('Renommer la session', () => {
              close();
              menu.openRename();
            }, 'edit')}
            {menu.canResume
              ? row(menu.resumeLabel, () => {
                  close();
                  void menu.resume();
                }, 'play', { loading: menu.resuming })
              : null}
            {menu.canStop
              ? row('Arrêter la session', () => {
                  close();
                  menu.openStop();
                }, 'stop')
              : null}
            <div className="flex min-h-11 items-center gap-3 rounded-md border border-border px-3 py-2">
              <span id={autoLabel} className="min-w-0 flex-1 font-sans text-app-14 text-text">
                Reprise automatique après la limite
              </span>
              <Switch checked={auto.enabled} disabled={auto.disabled} aria-labelledby={autoLabel} onCheckedChange={(checked) => void auto.setEnabled(checked)} />
            </div>
            <CompactButton variant="discret" size="lg" block icon="projets" href={`/projets/${encodeURIComponent(ws.data.project.id)}`}>
              Ouvrir le projet
            </CompactButton>
          </div>
        </SheetContent>
      </Sheet>
      {menu.dialogs}
    </>
  );
}

/** M05 `En-tête de session` + `État de la session` (states-mobile-and-extensions.md §2.1–2.2). */
function PhoneHeader() {
  const ws = useWorkspace();
  const router = useRouter();
  const now = useNow(30_000, ws.initialNow);
  const [switcher, setSwitcher] = useState(false);
  const [actions, setActions] = useState(false);
  const { sessions } = useSwitcherSessions();
  const { session } = ws.ctl.state;
  const wt = ws.data.worktree;
  const subtitle = [ws.data.project.name, wt?.branch, wt ? (wt.isPrimary ? 'clone principal' : `worktree ${wt.name}`) : null].filter(Boolean).join(' · ');
  const back = () => {
    if (window.history.length > 1) router.back();
    else router.push('/sessions');
  };
  return (
    <>
      <header className="flex h-[52px] shrink-0 items-center gap-0.5 bg-bg px-1">
        <IconButton icon="arrow-left" label="Retour" onClick={back} />
        <div className="flex min-w-0 flex-1 flex-col gap-px overflow-hidden">
          <h1 className="m-0 truncate font-sans text-app-16 font-semibold text-text">{session.title}</h1>
          <p className="m-0 truncate font-mono text-app-11 text-muted">{subtitle}</p>
        </div>
        <IconButton
          icon="worktree"
          label="Changer de session"
          badge={sessions.length}
          badgeLabel={`${sessions.length} ${sessions.length >= 2 ? 'sessions' : 'session'} sur ce projet`}
          onClick={() => setSwitcher(true)}
        />
        <IconButton icon="more" label="Actions de session" onClick={() => setActions(true)} />
      </header>
      <div className="flex h-[39px] shrink-0 items-center gap-2 bg-bg px-4 pt-1.5 pb-2.5">
        <SessionStatus className="shrink-0" />
        {usageLimitLabel(session.limit, now) ? (
          <p className="m-0 min-w-0 flex-1 truncate font-sans text-app-12 font-medium text-warn" data-testid="limite-entete">
            {usageLimitLabel(session.limit, now)}
          </p>
        ) : (
          <p className="m-0 min-w-0 flex-1 truncate font-mono text-app-11 text-muted">{phoneStatusMeta(session, ws.host, now)}</p>
        )}
        <CommonConfigChip compact />
      </div>
      <SessionSwitcherSheet open={switcher} onOpenChange={setSwitcher} />
      <ActionsSheet open={actions} onOpenChange={setActions} />
    </>
  );
}

/** S2 `Onglet Diff`: one file at a time (pager), unified diff, truncated lines open on tap. */
function PhoneDiff() {
  const ws = useWorkspace();
  const { files, selected, index } = useSelectedChange();
  const diff = useFileDiff(selected);
  const { changes, changesError } = ws.ctl.state;
  if (!changes) {
    return changesError ? (
      <ErrorPanel title="Les modifications du worktree sont indisponibles" excerpt={changesError} onRetry={ws.ctl.refreshChanges} />
    ) : (
      <SkeletonList rows={5} card={false} label="Lecture des modifications" />
    );
  }
  if (!selected) {
    return (
      <EmptyState icon="file-diff" title="Aucune modification" variant="plain">
        Le worktree est identique au dernier commit : rien à relire pour l&apos;instant.
      </EmptyState>
    );
  }
  const go = (i: number) => {
    const file = files[i];
    if (file) ws.url.set({ fichier: file.path }, 'replace');
  };
  return (
    <>
      <DiffFilePager
        path={selected.path}
        index={index + 1}
        total={files.length}
        additions={selected.insertions}
        deletions={selected.deletions}
        onPrevious={() => go(index - 1)}
        onNext={() => go(index + 1)}
      />
      {diff.status === 'error' ? (
        <ErrorPanel title="Le diff de ce fichier n'a pas pu être lu" excerpt={diff.message} onRetry={diff.retry} />
      ) : diff.status !== 'ready' ? (
        <SkeletonList rows={6} card={false} label="Lecture du diff" />
      ) : (
        <DiffView file={toDiffViewFile(diff.diff)} layout="unified" header="none" expandOnTap />
      )}
      <p className="m-0 font-sans text-app-12 leading-4 text-muted">{DIFF_PHONE_HINT}</p>
    </>
  );
}

/** S3 `Onglet Git`: branch card, files to commit, message, switches; sticky « Committer et pousser ». */
function usePhoneGit(active: boolean) {
  return useCommitFlow('commit-push', active);
}

function PhoneGit({ flow }: { flow: ReturnType<typeof usePhoneGit> }) {
  const ws = useWorkspace();
  const branch = ws.ctl.state.branch;
  if (!ws.data.worktree) return null;
  return (
    <>
      <BranchStatusBar
        variant="card"
        branch={ws.data.worktree.branch}
        badge={branch && branch.ahead > 0 ? { label: `${branch.ahead} en avance`, tone: 'accent' } : null}
        status={branch && branch.ahead === 0 ? `à jour avec ${branch.base}` : null}
      />
      {ws.ctl.state.changes ? <CommitForm flow={flow} variant="phone" /> : <SkeletonList rows={4} card={false} label="Lecture des modifications" />}
    </>
  );
}

/** M05 phone composition (390 × 844): no tab bar, segmented tabs replace the side panel. */
export function PhoneWorkspace() {
  const ws = useWorkspace();
  const live = useOptionalLiveEvents();
  const keyboard = useKeyboardInset();
  // The keyboard shrinks the tab panel: keep the focused field of a tab (S3 commit message, search…)
  // visible above the sticky bar instead of leaving it hidden under « Committer et pousser ».
  useEffect(() => {
    if (!keyboard.open) return;
    const frame = requestAnimationFrame(() => {
      const field = document.activeElement;
      if (field instanceof HTMLElement && field.closest('[role="tabpanel"]')) field.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  // eslint-disable-next-line react/exhaustive-effect-dependencies -- the inset is the trigger: re-run while the keyboard slides in
  }, [keyboard.open, keyboard.inset]);
  const tab = ws.url.phoneTab;
  const count = ws.changedCount ?? 0;
  const git = usePhoneGit(tab === 'git');

  let content: ReactNode;
  if (tab === 'fichiers') content = <FileExplorer variant="phone" />;
  else if (tab === 'diff') content = <PhoneDiff />;
  else if (tab === 'git') content = <PhoneGit flow={git} />;
  else if (tab === 'apercu') content = <PreviewPanel variant="phone" />;
  else
    content = (
      <>
        {ws.reconnecting && live ? (
          <ConnectionLostBanner context="workspace" nextRetryAt={live.nextRetryAt} onRetry={live.retryNow} serverName={ws.host} className="shrink-0 rounded-none" />
        ) : null}
        <ActionErrorBanner className="mx-4 mt-3 shrink-0" />
        <UsageLimitBanner className="mx-4 mt-3 w-auto shrink-0" />
        {ws.url.view === 'terminal' ? <SessionTerminal variant="phone" /> : <Thread variant="phone" />}
      </>
    );

  return (
    <div
      className="flex min-h-0 w-full min-w-0 flex-col overflow-hidden bg-surface-raised pt-[env(safe-area-inset-top)]"
      style={{ height: keyboard.inset > 0 ? `calc(100dvh - ${keyboard.inset}px)` : '100dvh' }}
    >
      <PhoneHeader />
      <Tabs
        value={tab}
        onValueChange={(next) => ws.url.set({ onglet: next === 'session' ? null : next })}
        activationMode="manual"
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="shrink-0 border-b border-border bg-bg px-4 pb-2.5">
          <TabsList variant="segmented" aria-label="Onglets du Workspace">
            {/* Five equal tabs: tighter padding so they keep their labels at 360 px. */}
            <TabsTrigger value="session" className="px-1">Session</TabsTrigger>
            <TabsTrigger value="fichiers" className="px-1">Fichiers</TabsTrigger>
            <TabsTrigger value="diff" className="px-1" {...(count > 0 ? { count } : {})}>
              Diff
            </TabsTrigger>
            <TabsTrigger value="git" className="px-1">Git</TabsTrigger>
            <TabsTrigger value="apercu" className="px-1">Aperçu</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent
          value={tab}
          className={tab === 'session' || tab === 'fichiers' || tab === 'apercu' ? 'flex min-h-0 flex-1 flex-col' : 'flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3'}
        >
          {content}
        </TabsContent>
      </Tabs>
      {tab === 'git' ? (
        <div className="shrink-0 border-t border-border bg-bg px-3 pt-2 pb-[max(env(safe-area-inset-bottom),8px)]">
          <CompactButton
            variant="principal"
            size="lg"
            block
            icon="upload"
            loading={git.step !== null}
            disabled={!git.canSubmit}
            onClick={() => void git.submit()}
          >
            {git.step ? STEP_LABEL[git.step] : git.phoneCta}
          </CompactButton>
          {git.blockers[0] && !git.step ? <p className="m-0 pt-1.5 text-center font-sans text-app-12 text-muted">{git.blockers[0]}</p> : null}
        </div>
      ) : (
        <ComposerArea variant="phone" />
      )}
    </div>
  );
}
