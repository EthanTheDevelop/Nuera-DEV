import { McpServerOverlay } from '@/features/integrations/mcp/McpServerOverlay';
import { requireContext } from '@/server/tenancy/context';
import { loadMcpDetail, serverIdOf } from '../../../_lib/load';

export const dynamic = 'force-dynamic';

/** Soft navigation to /integrations/mcp/[serverId] from Intégrations: the D1 / D2 drawer over the page. */
export default async function McpServerDrawer({ params }: { params: Promise<{ serverId: string }> }) {
  const ctx = await requireContext();
  const { serverId } = await params;
  const id = serverIdOf(serverId);
  const load = id ? await loadMcpDetail(ctx, id) : ({ ok: 'not_found' } as const);
  return <McpServerOverlay load={load} />;
}
