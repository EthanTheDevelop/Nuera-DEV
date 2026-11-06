import type { Metadata } from 'next';
import { IntegrationsView } from '@/features/integrations/page/IntegrationsView';
import { requireContext } from '@/server/tenancy/context';
import { loadOverview } from './_lib/load';

export const metadata: Metadata = { title: 'Intégrations' };
export const dynamic = 'force-dynamic';

/**
 * Intégrations — D07 (desktop) / M07 (phone): GitHub App, MCP servers, diagnostics, guardrails.
 * URL state: ?github=<code>&compte=<login>&source=<id> (GitHub return routes), ?journal=github|coolify
 * (&source=<id>), ?ajout=1. Everything is read for the space of the account.
 * Data read from the database only (no network call); a failure stays inline (T4).
 */
export default async function IntegrationsPage() {
  const ctx = await requireContext();
  const overview = await loadOverview(ctx);
  return <IntegrationsView overview={overview} loadedAt={new Date().toISOString()} />;
}
