'use server';

import { cookies, headers } from 'next/headers';
import { z } from 'zod';
import { requireUser } from '@/server/auth/session';
import { markAllNotificationsRead, markNotificationsRead } from '@/server/notifications';
import { assertSameOriginHeaders } from '@/server/security/origin';
import { updateAppSettings } from '@/server/settings';
import { THEME_COOKIE, THEME_COOKIE_MAX_AGE, THEME_PREFERENCES, type ThemePreference } from '@/lib/theme';

/**
 * Server actions of the shell. Each one re-checks the session (requireUser) and the Origin of the
 * request (CSRF, same rule as every mutation — Next's own server-action check is only a second layer).
 */

async function guard() {
  const user = await requireUser();
  assertSameOriginHeaders(await headers());
  return user;
}

const themeSchema = z.enum(THEME_PREFERENCES);

/** Saves the theme preference (app_settings.theme, audited by updateAppSettings) and its cookie mirror. */
export async function setThemePreferenceAction(preference: ThemePreference): Promise<{ ok: true; theme: ThemePreference }> {
  const user = await guard();
  const theme = themeSchema.parse(preference);
  await updateAppSettings({ theme }, { actorUserId: user.id });
  const jar = await cookies();
  jar.set(THEME_COOKIE, theme, {
    path: '/',
    maxAge: THEME_COOKIE_MAX_AGE,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    httpOnly: false,
  });
  return { ok: true, theme };
}

const idsSchema = z.array(z.uuid()).min(1).max(100);

/** Marks notifications as read (bell panel: opening a notification, « Tout marquer comme lu »). */
export async function markNotificationsReadAction(ids: string[]): Promise<{ updated: number }> {
  await guard();
  const parsed = idsSchema.safeParse(ids);
  if (!parsed.success) return { updated: 0 };
  return { updated: await markNotificationsRead(parsed.data) };
}

export async function markAllNotificationsReadAction(): Promise<{ updated: number }> {
  await guard();
  return { updated: await markAllNotificationsRead() };
}
