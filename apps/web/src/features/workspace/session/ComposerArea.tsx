'use client';

import { Composer, PhoneComposer, permissionModeLabel, persistenceText } from '@/components/dev';
import { CLAUDE_RECONNECT_HREF, ClaudeDisconnected } from '@/components/shell';
import { Banner, CompactButton } from '@/components/ui';
import { useNow } from '@/hooks/useNow';
import { cn } from '@/lib/cn';
import { useWorkspace } from '../WorkspaceContext';
import { persistenceContextFor } from '../lib/thread';

/** Error of the last send (T4 in place: what failed, what was not touched). */
function SendError() {
  const ws = useWorkspace();
  if (!ws.sendError) return null;
  const { title, message, untouched } = ws.sendError;
  return (
    <Banner
      tone="danger"
      title={title}
      action={
        <CompactButton variant="discret" onClick={ws.clearSendError}>
          Fermer
        </CompactButton>
      }
      className="w-full"
    >
      {[message, untouched].filter(Boolean).join(' ')}
    </Banner>
  );
}

function usePersistence() {
  const ws = useWorkspace();
  const now = useNow(ws.reconnecting ? 1_000 : 60_000, ws.initialNow);
  const { session, permission } = ws.ctl.state;
  const lastSignalSeconds = ws.lastSignalAt ? Math.max(0, Math.round((now - ws.lastSignalAt) / 1000)) : 0;
  return persistenceText(
    persistenceContextFor({
      status: session.status,
      host: ws.host,
      reconnecting: ws.reconnecting,
      lastSignalSeconds,
      permissionPending: Boolean(permission),
    }),
  );
}

/** D05 `Saisie` (214:1649): T6 card when Claude is disconnected, the composer, the persistence line. */
export function ComposerArea({ variant }: { variant: 'desktop' | 'phone' }) {
  const ws = useWorkspace();
  const persistence = usePersistence();
  const { session } = ws.ctl.state;
  const canInterrupt = ws.canInterrupt && ws.composer.state === 'running';

  if (variant === 'phone') {
    return (
      <div className="flex w-full flex-col">
        {ws.claudeProblem || ws.sendError ? (
          <div className="flex flex-col gap-2 px-3 pb-2">
            {ws.claudeProblem ? <ClaudeDisconnected state={ws.claudeProblem} reconnectHref={CLAUDE_RECONNECT_HREF} serverName={ws.host} variant="banner" /> : null}
            <SendError />
          </div>
        ) : null}
        <PhoneComposer
          state={ws.composer.state}
          disabledReason={ws.composer.reason}
          onSubmit={ws.send}
          value={ws.draft}
          onValueChange={ws.setDraft}
          sending={ws.sending}
          textareaRef={ws.composerRef}
          placeholder={ws.url.phoneTab === 'diff' && ws.composer.state === 'ready' ? 'Demander une correction à Claude…' : undefined}
        />
      </div>
    );
  }

  return (
    <div className="flex w-full shrink-0 flex-col items-center gap-2 px-8 pt-3 pb-4">
      <div className={cn('flex w-full max-w-[720px] flex-col gap-2')}>
        {ws.claudeProblem ? <ClaudeDisconnected state={ws.claudeProblem} reconnectHref={CLAUDE_RECONNECT_HREF} serverName={ws.host} variant="card" /> : null}
        <SendError />
        <Composer
          state={ws.composer.state}
          disabledReason={ws.composer.reason}
          onSubmit={ws.send}
          modeLabel={permissionModeLabel(session.permissionMode)}
          value={ws.draft}
          onValueChange={ws.setDraft}
          sending={ws.sending}
          onInterrupt={canInterrupt ? () => void ws.interrupt() : undefined}
          interrupting={ws.interrupting}
          persistence={persistence}
          textareaRef={ws.composerRef}
        />
      </div>
    </div>
  );
}
