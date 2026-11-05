import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/AppShell';
import { GlobalSearch } from '@/features/search/GlobalSearch';
import { requireUser } from '@/server/auth/session';
import { getShellData } from '@/server/shell/get-shell-data';

/**
 * Workspace (`/workspace/[sessionId]`): « Ouvert depuis un projet ou une session, jamais depuis la
 * navigation. Au bureau, la barre se replie en rail ; au téléphone, la barre d'onglets disparaît. »
 * The page owns its whole surface (no padding); it shows its own inline W7 banner
 * (`ConnectionLostBanner context="workspace"`) from `useLiveEvents()`.
 */
export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const shell = await getShellData(user);
  return (
    <AppShell data={shell} variant="rail">
      <GlobalSearch />
      {children}
    </AppShell>
  );
}
