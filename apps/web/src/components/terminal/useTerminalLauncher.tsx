'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { TerminalLaunch } from './presets';
import { TerminalDialog } from './TerminalDialog';

export interface TerminalLauncher {
  /** Opens the window (a new terminal each time). */
  open: (launch: TerminalLaunch) => void;
  close: () => void;
  isOpen: boolean;
  /** Render it once, anywhere in the component. */
  dialog: ReactNode;
}

/**
 * One `TerminalDialog` driven by state, for pages with several « open a terminal » buttons:
 *
 *   const terminal = useTerminalLauncher();
 *   <CompactButton icon="terminal" onClick={() => terminal.open(claudeStatusTerminal({ serverName }))}>Ouvrir /status</CompactButton>
 *   {terminal.dialog}
 */
export function useTerminalLauncher(): TerminalLauncher {
  const [current, setCurrent] = useState<{ launch: TerminalLaunch; key: number } | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback((launch: TerminalLaunch) => {
    setCurrent((previous) => ({ launch, key: (previous?.key ?? 0) + 1 }));
    setIsOpen(true);
  }, []);
  const close = useCallback(() => setIsOpen(false), []);

  const dialog = useMemo(
    () =>
      current ? (
        <TerminalDialog
          key={current.key}
          open={isOpen}
          onOpenChange={setIsOpen}
          title={current.launch.title}
          description={current.launch.description}
          privacyNote={current.launch.privacyNote}
          create={current.launch.create}
          onExit={current.launch.onExit}
          label={current.launch.label}
        />
      ) : null,
    [current, isOpen],
  );

  return { open, close, isOpen, dialog };
}
