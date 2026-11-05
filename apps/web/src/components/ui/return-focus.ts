'use client';

import { useRef } from 'react';

/**
 * Focus restoration for Radix Dialog contents opened by state (no `Dialog.Trigger`): Radix gives the
 * focus back to its Trigger only, so a window opened from a menu item, a card button or ⌘K would drop
 * the focus on <body> when it closes. Remembers the element focused at opening and focuses it again
 * at closing (when it is still in the page; otherwise Radix's default applies).
 */
export function useReturnFocus() {
  const previous = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: () => {
      previous.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    },
    onCloseAutoFocus: (event: Event) => {
      const target = previous.current;
      previous.current = null;
      if (!target?.isConnected) return;
      event.preventDefault();
      target.focus({ preventScroll: true });
    },
  };
}
