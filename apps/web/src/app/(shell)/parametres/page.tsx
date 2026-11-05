import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SettingsView } from '@/features/settings/components/SettingsView';
import { requireUser } from '@/server/auth/session';
import { loadSettingsPage } from '@/server/preferences';

export const metadata: Metadata = { title: 'Paramètres' };
export const dynamic = 'force-dynamic';

/**
 * Paramètres — D08 (desktop: tabs `?onglet=` vue-d-ensemble · compte-et-securite · claude-code ·
 * serveur · preferences) / M08 (phone: grouped list, tabs as drill-down pages). Every section loads on
 * its own (a runner failure stays inline); `?action=reconnexion` opens the Claude login terminal (T6).
 */
export default async function SettingsPage() {
  const user = await requireUser();
  const data = await loadSettingsPage(user);
  return (
    <Suspense>
      <SettingsView data={data} />
    </Suspense>
  );
}
