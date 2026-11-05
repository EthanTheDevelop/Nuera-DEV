'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { PageHeader, useOptionalShellData } from '@/components/shell';
import { Button, ErrorPanel } from '@/components/ui';
import { useDeferLiveRefresh, useLiveEvent } from '@/hooks/useLiveEvents';
import { AddMcpServerDialog } from '../add/AddMcpServerDialog';
import { integrationsApi } from '../api';
import { GithubSection } from '../github/GithubSection';
import { isPageJournal, JournalDialog } from '../journal/JournalDialog';
import { INTEGRATIONS_PATH, useIntegrationsRefresh } from '../refresh';
import type { IntegrationsOverview, Loaded } from '../types';
import { DiagnosticBanners, PhoneAlerts } from './Diagnostics';
import { GithubNotice } from './GithubNotice';
import { Guardrails, PhoneGuardrail } from './Guardrails';
import { McpGrid, McpList } from './McpServers';

/** The page data is read again when it gets this old and the tab comes back to the foreground. */
const STALE_AFTER_MS = 5 * 60_000;

function writeParam(key: string, value: string | null, mode: 'push' | 'replace') {
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete(key);
  else url.searchParams.set(key, value);
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (next === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  if (mode === 'push') window.history.pushState(null, '', next);
  else window.history.replaceState(null, '', next);
}

/**
 * Intégrations — D07 (desktop: GitHub tile, MCP grid, diagnostic banners, guardrails) and M07
 * (phone: condensed GitHub card, alert cards above the MCP list, guardrail footnote). URL state:
 * `?github=<code>` (return of the GitHub flows), `?journal=github|coolify`, `?ajout=1` (add form).
 * Live: integration notifications (T7 transitions) and `stream.reset` re-read the page data.
 */
export function IntegrationsView({ overview, loadedAt }: { overview: Loaded<IntegrationsOverview>; loadedAt: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const refresh = useIntegrationsRefresh();
  const serverName = useOptionalShellData()?.server.name ?? 'VPS-3';
  const [addOpen, setAddOpen] = useState(false);
  const onPage = pathname === INTEGRATIONS_PATH;
  // The MCP drawer (intercepted route) is shown over the page: the shell's refreshes wait for it to close.
  useDeferLiveRefresh(!onPage);
  const addParam = onPage && params.get('ajout') === '1';
  const journalParam = onPage ? params.get('journal') : null;
  const journal = isPageJournal(journalParam) ? journalParam : null;

  useLiveEvent('notification.created', (event) => {
    if (event.data.kind.startsWith('integration_')) refresh();
  });

  // Back to the foreground after a while: the last checks (every 15 min) may have changed things.
  useEffect(() => {
    const loaded = new Date(loadedAt).getTime();
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - loaded > STALE_AFTER_MS) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadedAt, refresh]);

  const openAdd = () => {
    setAddOpen(true);
    writeParam('ajout', '1', 'push');
  };
  const setAdd = (open: boolean) => {
    setAddOpen(open);
    if (!open && params.get('ajout') === '1') writeParam('ajout', null, 'replace');
  };

  const header = (
    <PageHeader
      title="Intégrations"
      subtitle={
        <>
          <span className="nav:hidden">{`Les accès utilisés sur ${serverName}, sans secret affiché`}</span>
          <span className="hidden nav:inline">{`Les accès que Nuera Dev et Claude Code utilisent sur ${serverName}. Aucun secret n'est affiché ici.`}</span>
        </>
      }
      actions={
        overview.ok ? (
          <Button variant="accent" onClick={openAdd}>
            Ajouter un serveur MCP
          </Button>
        ) : undefined
      }
    />
  );

  if (!overview.ok) {
    return (
      <div className="flex flex-col gap-4 nav:gap-6">
        {header}
        <ErrorPanel
          title="Les intégrations n'ont pas pu être lues"
          excerpt={[overview.error.message, overview.error.detail].filter(Boolean).join(' · ')}
          untouched="Aucun accès n'a été modifié."
          raw={overview.error.raw}
          onRetry={() => router.refresh()}
          retryLabel="Réessayer"
        />
      </div>
    );
  }

  const data = overview.data;
  const presets = data.mcp.servers.filter((server) => server.preset && server.projectCount === 0);
  const checkGithubFromNotice = () => {
    void integrationsApi
      .checkGithub()
      .catch(() => undefined)
      .finally(refresh);
  };

  return (
    <div className="flex flex-col gap-4 nav:gap-6">
      {header}
      <GithubNotice installUrl={data.github.mode === 'app' ? data.github.installUrl : null} onCheck={checkGithubFromNotice} />

      {/* D07 — desktop */}
      <div className="hidden flex-col gap-6 nav:flex">
        <GithubSection github={data.github} onChanged={refresh} variant="desktop" />
        <McpGrid servers={data.mcp.servers} coolify={data.coolify} onAdd={openAdd} />
        <DiagnosticBanners diagnostics={data.diagnostics} overview={data} />
        <Guardrails guardrails={data.guardrails} />
      </div>

      {/* M07 — phone */}
      <div className="flex flex-col gap-4 nav:hidden">
        <GithubSection github={data.github} onChanged={refresh} variant="phone" />
        <PhoneAlerts diagnostics={data.diagnostics} overview={data} />
        <McpList servers={data.mcp.servers} coolify={data.coolify} onAdd={openAdd} />
        <PhoneGuardrail />
      </div>

      <AddMcpServerDialog open={addOpen || addParam} onOpenChange={setAdd} presets={presets} serverName={serverName} onCreated={refresh} />
      <JournalDialog journal={journal} overview={data} onClose={() => writeParam('journal', null, 'replace')} />
    </div>
  );
}
