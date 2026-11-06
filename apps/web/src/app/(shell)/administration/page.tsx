import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AdminView } from '@/features/admin/components/AdminView';
import { loadAdministration } from '@/server/admin';
import { requireAdmin } from '@/server/auth/session';

export const metadata: Metadata = { title: 'Administration' };
export const dynamic = 'force-dynamic';

/**
 * /administration?onglet=comptes|serveurs|instance|claude|journal — owner and administrators only (a member
 * gets a 404: the console is never revealed). docs/MULTICOMPTE.md §6, §10. No Figma frame: built from
 * the existing primitives, desktop and phone. Never replaced by T5 (the console must stay usable while a
 * server is down).
 */
export default async function AdministrationPage() {
  const user = await requireAdmin();
  const data = await loadAdministration(user);
  return (
    <Suspense>
      <AdminView initial={data} />
    </Suspense>
  );
}
