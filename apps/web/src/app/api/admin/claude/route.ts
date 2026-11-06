import { loadClaudeAdminOverview } from '@/server/claude-config';
import { apiRoute } from '@/server/http';

/**
 * Configuration Claude commune (Administration › Claude), owner and administrators only (403 otherwise).
 *   GET → { rows: { rules, skills, mcp, policy }, pendingProposals, servers, isOwner } (no secret: MCP
 *         servers expose the NAMES of their secret headers only)
 */
export const dynamic = 'force-dynamic';

export const GET = apiRoute({ auth: 'admin', handler: async ({ user }) => loadClaudeAdminOverview(user) });
