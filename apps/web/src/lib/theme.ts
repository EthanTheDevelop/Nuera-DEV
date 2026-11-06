/**
 * Theme preference (Paramètres · Préférences « Thème » : « Suit les modes clair et sombre du système de
 * design »). Persisted per account in `user_preferences.theme` (docs/MULTICOMPTE.md §8): the root
 * layout writes `data-theme` on <html> during SSR (no flash) from the signed-in account's preference;
 * the cookie mirror is used only when signed out (server/shell/theme.ts). `system` is resolved by
 * CSS (prefers-color-scheme).
 */
export const THEME_COOKIE = 'nuera-theme';
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export const DEFAULT_THEME: ThemePreference = 'light';

/** Labels for the settings dropdown (Figma shows « Clair »). */
export const THEME_LABELS: Record<ThemePreference, string> = {
  light: 'Clair',
  dark: 'Sombre',
  system: 'Système',
};

export function parseThemePreference(value: string | null | undefined): ThemePreference {
  return (THEME_PREFERENCES as readonly string[]).includes(value ?? '') ? (value as ThemePreference) : DEFAULT_THEME;
}

/** One year, path /, Lax — readable by the server on every request; not a secret. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
