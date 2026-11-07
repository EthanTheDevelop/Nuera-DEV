'use client';

import { useSyncExternalStore } from 'react';

/** Matches the `nav` breakpoint of tokens.css (≥ 900 px = desktop navigation). */
export const NAV_QUERY = '(min-width: 56.25rem)';

/**
 * Subscribes to a media query. Returns `serverDefault` during SSR / hydration, then the real value.
 * Layout should stay CSS-driven (`nav:` variants); use this only for behaviour (Popover vs Sheet…).
 */
export function useMediaQuery(query: string, serverDefault = false): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => serverDefault,
  );
}

/** True on desktop navigation widths (sidebar), false on the phone layout (tab bar). */
export function useIsDesktopNav(): boolean {
  return useMediaQuery(NAV_QUERY, true);
}

/**
 * History mode of an in-page tab change: `push` on desktop (back / forward step through the tabs), `replace`
 * on the phone layout — there the tabs are one screen, and the back arrow / swipe must leave the page.
 * Call it from an event handler (reads the media query at that moment).
 */
export function tabHistoryMode(): 'push' | 'replace' {
  return typeof window !== 'undefined' && window.matchMedia(NAV_QUERY).matches ? 'push' : 'replace';
}
