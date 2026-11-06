import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/AppShell';
import { GlobalSearch } from '@/features/search/GlobalSearch';
import { getShellData } from '@/server/shell/get-shell-data';
import { requireContext } from '@/server/tenancy/context';

/**
 * Pages with the 248 px sidebar (desktop) / the tab bar (phone): Accueil, Projets, Sessions,
 * Intégrations, Paramètres (+ Administration for the owner and administrators). Global states T5 /
 * T6 / connection loss / « Aucun serveur attribué » are rendered by the shell, for the request
 * context (the signed-in account, its space and the server of that space).
 */
export default async function ShellLayout({ children }: { children: ReactNode }) {
  const ctx = await requireContext();
  const shell = await getShellData(ctx);
  return (
    <AppShell data={shell} variant="sidebar" globals={<GlobalSearch />}>
      {children}
    </AppShell>
  );
}
