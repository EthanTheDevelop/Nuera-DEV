import type { ReactNode } from 'react';

/**
 * Intégrations: the page (D07 / M07, or the full page of one MCP server on a hard load) + the
 * `@drawer` slot where an MCP server opens over the page on a soft navigation (intercepting route
 * `(.)mcp/[serverId]`, D1 / D2).
 */
export default function IntegrationsLayout({ children, drawer }: { children: ReactNode; drawer: ReactNode }) {
  return (
    <>
      {children}
      {drawer}
    </>
  );
}
