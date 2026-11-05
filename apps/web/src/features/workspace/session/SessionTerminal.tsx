'use client';

import { Icon } from '@/components/icons';
import { TerminalView } from '@/components/terminal';
import { EmptyState, ErrorPanel, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useCallback, useEffect, useState } from 'react';
import { fetchSessionTerminal } from '../api';
import { useWorkspace } from '../WorkspaceContext';

type TerminalLoad = { state: 'loading' } | { state: 'ready'; terminalId: string } | { state: 'none' } | { state: 'error'; message: string };

/**
 * W2 « Terminal brut »: the PTY of the session's CLI, rendered by the shared TerminalView (keyboard
 * wired to the PTY: Échap interrupts, Ctrl+C too). The terminal belongs to the session: never closed
 * from here. Re-read when the CLI (re)starts.
 */
export function SessionTerminal({ variant = 'desktop', className }: { variant?: 'desktop' | 'phone'; className?: string }) {
  const ws = useWorkspace();
  const { session } = ws.ctl.state;
  const [load, setLoad] = useState<TerminalLoad>({ state: 'loading' });
  const liveKey = `${session.live ? 1 : 0}:${session.startedAt ?? ''}`;

  const read = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const result = await fetchSessionTerminal(session.id, signal);
        setLoad(result.terminalId && result.live ? { state: 'ready', terminalId: result.terminalId } : { state: 'none' });
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') return;
        setLoad({ state: 'error', message: (error as Error).message });
      }
    },
    [session.id],
  );

  useEffect(() => {
    const controller = new AbortController();
    void read(controller.signal);
    return () => controller.abort();
  }, [read, liveKey]);

  const legend = (
    <p className="m-0 flex items-start gap-2 font-sans text-app-12 text-muted">
      <Icon name="terminal" size={14} className="mt-px shrink-0" />
      <span>Flux exact du processus Claude Code, sans mise en forme. Clavier relié au terminal : Échap interrompt, Ctrl+C aussi.</span>
    </p>
  );

  let body;
  if (load.state === 'loading') body = <Skeleton height={240} className="flex-1 rounded-md" />;
  else if (load.state === 'error')
    body = (
      <ErrorPanel
        title="Le terminal de la session est indisponible"
        excerpt={load.message}
        untouched={`La session continue sur ${ws.host}.`}
        onRetry={() => {
          setLoad({ state: 'loading' });
          void read();
        }}
      />
    );
  else if (load.state === 'none')
    body = (
      <EmptyState icon="terminal" title="Aucun processus Claude Code en cours" variant="plain" className="flex-1">
        {session.status === 'new'
          ? "Le terminal brut s'ouvre au premier envoi : la session démarre alors sur " + ws.host + '.'
          : "Le CLI de cette session ne tourne plus. Envoyez une instruction pour la reprendre : son terminal réapparaîtra ici."}
      </EmptyState>
    );
  else
    body = (
      <TerminalView
        key={load.terminalId}
        terminalId={load.terminalId}
        label="Terminal brut de la session"
        className="min-h-60 flex-1"
        autoFocus={variant === 'desktop'}
        keyBar="auto"
        readOnly={ws.reconnecting}
        onExit={() => void read()}
      />
    );

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col gap-3.5', variant === 'desktop' ? 'px-6 py-5' : 'px-4 py-3', className)}>
      {body}
      {legend}
    </div>
  );
}
