'use client';

import { useEffect, useState } from 'react';

/**
 * Current time, refreshed every `intervalMs` (default 30 s) — for relative times (« il y a 3 min »)
 * and countdowns (« nouvel essai dans 4 s », interval 1 000). Pass `initial` (e.g. the server's
 * `generatedAt`) when the value is rendered during SSR, so server and hydration output match.
 */
export function useNow(intervalMs = 30_000, initial?: number): number {
  const [now, setNow] = useState(() => initial ?? Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
