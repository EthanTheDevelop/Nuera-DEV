'use client';

import { ConnectionLostBanner } from '@/components/shell';
import { Banner, CompactButton, SegmentedControl } from '@/components/ui';
import { useOptionalLiveEvents } from '@/hooks/useLiveEvents';
import { useWorkspace } from '../WorkspaceContext';
import { Thread } from '../thread/Thread';
import { ComposerArea } from './ComposerArea';
import { SessionTerminal } from './SessionTerminal';

/** Model actually used, as the CLI reports it (status line), else the one asked at launch, else « défaut du CLI ». */
export function useModelLabel(): string {
  const ws = useWorkspace();
  const { session } = ws.ctl.state;
  return session.cliStatus?.model?.displayName ?? session.cliStatus?.model?.id ?? session.model ?? 'défaut du CLI';
}

/** Generic in-page error of a header / menu action (T4 sober banner). */
export function ActionErrorBanner({ className }: { className?: string }) {
  const ws = useWorkspace();
  if (!ws.actionError) return null;
  return (
    <Banner
      tone="danger"
      title={ws.actionError.title}
      action={
        <CompactButton variant="discret" onClick={() => ws.setActionError(null)}>
          Fermer
        </CompactButton>
      }
      className={className}
    >
      {[ws.actionError.message, ws.actionError.untouched].filter(Boolean).join(' ')}
    </Banner>
  );
}

/** D05 `Session Claude Code`: view bar, W7 banner, thread or raw terminal, composer. */
export function SessionColumn() {
  const ws = useWorkspace();
  const live = useOptionalLiveEvents();
  const model = useModelLabel();
  const view = ws.url.view;

  return (
    <section aria-label="Session Claude Code" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-[55px] shrink-0 items-center gap-3 border-b border-border px-6 py-2.5">
        <SegmentedControl
          aria-label="Vue"
          value={view}
          onValueChange={(next) => ws.url.set({ vue: next === 'conversation' ? null : next })}
          items={[
            { value: 'conversation', label: 'Conversation', icon: 'messages' },
            { value: 'terminal', label: 'Terminal brut', icon: 'terminal' },
          ]}
        />
        <p className="m-0 min-w-0 flex-1 truncate font-sans text-app-12 text-muted">Même session, deux lectures du flux du CLI.</p>
        <p className="m-0 shrink-0 truncate font-mono text-app-11 text-muted">{`Modèle : ${model}`}</p>
      </div>

      {ws.reconnecting && live ? (
        <ConnectionLostBanner
          context="workspace"
          nextRetryAt={live.nextRetryAt}
          onRetry={live.retryNow}
          serverName={ws.host}
          className="shrink-0 rounded-none"
        />
      ) : null}
      <ActionErrorBanner className="mx-6 mt-3 shrink-0" />

      {view === 'terminal' ? <SessionTerminal /> : <Thread variant="desktop" />}
      <ComposerArea variant="desktop" />
    </section>
  );
}
