'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef } from 'react';
import { useOptionalShellData } from '@/components/shell';

/**
 * `router.refresh()` at most once per `intervalMs` (live events can arrive in bursts). Never
 * refreshes while the browser is offline (Next would turn it into a full navigation, CLAUDE.md).
 */
export function useThrottledRefresh(intervalMs = 1500): () => void {
  const router = useRouter();
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(() => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const wait = Math.max(0, last.current + intervalMs - Date.now());
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      last.current = Date.now();
      router.refresh();
    }, wait);
  }, [intervalMs, router]);
}

/**
 * Writes search params without a server round trip (Next keeps `useSearchParams` in sync with the
 * native History API). `push` adds a history entry (tabs: back / forward work), `replace` does not
 * (steps, filters while typing).
 */
export function writeSearchParams(update: Record<string, string | null | undefined>, mode: 'push' | 'replace' = 'replace'): void {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(update)) {
    if (value === null || value === undefined || value === '') url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  const next = `${url.pathname}${url.search}${url.hash}`;
  // Radix may report the same tab twice (pointer down + focus): never stack identical entries.
  if (next === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  if (mode === 'push') window.history.pushState(null, '', next);
  else window.history.replaceState(null, '', next);
}

/**
 * Name of the server shown in the copy (« VPS-3 » in Figma = the default server). `known` is the
 * server the page's data names (the project's own server, the space's server of a list); the
 * shell's server of the space otherwise.
 */
export function useServerName(known?: string | null): string {
  const shell = useOptionalShellData();
  return known || shell?.environment?.name || shell?.server.name || 'le serveur';
}
