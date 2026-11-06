import { describe, expect, it } from 'vitest';
import { recipientTag } from '@/server/push';
import { NOTIFICATION_GUARD_PATH, OTHER_ACCOUNT_NOTIFICATION, resolveNotificationClick, safeAppPath } from './notification-guard';

const env = { BETTER_AUTH_SECRET: 'secret-de-test-0123456789abcdef0123456789' };

describe('click guard of push notifications', () => {
  it("opens the page for the notification's recipient, and tells another account it is not its own", () => {
    process.env.BETTER_AUTH_SECRET = env.BETTER_AUTH_SECRET;
    const forA = recipientTag('user-a', env);
    expect(resolveNotificationClick('user-a', { vers: '/workspace/abc#demande-1', compte: forA })).toEqual({ kind: 'open', href: '/workspace/abc#demande-1' });
    expect(resolveNotificationClick('user-b', { vers: '/workspace/abc', compte: forA })).toEqual({ kind: 'other-account' });
    expect(resolveNotificationClick('user-b', { vers: '/workspace/abc', compte: 'pas-un-tag' })).toEqual({ kind: 'other-account' });
    expect(resolveNotificationClick('user-b', { vers: '/workspace/abc', compte: [forA, 'x'] })).toEqual({ kind: 'other-account' });
    expect(OTHER_ACCOUNT_NOTIFICATION).toBe("Cette notification concerne un autre compte Nuera Dev : connectez-vous avec ce compte pour l'ouvrir.");
  });

  it('opens a notification sent before the tags existed as before', () => {
    expect(resolveNotificationClick('user-b', { vers: '/sessions' })).toEqual({ kind: 'open', href: '/sessions' });
  });

  it('only ever opens a same-origin app path (never the guard itself)', () => {
    for (const unsafe of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '', NOTIFICATION_GUARD_PATH, `${NOTIFICATION_GUARD_PATH}?vers=/x`, '/a\u0000b']) {
      expect(safeAppPath(unsafe)).toBe('/');
    }
    expect(safeAppPath(['/projets'])).toBe('/');
    expect(safeAppPath('/projets/abc?onglet=branches')).toBe('/projets/abc?onglet=branches');
  });
});
