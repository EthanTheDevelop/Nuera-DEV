import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getRequestContext, requireContext } from '@/server/tenancy/context';
import { listShellWorktrees, type ShellWorktree } from '@/server/terminals';
import { TerminalKit } from './TerminalKit';

export const metadata: Metadata = {
  title: 'Terminal · kit',
  robots: { index: false, follow: false },
};

// Visibility is decided per request (environment + session), never at build time.
export const dynamic = 'force-dynamic';

/**
 * /kit/terminal — the shared browser terminal (`@/components/terminal`) on REAL runner terminals:
 * `claude-status` inline (W2 « Terminal brut » framing), the windows of Paramètres / T6 / Intégrations
 * and a shell on an active worktree when the database has one. Same rules as /kit: development
 * only, signed-in account, its own server only (the terminal routes always require the session, even with NUERA_KIT_PUBLIC=1).
 */
export default async function TerminalKitPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  const kitPublic = process.env.NODE_ENV === 'development' && process.env.NUERA_KIT_PUBLIC === '1';
  const ctx = kitPublic ? await getRequestContext() : await requireContext();
  let worktrees: ShellWorktree[] = [];
  let worktreesError: string | null = null;
  try {
    worktrees = ctx ? await listShellWorktrees(ctx, 4) : [];
  } catch {
    worktreesError = 'Base de données injoignable : les worktrees ne peuvent pas être listés.';
  }
  return <TerminalKit worktrees={worktrees} worktreesError={worktreesError} serverName={ctx?.environment?.name ?? null} />;
}
