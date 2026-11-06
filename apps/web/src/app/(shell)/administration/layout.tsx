import type { ReactNode } from 'react';
import { requireAdmin } from '@/server/auth/session';

/**
 * Role check BEFORE the loading boundary: `loading.tsx` wraps the page in a Suspense that streams
 * its skeleton (HTTP 200, « Administration » heading) before the page's own `requireAdmin()` runs.
 * Here a member gets the plain 404 and never sees that the console exists (MULTICOMPTE §10).
 */
export default async function AdministrationLayout({ children }: { children: ReactNode }) {
  await requireAdmin();
  return children;
}
