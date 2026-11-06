'use client';

import { useCallback, useState, useSyncExternalStore, useTransition } from 'react';
import { setThemePreferenceAction } from '@/server/shell/actions';
import { DEFAULT_THEME, parseThemePreference, type ThemePreference } from '@/lib/theme';

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

const read = () => parseThemePreference(document.documentElement.dataset.theme);

/**
 * Theme preference (Clair / Sombre / Système). `setTheme` applies it immediately on <html data-theme>
 * (CSS resolves `system` with prefers-color-scheme), then persists it through a server action
 * (the account's `user_preferences.theme`, plus a cookie mirror read only while signed out —
 * server/shell/theme.ts). On failure the previous value is restored.
 */
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, read, () => DEFAULT_THEME);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const setTheme = useCallback((next: ThemePreference) => {
    const previous = read();
    document.documentElement.dataset.theme = next;
    setError(null);
    startTransition(async () => {
      try {
        await setThemePreferenceAction(next);
      } catch {
        document.documentElement.dataset.theme = previous;
        setError("Le thème n'a pas pu être enregistré.");
      }
    });
  }, []);

  return { theme, setTheme, pending, error };
}
