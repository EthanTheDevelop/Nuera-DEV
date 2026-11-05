'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Card, Drawer, DrawerContent, EmptyState, ErrorPanel, Pastille, Sheet, SheetContent, CompactButton } from '@/components/ui';
import { useIsDesktopNav } from '@/hooks/useMediaQuery';
import type { LoadFailure, McpDetailContext, McpServerView } from '../types';
import { BackToIntegrations, useMcpDetailView } from './McpDetail';

export type McpDetailLoadResult =
  | { ok: true; data: { server: McpServerView; context: McpDetailContext } }
  | { ok: false; error: LoadFailure }
  | { ok: 'not_found' };

/**
 * Intercepted route `/integrations/mcp/[serverId]` over the page (soft navigation): the D1 / D2
 * « Tiroir » (480 px, right, Voile) on desktop, a full-height sheet on the phone. Closing (X, Esc,
 * Voile, « Fermer ») goes back to /integrations.
 */
export function McpServerOverlay({ load }: { load: McpDetailLoadResult }) {
  const router = useRouter();
  const desktop = useIsDesktopNav();
  const [open, setOpen] = useState(true);
  const close = () => {
    setOpen(false);
    router.back();
  };
  if (load.ok !== true) {
    const content =
      load.ok === 'not_found' ? (
        <EmptyState icon="plug" title="Serveur MCP introuvable" variant="plain" action={<CompactButton variant="secondaire" onClick={close}>Revenir aux intégrations</CompactButton>}>
          Il a peut-être été supprimé.
        </EmptyState>
      ) : (
        <ErrorPanel title="Le serveur MCP n'a pas pu être lu" excerpt={load.error.message} untouched="Aucun réglage n'a été modifié." raw={load.error.raw} onRetry={() => router.refresh()} retryLabel="Réessayer" />
      );
    return desktop ? (
      <Drawer open={open} onOpenChange={(next) => (next ? undefined : close())}>
        <DrawerContent title="Serveur MCP" icon="plug">
          {content}
        </DrawerContent>
      </Drawer>
    ) : (
      <Sheet open={open} onOpenChange={(next) => (next ? undefined : close())}>
        <SheetContent title="Serveur MCP">{content}</SheetContent>
      </Sheet>
    );
  }
  return <McpOverlayContent key={load.data.server.id} initial={load.data} open={open} desktop={desktop} onClose={close} />;
}

function McpOverlayContent({
  initial,
  open,
  desktop,
  onClose,
}: {
  initial: { server: McpServerView; context: McpDetailContext };
  open: boolean;
  desktop: boolean;
  onClose: () => void;
}) {
  const view = useMcpDetailView(initial, onClose);
  if (desktop) {
    return (
      <Drawer open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
        <DrawerContent title={view.title} description={view.subtitle} icon={view.icon} status={view.badge} footer={view.footer}>
          {view.body}
        </DrawerContent>
      </Drawer>
    );
  }
  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent title={view.title} className="h-[94dvh] max-h-[94dvh]">
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-3">
            <Pastille icon={view.icon} size={40} />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="m-0 font-sans text-app-13 text-muted">{view.subtitle}</p>
              <div className="flex">{view.badge}</div>
            </div>
          </div>
          {view.body}
        </div>
        <div className="sticky bottom-0 -mx-4 mt-5 flex flex-wrap items-center justify-end gap-2.5 border-t border-border bg-bg px-4 pt-3 pb-3">{view.footer}</div>
      </SheetContent>
    </Sheet>
  );
}

/** Hard load of `/integrations/mcp/[serverId]` (or a phone link opened directly): the same content as a page. */
export function McpServerPage({ load }: { load: McpDetailLoadResult }) {
  const router = useRouter();
  if (load.ok !== true) {
    return (
      <div className="flex flex-col gap-4">
        <BackToIntegrations />
        {load.ok === 'not_found' ? (
          <EmptyState icon="plug" title="Serveur MCP introuvable" action={<CompactButton variant="secondaire" href="/integrations">Revenir aux intégrations</CompactButton>}>
            Il a peut-être été supprimé.
          </EmptyState>
        ) : (
          <ErrorPanel title="Le serveur MCP n'a pas pu être lu" excerpt={load.error.message} untouched="Aucun réglage n'a été modifié." raw={load.error.raw} onRetry={() => router.refresh()} retryLabel="Réessayer" />
        )}
      </div>
    );
  }
  return <McpPageContent key={load.data.server.id} initial={load.data} />;
}

function McpPageContent({ initial }: { initial: { server: McpServerView; context: McpDetailContext } }) {
  const router = useRouter();
  const view = useMcpDetailView(initial, () => router.push('/integrations'));
  return (
    <div className="flex flex-col gap-4 nav:gap-6">
      <BackToIntegrations />
      <Card variant="tile" padding="none" as="section" aria-labelledby="mcp-page-title" className="mx-auto w-full max-w-[720px]">
        <div className="flex flex-col gap-1.5 border-b border-border px-5 pt-6 pb-5 nav:px-6">
          <div className="flex items-center gap-3">
            <Pastille icon={view.icon} size={40} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <h1 id="mcp-page-title" className="m-0 truncate font-sans text-app-20 font-semibold text-text">
                {view.title}
              </h1>
              <p className="m-0 font-sans text-app-13 text-muted">{view.subtitle}</p>
            </div>
          </div>
          <div className="flex">{view.badge}</div>
        </div>
        <div className="flex flex-col gap-5 px-5 py-5 nav:px-6">{view.body}</div>
        <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-border px-5 py-4 nav:px-6">{view.footer}</div>
      </Card>
    </div>
  );
}
