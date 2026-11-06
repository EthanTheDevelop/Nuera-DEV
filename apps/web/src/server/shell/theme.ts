import 'server-only';
import { cookies } from 'next/headers';
import { getCurrentUser } from '@/server/auth/session';
import { getUserPreferences } from '@/server/settings';
import { DEFAULT_THEME, THEME_COOKIE, parseThemePreference, type ThemePreference } from '@/lib/theme';

/**
 * Theme for the SSR of <html data-theme>, per account (docs/MULTICOMPTE.md §8, user_preferences):
 * signed in → the account's own preference (a browser shared by two accounts shows each its own
 * theme); signed out, or the database unreachable → the cookie mirror (set by
 * setThemePreferenceAction) → « Clair ». `app_settings.theme` is never read. Never throws: the
 * sign-in pages must render even when the database is unreachable.
 */
export async function getThemePreference(): Promise<ThemePreference> {
  const jar = await cookies();
  const fromCookie = jar.get(THEME_COOKIE)?.value;
  try {
    const user = await getCurrentUser();
    if (user) {
      const preferences = await getUserPreferences(user.id);
      if (preferences) return parseThemePreference(preferences.theme);
    }
  } catch {
    // database or auth unavailable: the cookie mirror below
  }
  return fromCookie ? parseThemePreference(fromCookie) : DEFAULT_THEME;
}
