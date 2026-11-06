'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { isAdminRole } from './nav-items';
import type { ShellData, ShellEnvironment } from './types';

const ShellDataContext = createContext<ShellData | null>(null);

interface PaletteControl {
  open: boolean;
  setOpen: (open: boolean) => void;
}
const PaletteContext = createContext<PaletteControl | null>(null);

/** Static shell data (user, server label, limits) from the layout's `getShellData`. */
export function ShellDataProvider({ data, children }: { data: ShellData; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const palette = useMemo(() => ({ open, setOpen }), [open]);
  return (
    <ShellDataContext.Provider value={data}>
      <PaletteContext.Provider value={palette}>{children}</PaletteContext.Provider>
    </ShellDataContext.Provider>
  );
}

export function useShellData(): ShellData {
  const ctx = useContext(ShellDataContext);
  if (!ctx) throw new Error('useShellData() doit être utilisé sous les layouts (shell) / (workspace).');
  return ctx;
}

/** Same as useShellData but null outside the shells (gallery, auth pages). */
export function useOptionalShellData(): ShellData | null {
  return useContext(ShellDataContext);
}

/**
 * Name of the server of the account's space (« VPS-3 »), null when none is assigned or outside the
 * shells. Use it instead of `shell.server.name` (empty without a server) — never a « VPS-3 » fallback.
 */
export function useServerName(): string | null {
  const data = useContext(ShellDataContext);
  return data?.environment?.name ?? null;
}

/** The server of the account's space, null when none is assigned (or outside the shells). */
export function useShellEnvironment(): ShellEnvironment | null {
  return useContext(ShellDataContext)?.environment ?? null;
}

/** True for the owner and the administrators (« Administration » entries); false outside the shells. */
export function useIsInstanceAdmin(): boolean {
  const data = useContext(ShellDataContext);
  return data ? isAdminRole(data.user.role) : false;
}

/** Open/close state of the command palette (⌘K). */
export function useCommandPaletteControl(): PaletteControl {
  const ctx = useContext(PaletteContext);
  if (!ctx) throw new Error('useCommandPaletteControl() doit être utilisé sous ShellDataProvider.');
  return ctx;
}
