import type { Metadata } from 'next';
import { PageHeader } from '@/components/shell/PageHeader';
import { ShellAvailability } from '@/components/shell/ShellAvailability';
import { requireUser } from '@/server/auth/session';
import { getShellData } from '@/server/shell/get-shell-data';

export const metadata: Metadata = { title: 'Accueil' };

/**
 * Accueil — temporary minimal version: the real greeting, the long date and the live availability
 * sentence (D01 « Bonjour Nezar » / « Mercredi 4 novembre 2026 · VPS-3 et Claude Code sont disponibles »;
 * M01 « Mer. 4 nov. · tout est disponible »). The Home lot replaces this file with D01 / M01.
 */
export default async function HomePage() {
  const user = await requireUser();
  const shell = await getShellData(user);
  return (
    <PageHeader
      title={`Bonjour ${shell.user.firstName}`}
      subtitle={
        <>
          <span className="hidden nav:inline">
            <ShellAvailability variant="long" />
          </span>
          <span className="nav:hidden">
            <ShellAvailability variant="short" />
          </span>
        </>
      }
    />
  );
}
