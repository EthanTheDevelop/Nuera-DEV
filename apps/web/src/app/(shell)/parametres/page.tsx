import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SettingsView } from '@/features/settings/components/SettingsView';
import { loadSettingsPage } from '@/server/preferences';
import { requireContext } from '@/server/tenancy/context';

export const metadata: Metadata = { title: 'Paramètres' };
export const dynamic = 'force-dynamic';

/**
 * Paramètres — D08 (desktop: tabs `?onglet=` vue-d-ensemble · compte-et-securite · claude-code ·
 * serveur · preferences) / M08 (phone: grouped list, tabs as drill-down pages). Every section loads on
 * its own (a runner failure stays inline); `?action=reconnexion` opens the Claude login terminal (T6).
 * Everything is the signed-in account's: its security, its space's settings, its server.
 */
export default async function SettingsPage() {
  const ctx = await requireContext();
  const data = await loadSettingsPage(ctx);
  return (
    <Suspense>
      <SettingsView data={data} />
    </Suspense>
  );
}
