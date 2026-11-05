'use client';

import { TerminalView, closeTerminalRequest, createTerminal } from '@/components/terminal';
import { CompactButton, EmptyState, ErrorPanel } from '@/components/ui';
import { useEffect, useRef, useState } from 'react';
import { useWorkspace } from '../WorkspaceContext';

type ShellState = { status: 'idle' } | { status: 'opening' } | { status: 'open'; terminalId: string } | { status: 'error'; message: string };

/**
 * Context panel « Terminal » (not designed): a shell opened by the runner in the session's
 * worktree, rendered by the shared TerminalView. Opened on demand, closed when the owner closes it
 * or leaves the page.
 */
export function ShellPanel() {
  const ws = useWorkspace();
  const worktree = ws.data.worktree;
  const [shell, setShell] = useState<ShellState>({ status: 'idle' });
  const openId = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (openId.current) void closeTerminalRequest(openId.current, { keepalive: true }).catch(() => undefined);
    },
    [],
  );

  if (!worktree?.present) {
    return (
      <div className="p-4">
        <EmptyState icon="terminal" title="Terminal indisponible" variant="plain">
          Le worktree de cette session a été supprimé sur le serveur.
        </EmptyState>
      </div>
    );
  }

  const open = async () => {
    setShell({ status: 'opening' });
    try {
      const terminal = await createTerminal({ kind: 'shell', worktreeId: worktree.id });
      openId.current = terminal.id;
      setShell({ status: 'open', terminalId: terminal.id });
    } catch (error) {
      setShell({ status: 'error', message: (error as Error).message });
    }
  };
  const close = async () => {
    const id = openId.current;
    openId.current = null;
    setShell({ status: 'idle' });
    if (id) await closeTerminalRequest(id).catch(() => undefined);
  };

  if (shell.status === 'open') {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <p className="m-0 min-w-0 flex-1 truncate font-mono text-app-12 text-muted" title={worktree.branch}>
            {worktree.isPrimary ? 'clone principal' : `worktree ${worktree.name}`} · {worktree.branch}
          </p>
          <CompactButton variant="discret" icon="x" onClick={() => void close()}>
            Fermer le terminal
          </CompactButton>
        </div>
        <TerminalView terminalId={shell.terminalId} label={`Terminal du worktree ${worktree.name}`} className="min-h-60 flex-1" autoFocus onExit={() => void close()} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      {shell.status === 'error' ? (
        <ErrorPanel title="Le terminal n'a pas pu s'ouvrir" excerpt={shell.message} untouched="Aucun processus lancé." onRetry={() => void open()} />
      ) : (
        <EmptyState
          icon="terminal"
          title="Terminal du worktree"
          variant="plain"
          action={
            <CompactButton
              variant="principal"
              icon="terminal"
              loading={shell.status === 'opening'}
              disabled={Boolean(ws.serverDisabledReason)}
              onClick={() => void open()}
            >
              Ouvrir un terminal
            </CompactButton>
          }
        >
          {`Un shell s'ouvre sur ${ws.host} dans le worktree ${worktree.name}, à côté de la session Claude Code. Il se ferme quand vous quittez cette page.`}
        </EmptyState>
      )}
    </div>
  );
}
