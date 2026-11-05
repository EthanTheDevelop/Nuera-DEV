import type { Metadata } from 'next';
import { IntegrationsView } from '@/features/integrations/page/IntegrationsView';
import { requireUser } from '@/server/auth/session';
import { loadOverview } from './_lib/load';

export const metadata: Metadata = { title: 'Intégrations' };
export const dynamic = 'force-dynamic';

/**
 * Intégrations — D07 (desktop) / M07 (phone): GitHub App, MCP servers, diagnostics, guardrails.
 * URL state: ?github=<code>&compte=<login> (GitHub return routes), ?journal=github|coolify, ?ajout=1.
 * Data read from the database only (no network call); a failure stays inline (T4).
 */
export default async function IntegrationsPage() {
  await requireUser();
  const overview = await loadOverview();
  return <IntegrationsView overview={overview} loadedAt={new Date().toISOString()} />;
}
