'use client';

import { useSyncExternalStore } from 'react';

const noop = () => () => undefined;

function detectApple(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? navigator.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform) || /Mac OS X/.test(navigator.userAgent);
}

/**
 * Keyboard shortcut label for the command palette: « ⌘K » on Apple devices (as in Figma), « Ctrl K »
 * elsewhere (D01 note: « search palette (⌘K, and its Windows label "Ctrl K") »). SSR renders « ⌘K ».
 */
export function useShortcutLabel(key = 'K'): string {
  const apple = useSyncExternalStore(noop, detectApple, () => true);
  return apple ? `⌘${key}` : `Ctrl ${key}`;
}
