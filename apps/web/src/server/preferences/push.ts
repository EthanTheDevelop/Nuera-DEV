import 'server-only';
import type { PushView } from '@/features/settings/lib/types';
import { getPushStatus, listPushDevices } from '@/server/push';

/** Web Push of « Notifications sur ce téléphone »: VAPID status + the devices of this account (never another account's). */
export async function getPushView(userId: string): Promise<PushView> {
  const status = getPushStatus();
  const devices = await listPushDevices(userId);
  return { enabled: status.enabled, publicKey: status.publicKey, reason: status.reason, devices };
}
