import 'server-only';
import { verifyRecipientTag } from '@/server/push';

/**
 * Click guard of push notifications (public/sw.js → /parametres/notification?vers=&compte=): several
 * accounts may use one browser, one after the other, so a notification meant for account A can be
 * clicked while B is signed in. `compte` is the opaque recipient tag of the payload
 * (`recipientTag()` of `@/server/push`).
 *
 *  - the tag designates the signed-in account (or the notification predates the tags) → open `vers`;
 *  - otherwise → « Cette notification concerne un autre compte Nuera Dev : connectez-vous avec ce
 *    compte pour l'ouvrir. » (never which account).
 */

export const NOTIFICATION_GUARD_PATH = '/parametres/notification';

export const OTHER_ACCOUNT_NOTIFICATION =
  "Cette notification concerne un autre compte Nuera Dev : connectez-vous avec ce compte pour l'ouvrir.";

export type NotificationClick = { kind: 'open'; href: string } | { kind: 'other-account' };

/** Same-origin app path only (no //host, no backslash, no control character, not the guard itself). */
export function safeAppPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\u0000-\u001f]/.test(value)) return '/';
  if (value === NOTIFICATION_GUARD_PATH || value.startsWith(`${NOTIFICATION_GUARD_PATH}?`) || value.startsWith(`${NOTIFICATION_GUARD_PATH}/`)) return '/';
  return value;
}

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

export function resolveNotificationClick(userId: string, input: { vers?: string | string[]; compte?: string | string[] }): NotificationClick {
  const href = safeAppPath(first(input.vers));
  const tag = first(input.compte);
  // Notifications sent before the recipient tags existed carry none: they open as before.
  if (tag === undefined || tag === '') return { kind: 'open', href };
  return verifyRecipientTag(userId, tag) ? { kind: 'open', href } : { kind: 'other-account' };
}
