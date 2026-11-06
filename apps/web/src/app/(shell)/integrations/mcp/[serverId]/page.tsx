import type { Metadata } from 'next';
import { McpServerPage } from '@/features/integrations/mcp/McpServerOverlay';
import { requireContext } from '@/server/tenancy/context';
import { loadMcpDetail, serverIdOf } from '../../_lib/load';

export const metadata: Metadata = { title: 'Serveur MCP · Intégrations' };
export const dynamic = 'force-dynamic';

/** Hard load of /integrations/mcp/[serverId] (D1 / D2 content as a page; `?journal=1` opens the journal). */
export default async function McpServerFullPage({ params }: { params: Promise<{ serverId: string }> }) {
  const ctx = await requireContext();
  const { serverId } = await params;
  const id = serverIdOf(serverId);
  const load = id ? await loadMcpDetail(ctx, id) : ({ ok: 'not_found' } as const);
  return <McpServerPage load={load} />;
}
