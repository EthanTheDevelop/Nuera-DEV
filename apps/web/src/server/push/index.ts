import 'server-only';
import { pushSubscriptions } from '@nuera/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { UAParser } from 'ua-parser-js';
import * as webpush from 'web-push';
import { z } from 'zod';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';

/**
 * Web Push (VAPID) for « Notifications sur ce téléphone » (M08) and the S5 notification.
 *
 *   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT   (`npx web-push generate-vapid-keys`)
 *
 * Without them the feature is disabled and `getPushStatus()` says why — no fake « activé ».
 * The payload is encrypted with web-push (RFC 8291) and POSTed with fetch; subscriptions answering
 * 404/410 are pruned. The browser side (service worker `public/sw.js`, subscription API) is
 * documented in docs/INTEGRATIONS.md.
 */

export type PushConfig =
  | { enabled: true; publicKey: string; privateKey: string; subject: string }
  | { enabled: false; reason: string };

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function decodedLength(value: string): number {
  try {
    return Buffer.from(value, 'base64url').length;
  } catch {
    return 0;
  }
}

/** Reads and validates the VAPID configuration from the environment. */
export function getPushConfig(env: Record<string, string | undefined> = process.env): PushConfig {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim() ?? '';
  const privateKey = env.VAPID_PRIVATE_KEY?.trim() ?? '';
  // Contact for the push services: VAPID_SUBJECT, else the public https URL of the app (no invented address).
  const appUrl = env.APP_URL?.trim() ?? '';
  const subject = env.VAPID_SUBJECT?.trim() || (appUrl.startsWith('https://') ? appUrl : '');
  const missing = [
    !publicKey && 'VAPID_PUBLIC_KEY',
    !privateKey && 'VAPID_PRIVATE_KEY',
    !subject && 'VAPID_SUBJECT',
  ].filter(Boolean);
  if (missing.length) {
    return {
      enabled: false,
      reason: `Notifications push désactivées : ${missing.join(', ')} ${missing.length > 1 ? 'manquent' : 'manque'} dans la configuration du serveur.`,
    };
  }
  if (!BASE64URL.test(publicKey) || decodedLength(publicKey) !== 65) {
    return { enabled: false, reason: 'Notifications push désactivées : VAPID_PUBLIC_KEY est invalide (clé P-256 en base64url attendue).' };
  }
  if (!BASE64URL.test(privateKey) || decodedLength(privateKey) !== 32) {
    return { enabled: false, reason: 'Notifications push désactivées : VAPID_PRIVATE_KEY est invalide (32 octets en base64url attendus).' };
  }
  if (!/^mailto:.+@.+/.test(subject) && !/^https:\/\/.+/.test(subject)) {
    return { enabled: false, reason: 'Notifications push désactivées : VAPID_SUBJECT doit être une adresse mailto: ou une URL https.' };
  }
  return { enabled: true, publicKey, privateKey, subject };
}

export interface PushStatus {
  enabled: boolean;
  /** Application server key for `pushManager.subscribe({ applicationServerKey })`. */
  publicKey: string | null;
  /** Why the feature is unavailable (French), null when enabled. */
  reason: string | null;
}

export function getPushStatus(): PushStatus {
  const config = getPushConfig();
  return config.enabled
    ? { enabled: true, publicKey: config.publicKey, reason: null }
    : { enabled: false, publicKey: null, reason: config.reason };
}

// ---------------------------------------------------------------------------------------------
// Subscriptions (one per device)
// ---------------------------------------------------------------------------------------------

export const pushSubscriptionInputSchema = z.object({
  endpoint: z
    .url("adresse d'abonnement invalide")
    .max(2048)
    .refine((value) => value.startsWith('https://'), 'adresse https attendue'),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z
      .string()
      .regex(BASE64URL, 'clé p256dh invalide')
      .refine((value) => decodedLength(value) === 65, 'clé p256dh invalide'),
    auth: z
      .string()
      .regex(BASE64URL, 'secret auth invalide')
      .refine((value) => decodedLength(value) >= 16, 'secret auth invalide'),
  }),
  /** Optional label chosen by the user (« iPhone de Nezar »); derived from the user agent otherwise. */
  deviceLabel: z.string().trim().max(80).optional().nullable(),
});
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionInputSchema>;

/** « Safari · iPhone », « Chrome · Windows » — from the user agent, null when unknown. */
export function deviceLabelFromUserAgent(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const result = UAParser(userAgent);
  const browser = result.browser.name;
  const where = result.device.model || result.os.name;
  const parts = [browser, where].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(' · ').slice(0, 80) : null;
}

export async function savePushSubscription(input: {
  userId: string;
  subscription: PushSubscriptionInput;
  userAgent?: string | null;
}): Promise<{ id: string; deviceLabel: string | null }> {
  const sub = pushSubscriptionInputSchema.parse(input.subscription);
  const deviceLabel = sub.deviceLabel?.trim() || deviceLabelFromUserAgent(input.userAgent);
  const values = {
    userId: input.userId,
    endpoint: sub.endpoint,
    p256dh: sub.keys.p256dh,
    auth: sub.keys.auth,
    userAgent: input.userAgent?.slice(0, 512) ?? null,
    deviceLabel,
  };
  const [row] = await db
    .insert(pushSubscriptions)
    .values(values)
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId: values.userId, p256dh: values.p256dh, auth: values.auth, userAgent: values.userAgent, deviceLabel },
    })
    .returning({ id: pushSubscriptions.id, deviceLabel: pushSubscriptions.deviceLabel });
  if (!row) throw new AppError('INTERNAL', 'Abonnement aux notifications impossible.');
  return row;
}

export async function deletePushSubscription(input: { userId: string; endpoint?: string; id?: string }): Promise<boolean> {
  if (!input.endpoint && !input.id) throw new AppError('VALIDATION', 'Abonnement à supprimer non précisé.');
  const rows = await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.userId, input.userId),
        input.id ? eq(pushSubscriptions.id, input.id) : eq(pushSubscriptions.endpoint, input.endpoint!),
      ),
    )
    .returning({ id: pushSubscriptions.id });
  return rows.length > 0;
}

export interface PushDevice {
  id: string;
  deviceLabel: string | null;
  /** Push service host only (fcm.googleapis.com, web.push.apple.com…), never the full endpoint. */
  service: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export async function listPushDevices(userId: string): Promise<PushDevice[]> {
  const rows = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  return rows
    .map((row) => ({
      id: row.id,
      deviceLabel: row.deviceLabel,
      service: (() => {
        try {
          return new URL(row.endpoint).host;
        } catch {
          return 'inconnu';
        }
      })(),
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** True when this endpoint is registered (lets the browser show the M08 switch state). */
export async function isEndpointSubscribed(userId: string, endpoint: string): Promise<boolean> {
  const [row] = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)))
    .limit(1);
  return Boolean(row);
}

// ---------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------

export interface PushPayload {
  title: string;
  body?: string | null;
  /** Same-origin path opened by a click (« /sessions/<id>?vue=session »). */
  url?: string | null;
  /** Replaces a previous notification with the same tag (dedup key). */
  tag?: string | null;
  icon?: string | null;
  severity?: 'info' | 'success' | 'warning' | 'danger';
  kind?: string;
  notificationId?: string;
}

export interface SendPushResult {
  sent: number;
  pruned: number;
  failed: number;
  /** Set when nothing was attempted (feature disabled, no subscription). */
  skipped: string | null;
}

export interface SendPushOptions {
  /** Only this user's devices (single owner: every device by default). */
  userId?: string;
  timeoutMs?: number;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Overrides the environment configuration (tests). */
  config?: PushConfig;
}

const DEFAULT_ICON = '/icon/192';

function safePath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value.slice(0, 500);
}

/** Topic header: ≤ 32 URL-safe base64 characters, derived from the tag. */
function topicOf(tag: string | null | undefined): string | undefined {
  if (!tag) return undefined;
  return Buffer.from(tag).toString('base64url').slice(0, 32) || undefined;
}

export async function sendPush(payload: PushPayload, options: SendPushOptions = {}): Promise<SendPushResult> {
  const config = options.config ?? getPushConfig();
  if (!config.enabled) return { sent: 0, pruned: 0, failed: 0, skipped: config.reason };
  const rows = await db
    .select()
    .from(pushSubscriptions)
    .where(options.userId ? eq(pushSubscriptions.userId, options.userId) : undefined);
  if (rows.length === 0) return { sent: 0, pruned: 0, failed: 0, skipped: 'Aucun appareil abonné.' };

  const body = JSON.stringify({
    title: payload.title.slice(0, 200),
    body: payload.body ? payload.body.slice(0, 500) : '',
    url: safePath(payload.url),
    tag: payload.tag ?? payload.notificationId ?? null,
    icon: payload.icon ?? DEFAULT_ICON,
    severity: payload.severity ?? 'info',
    kind: payload.kind ?? null,
    notificationId: payload.notificationId ?? null,
  });
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const topic = topicOf(payload.tag);
  const urgency = payload.severity === 'danger' || payload.kind === 'permission_request' ? 'high' : 'normal';

  const gone: string[] = [];
  const delivered: string[] = [];
  let failed = 0;
  await Promise.all(
    rows.map(async (row) => {
      try {
        const details = webpush.generateRequestDetails(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          body,
          {
            vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
            TTL: 3600,
            urgency,
            ...(topic ? { topic } : {}),
          },
        );
        const response = await fetchImpl(details.endpoint, {
          method: details.method,
          headers: Object.fromEntries(Object.entries(details.headers).map(([key, value]) => [key, String(value)])),
          body: details.body ? new Uint8Array(details.body) : null,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status === 404 || response.status === 410) gone.push(row.id);
        else if (response.ok) delivered.push(row.id);
        else failed += 1;
        await response.body?.cancel().catch(() => undefined);
      } catch {
        failed += 1;
      }
    }),
  );
  if (gone.length) await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, gone));
  if (delivered.length) {
    await db.update(pushSubscriptions).set({ lastUsedAt: new Date() }).where(inArray(pushSubscriptions.id, delivered));
  }
  return { sent: delivered.length, pruned: gone.length, failed, skipped: null };
}
