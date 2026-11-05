import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/AppShell';
import { GlobalSearch } from '@/features/search/GlobalSearch';
import { requireUser } from '@/server/auth/session';
import { getShellData } from '@/server/shell/get-shell-data';

/**
 * Pages with the 248 px sidebar (desktop) / the tab bar (phone): Accueil, Projets, Sessions,
 * Intégrations, Paramètres. Global states T5 / T6 / connection loss are rendered by the shell.
 */
export default async function ShellLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const shell = await getShellData(user);
  return (
    <AppShell data={shell} variant="sidebar" globals={<GlobalSearch />}>
      {children}
    </AppShell>
  );
}
