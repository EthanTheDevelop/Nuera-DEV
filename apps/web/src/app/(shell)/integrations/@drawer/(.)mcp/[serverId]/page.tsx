import { McpServerOverlay } from '@/features/integrations/mcp/McpServerOverlay';
import { requireUser } from '@/server/auth/session';
import { loadMcpDetail, serverIdOf } from '../../../_lib/load';

export const dynamic = 'force-dynamic';

/** Soft navigation to /integrations/mcp/[serverId] from Intégrations: the D1 / D2 drawer over the page. */
export default async function McpServerDrawer({ params }: { params: Promise<{ serverId: string }> }) {
  await requireUser();
  const { serverId } = await params;
  const id = serverIdOf(serverId);
  const load = id ? await loadMcpDetail(id) : ({ ok: 'not_found' } as const);
  return <McpServerOverlay load={load} />;
}
