import 'server-only';
import { cookies } from 'next/headers';
import { getAppSettings } from '@/server/settings';
import { DEFAULT_THEME, THEME_COOKIE, parseThemePreference, type ThemePreference } from '@/lib/theme';

/**
 * Theme for the SSR of <html data-theme>: the cookie mirror first (set by setThemePreferenceAction),
 * then app_settings.theme (other device, cleared cookies), then « Clair ». Never throws: the sign-in
 * pages must render even when the database is unreachable.
 */
export async function getThemePreference(): Promise<ThemePreference> {
  const jar = await cookies();
  const fromCookie = jar.get(THEME_COOKIE)?.value;
  if (fromCookie) return parseThemePreference(fromCookie);
  try {
    const settings = await getAppSettings();
    return parseThemePreference(settings.theme);
  } catch {
    return DEFAULT_THEME;
  }
}
