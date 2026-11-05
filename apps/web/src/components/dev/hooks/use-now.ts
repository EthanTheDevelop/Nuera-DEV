'use client';

import { useEffect, useState } from 'react';

/**
 * Current time that re-renders every `intervalMs` (live durations: `en cours · 38 s`, `12 min`).
 * The first render uses the time of the render on both server and client; callers print it with
 * `suppressHydrationWarning` (a minute boundary can differ by a second between the two).
 * Pass `enabled: false` to stop ticking (finished sessions, frozen galleries).
 */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}
