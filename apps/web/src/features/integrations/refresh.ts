'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef } from 'react';

/**
 * `router.refresh()` of the Intégrations page, never while the MCP drawer is open over it: a refresh
 * on the intercepted route `/integrations/mcp/[serverId]` would re-render it as the full page and the
 * drawer would vanish (same pitfall as the Projets modal, CLAUDE.md). Refreshes asked meanwhile — and
 * mutations made in the drawer (`markIntegrationsStale`) — run once the page is current again.
 * Throttled (live events can arrive in bursts) and skipped offline.
 */

const stale = { value: false };

/** The drawer changed something: the page data must be read again when it closes. */
export function markIntegrationsStale(): void {
  stale.value = true;
}

export const INTEGRATIONS_PATH = '/integrations';

export function useIntegrationsRefresh(intervalMs = 1500): () => void {
  const router = useRouter();
  const pathname = usePathname();
  const onPage = pathname === INTEGRATIONS_PATH;
  const deferred = useRef(false);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(() => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (timer.current) return;
    const wait = Math.max(0, last.current + intervalMs - Date.now());
    timer.current = setTimeout(() => {
      timer.current = null;
      last.current = Date.now();
      router.refresh();
    }, wait);
  }, [intervalMs, router]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useEffect(() => {
    if (!onPage) return;
    if (deferred.current || stale.value) {
      deferred.current = false;
      stale.value = false;
      run();
    }
  }, [onPage, run]);

  return useCallback(() => {
    if (onPage) run();
    else deferred.current = true;
  }, [onPage, run]);
}
