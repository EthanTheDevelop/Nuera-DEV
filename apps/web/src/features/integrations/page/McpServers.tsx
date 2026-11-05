'use client';

import { AddMcpServerCard, IntegrationRow, McpServerCard, mcpStatusBadge } from '@/components/dev';
import { Icon } from '@/components/icons';
import type { CSSProperties } from 'react';
import { Card, CompactButton, EmptyState, SectionLabel } from '@/components/ui';
import { cn } from '@/lib/cn';
import { effectiveMcpStatus, iconOf, mcpCardAction, mcpHref } from '../model';
import type { CoolifySettingsView, McpServerView } from '../types';

export interface McpServersProps {
  servers: McpServerView[];
  coolify: Pick<CoolifySettingsView, 'configured' | 'status'>;
  onAdd: () => void;
}

/** Up to this many servers, the cards and the add tile share one line from 1280 px. */
const ONE_LINE_MAX = 4;

/** D07 title row (`SERVEURS MCP · 4` + « Activés projet par projet… ») and `Grille MCP` (216:2166…2242). */
export function McpGrid({ servers, coolify, onAdd }: McpServersProps) {
  return (
    <section aria-labelledby="mcp-title" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-baseline gap-2">
        <SectionLabel as="h2" id="mcp-title">{`Serveurs MCP · ${servers.length}`}</SectionLabel>
        <p className="m-0 font-sans text-app-12 text-muted">Activés projet par projet, dans Détail du projet · Outils MCP.</p>
      </div>
      {servers.length === 0 ? (
        <EmptyState
          icon="plug"
          title="Aucun serveur MCP"
          action={
            <CompactButton variant="principal" icon="plus" onClick={onAdd}>
              Ajouter un serveur MCP
            </CompactButton>
          }
        >
          Ajoutez un serveur MCP, puis activez-le dans les projets qui en ont besoin.
        </EmptyState>
      ) : (
        <ul
          className={cn(
            // `Grille MCP`: equal cards + the 160 px add tile, on one line from 1280 px (D07 at 1440: 4 × ≈ 221 + 160);
            // narrower, a regular grid where the add tile is one more cell (no stretched orphan row).
            'm-0 grid list-none grid-cols-[repeat(auto-fill,minmax(200px,1fr))] items-stretch gap-5 p-0',
            servers.length <= ONE_LINE_MAX && 'min-[1280px]:grid-cols-[repeat(var(--mcp-cards),minmax(0,1fr))_160px]',
          )}
          style={{ '--mcp-cards': servers.length } as CSSProperties}
        >
          {servers.map((server) => {
            const status = effectiveMcpStatus(server, coolify);
            const action = mcpCardAction(server, status);
            return (
              <li key={server.id} className="flex min-w-0">
                <McpServerCard
                  name={server.label}
                  icon={iconOf(server.icon)}
                  description={server.description}
                  status={status}
                  projectCount={server.projectCount}
                  action={{ label: action.label, href: action.href, variant: action.variant, ...(action.icon ? { icon: action.icon } : {}) }}
                  className="w-full"
                />
              </li>
            );
          })}
          <li className="flex min-w-0">
            <AddMcpServerCard onClick={onAdd} />
          </li>
        </ul>
      )}
    </section>
  );
}

/** M07 overline + `Serveurs MCP` list card: one row per server (status, chevron) and the add row. */
export function McpList({ servers, coolify, onAdd }: McpServersProps) {
  return (
    <section aria-labelledby="mcp-phone-title" className="flex flex-col gap-4">
      <SectionLabel as="h2" id="mcp-phone-title">{`Serveurs MCP · ${servers.length}`}</SectionLabel>
      <Card variant="card" padding="none" className="px-4 py-1">
        {servers.map((server) => (
          <IntegrationRow
            key={server.id}
            name={server.label}
            icon={iconOf(server.icon)}
            detail={server.description}
            badge={mcpStatusBadge(effectiveMcpStatus(server, coolify), 'short')}
            href={mcpHref(server.name)}
            variant="phone"
          />
        ))}
        <button
          type="button"
          onClick={onAdd}
          className="flex min-h-11 w-full min-w-0 items-center gap-3 py-3 text-left transition-colors duration-(--dur-fast) hover:bg-hover"
        >
          <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-sm border border-dashed border-border">
            <Icon name="plus" size={18} className="text-accent" />
          </span>
          <span className="font-sans text-app-15 font-medium text-accent">Ajouter un serveur MCP</span>
        </button>
      </Card>
    </section>
  );
}
