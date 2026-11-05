'use client';

import { useLayoutEffect, type RefObject } from 'react';

/**
 * Grows a textarea with its content, between one line and `maxHeight` px (then it scrolls).
 * Runs on every value change; the composer keeps `rows={1}` so the empty state is one line.
 */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string, maxHeight: number): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  // eslint-disable-next-line react/exhaustive-effect-dependencies -- value is the trigger: re-measure the textarea on every change
  }, [ref, value, maxHeight]);
}
