import { describe, expect, it } from 'vitest';
import { NOTIFICATION_KINDS } from '@/server/notifications';
import { NOTIFICATION_KIND_SPECS, notificationKindSpec } from './NotificationItem';

describe('NotificationItem kinds', () => {
  it('covers exactly the notification kinds of the server', () => {
    expect(Object.keys(NOTIFICATION_KIND_SPECS).sort()).toEqual([...NOTIFICATION_KINDS].sort());
  });

  it('shows a kind this build does not know with the neutral bell', () => {
    expect(notificationKindSpec('account_disabled')).toEqual({ icon: 'bell', tone: 'accent' });
    expect(notificationKindSpec('toString')).toEqual({ icon: 'bell', tone: 'accent' });
    expect(notificationKindSpec('server')).toEqual(NOTIFICATION_KIND_SPECS.server);
  });
});
