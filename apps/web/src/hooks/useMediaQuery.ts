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
