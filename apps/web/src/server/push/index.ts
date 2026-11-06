import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { pushSubscriptions, session } from '@nuera/db/schema';
import { and, eq, inArray, ne, type SQL } from 'drizzle-orm';
import { UAParser } from 'ua-parser-js';
import * as webpush from 'web-push';
import { z } from 'zod';
import { evaluateSessionPolicy, type WebSessionPolicy } from '@/server/auth/policy';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { getWebSessionPolicy } from '@/server/settings';

/**
 * Web Push (VAPID) for « Notifications sur ce téléphone » (M08) and the S5 notification.
 * docs/MULTICOMPTE.md §9: subscriptions are per account — one browser may hold the subscriptions of
 * several accounts (one row per account and endpoint) — and every send names its recipients.
 *
 *   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT   (`npx web-push generate-vapid-keys`)
 *   BETTER_AUTH_SECRET                                      (recipient tag key, derived)
 *   NUERA_PUSH_HOSTS                                        (extra push service hosts, optional)
 *
 * Without them the feature is disabled and `getPushStatus()` says why — no fake « activé ».
 * The payload is encrypted with web-push (RFC 8291) and POSTed with fetch; subscriptions answering
 * 404/410 are pruned. Each payload carries `recipient`, an opaque tag of the account it is meant for
 * (`recipientTag`): the service worker's click guard checks it against the signed-in account
 * (`verifyRecipientTag`) before opening the target. The browser side (service worker
 * `public/sw.js`, subscription API) is documented in docs/INTEGRATIONS.md.
 *
 * Lifecycle: `upsertSubscription` (« Activer »), `renewSubscription` (pushsubscriptionchange: only
 * the rows of the account signed in on the browser), `deleteSubscription` (sign-out sends the current
 * endpoint; « Retirer » an appliance), `deleteSubscriptionsForSession` (an access revoked or
 * expired), `deleteSubscriptionsForUser` (account disabled). A subscription lives as long as the web
 * access that registered it (`auth_session_id`): `sendPush` never delivers to a row whose access no
 * longer exists, has expired or is past the web-session policy, and prunes it; the reads of the account
 * (`listPushDevices`, `isEndpointSubscribed`) prune it too, so M08 never shows such a device as on,
 * and `isEndpointSharedWithOtherAccount` ignores another account's closed rows (without writing).
 *
 * Endpoints: only the hosts of the public push services (`isPushServiceEndpoint`) are accepted for a
 * new subscription and ever contacted; redirects are never followed (the web container sits on the
 * internal network, docs/MULTICOMPTE.md §7).
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
// Recipient tag (click guard of the service worker)
// ---------------------------------------------------------------------------------------------

const RECIPIENT_TAG_LABEL = 'nuera:push-recipient:v1';
const RECIPIENT_TAG_BYTES = 16;
const MISSING_SECRET = 'Notifications push désactivées : BETTER_AUTH_SECRET manque dans la configuration du serveur.';

function recipientKey(env: Record<string, string | undefined>): Buffer {
  const secret = env.BETTER_AUTH_SECRET?.trim() ?? '';
  if (!secret) throw new AppError('INTERNAL', MISSING_SECRET);
  // Derived key: the tag never reveals anything about BETTER_AUTH_SECRET itself.
  return createHmac('sha256', secret).update(RECIPIENT_TAG_LABEL).digest();
}

/**
 * Opaque tag of the account a push is meant for: HMAC-SHA256 of the user id under a key derived from
 * BETTER_AUTH_SECRET, truncated to 128 bits (base64url, 22 characters). Reveals neither the id nor
 * the e-mail; stable for an account, different between accounts.
 */
export function recipientTag(userId: string, env: Record<string, string | undefined> = process.env): string {
  return createHmac('sha256', recipientKey(env)).update(userId, 'utf8').digest().subarray(0, RECIPIENT_TAG_BYTES).toString('base64url');
}

/** Constant-time check that `tag` designates `userId` (false for anything malformed). */
export function verifyRecipientTag(userId: string, tag: unknown, env: Record<string, string | undefined> = process.env): boolean {
  if (typeof tag !== 'string' || !userId || !BASE64URL.test(tag)) return false;
  const given = Buffer.from(tag, 'base64url');
  if (given.length !== RECIPIENT_TAG_BYTES) return false;
  try {
    return timingSafeEqual(given, Buffer.from(recipientTag(userId, env), 'base64url'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Subscriptions (one row per account and device)
// ---------------------------------------------------------------------------------------------

/** Hosts of the public Web Push services: Chrome, Edge (FCM or WNS), Firefox, Safari. */
const PUSH_SERVICE_HOSTS = new Set(['fcm.googleapis.com']);
const PUSH_SERVICE_SUFFIXES = ['.push.services.mozilla.com', '.notify.windows.com', '.push.apple.com'];

/** NUERA_PUSH_HOSTS: comma-separated host names; `*.example.org` or `.example.org` for a domain and its subdomains. */
function extraPushHosts(env: Record<string, string | undefined>): string[] {
  return (env.NUERA_PUSH_HOSTS ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase().replace(/^\*\./, '.'))
    .filter((item) => item.length > 1);
}

/**
 * True when `value` is an https endpoint of a known push service (default port, no credentials), of a
 * host listed in NUERA_PUSH_HOSTS, or (outside production only) of a reserved `.test` host (tests).
 * Anything else (internal hosts, IP addresses, arbitrary servers) is never contacted.
 */
export function isPushServiceEndpoint(value: string, env: Record<string, string | undefined> = process.env): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  for (const entry of extraPushHosts(env)) {
    if (entry.startsWith('.') ? host.endsWith(entry) || host === entry.slice(1) : host === entry) return true;
  }
  if (env.NODE_ENV !== 'production' && host.endsWith('.test')) return true;
  if (url.port) return false;
  return PUSH_SERVICE_HOSTS.has(host) || PUSH_SERVICE_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** An endpoint used as a key (old endpoint of a renewal, removal at sign-out): any https address. */
export const pushEndpointSchema = z
  .url("adresse d'abonnement invalide")
  .max(2048)
  .refine((value) => value.startsWith('https://'), 'adresse https attendue');

/** The endpoint of a new subscription: a push service only (it will be contacted). */
const pushServiceEndpointSchema = pushEndpointSchema.refine((value) => isPushServiceEndpoint(value), 'service de notifications push non reconnu');

export const pushSubscriptionInputSchema = z.object({
  endpoint: pushServiceEndpointSchema,
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

/** Body of the renewal (`pushsubscriptionchange` of the service worker), applied to the signed-in account only. */
export const pushRenewalInputSchema = z.object({
  oldEndpoint: pushEndpointSchema,
  subscription: pushSubscriptionInputSchema,
});
export type PushRenewalInput = z.infer<typeof pushRenewalInputSchema>;

/** « Safari · iPhone », « Chrome · Windows » — from the user agent, null when unknown. */
export function deviceLabelFromUserAgent(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const result = UAParser(userAgent);
  const browser = result.browser.name;
  const where = result.device.model || result.os.name;
  const parts = [browser, where].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(' · ').slice(0, 80) : null;
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError('VALIDATION', 'Abonnement aux notifications invalide.', { detail: parsed.error.issues[0]?.message });
  return parsed.data;
}

export interface SavedSubscription {
  id: string;
  deviceLabel: string | null;
  /** This browser also receives the notifications of another Nuera Dev account (never says which). */
  sharedWithOtherAccount: boolean;
}

/** Registers (or refreshes) this account's subscription for this device: unique (user_id, endpoint). */
export async function upsertSubscription(
  userId: string,
  subscription: PushSubscriptionInput,
  options: { authSessionId?: string | null; userAgent?: string | null } = {},
): Promise<SavedSubscription> {
  if (!userId) throw new AppError('UNAUTHORIZED');
  const sub = parseOrThrow(pushSubscriptionInputSchema, subscription);
  const deviceLabel = sub.deviceLabel?.trim() || deviceLabelFromUserAgent(options.userAgent);
  const values = {
    userId,
    endpoint: sub.endpoint,
    p256dh: sub.keys.p256dh,
    auth: sub.keys.auth,
    userAgent: options.userAgent?.slice(0, 512) ?? null,
    deviceLabel,
    authSessionId: options.authSessionId?.slice(0, 200) ?? null,
  };
  const [row] = await db
    .insert(pushSubscriptions)
    .values(values)
    .onConflictDoUpdate({
      target: [pushSubscriptions.userId, pushSubscriptions.endpoint],
      set: { p256dh: values.p256dh, auth: values.auth, userAgent: values.userAgent, deviceLabel, authSessionId: values.authSessionId },
    })
    .returning({ id: pushSubscriptions.id, deviceLabel: pushSubscriptions.deviceLabel });
  if (!row) throw new AppError('INTERNAL', 'Abonnement aux notifications impossible.');
  return { ...row, sharedWithOtherAccount: await isEndpointSharedWithOtherAccount(userId, sub.endpoint) };
}

/**
 * The browser replaced its subscription (`pushsubscriptionchange`): THIS account's row on
 * `oldEndpoint` moves to the new endpoint and keys (the row of the same account already on the new
 * endpoint absorbs it). Never touches another account's rows, even on the same browser: knowing an
 * endpoint proves nothing (every account of a shared browser can read it), so they are left to be
 * pruned by the push service (404/410) and that account turns notifications on again at its next
 * visit. Returns the number of renewed rows (0: this account has no row on `oldEndpoint`, nothing
 * written).
 */
export async function renewSubscription(userId: string, oldEndpoint: string, subscription: PushSubscriptionInput): Promise<number> {
  if (!userId) return 0;
  const previous = parseOrThrow(pushEndpointSchema, oldEndpoint);
  const next = parseOrThrow(pushSubscriptionInputSchema, subscription);
  const keys = { p256dh: next.keys.p256dh, auth: next.keys.auth };
  const mine = (endpoint: string) => and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint));
  return db.transaction(async (tx) => {
    if (previous === next.endpoint) {
      const rows = await tx.update(pushSubscriptions).set(keys).where(mine(previous)).returning({ id: pushSubscriptions.id });
      return rows.length;
    }
    const [already] = await tx.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(mine(next.endpoint)).limit(1);
    if (already) {
      // The account already holds the new endpoint: drop its old row, refresh the new one.
      const absorbed = await tx.delete(pushSubscriptions).where(mine(previous)).returning({ id: pushSubscriptions.id });
      if (absorbed.length) await tx.update(pushSubscriptions).set(keys).where(eq(pushSubscriptions.id, already.id));
      return absorbed.length;
    }
    const moved = await tx
      .update(pushSubscriptions)
      .set({ endpoint: next.endpoint, ...keys })
      .where(mine(previous))
      .returning({ id: pushSubscriptions.id });
    return moved.length;
  });
}

/** Removes this account's subscription for one device (sign-out, « Désactiver »). */
export async function deleteSubscription(userId: string, endpoint: string): Promise<boolean> {
  if (!userId || typeof endpoint !== 'string' || !endpoint) return false;
  const rows = await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)))
    .returning({ id: pushSubscriptions.id });
  return rows.length > 0;
}

/** Removes one of this account's devices by id (« Retirer » in Paramètres). Another account's id: false. */
export async function deleteSubscriptionById(userId: string, id: string): Promise<boolean> {
  if (!userId || !z.uuid().safeParse(id).success) return false;
  const rows = await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.id, id)))
    .returning({ id: pushSubscriptions.id });
  return rows.length > 0;
}

/** Every device of an account (account disabled or deleted). Returns the number removed. */
export async function deleteSubscriptionsForUser(userId: string): Promise<number> {
  if (!userId) return 0;
  const rows = await db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).returning({ id: pushSubscriptions.id });
  return rows.length;
}

/** The devices registered through one web access (that access revoked). Returns the number removed. */
export async function deleteSubscriptionsForSession(authSessionId: string): Promise<number> {
  if (!authSessionId) return 0;
  const rows = await db
    .delete(pushSubscriptions)
    .where(eq(pushSubscriptions.authSessionId, authSessionId))
    .returning({ id: pushSubscriptions.id });
  return rows.length;
}

/**
 * The devices of one web access now belong to the access that replaced it (a password change that
 * closes the other accesses replaces the current one too): revoking the new access later still
 * removes them. Returns the number moved.
 */
export async function moveSubscriptionsToSession(fromAuthSessionId: string, toAuthSessionId: string): Promise<number> {
  if (!fromAuthSessionId || !toAuthSessionId || fromAuthSessionId === toAuthSessionId) return 0;
  const rows = await db
    .update(pushSubscriptions)
    .set({ authSessionId: toAuthSessionId })
    .where(eq(pushSubscriptions.authSessionId, fromAuthSessionId))
    .returning({ id: pushSubscriptions.id });
  return rows.length;
}

type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
type AccessRow = { id: string; userId: string; expiresAt: Date; createdAt: Date; updatedAt: Date } | null;
type RowWithAccess = { row: PushSubscriptionRow; access: AccessRow };

/** Subscriptions with the web access (Better Auth session) that registered them. */
function subscriptionsWithAccess(where: SQL | undefined): Promise<RowWithAccess[]> {
  return db
    .select({
      row: pushSubscriptions,
      access: { id: session.id, userId: session.userId, expiresAt: session.expiresAt, createdAt: session.createdAt, updatedAt: session.updatedAt },
    })
    .from(pushSubscriptions)
    .leftJoin(session, eq(session.id, pushSubscriptions.authSessionId))
    .where(where);
}

/**
 * True when the row's web access still exists for its account and is valid now. A row without an
 * access (registered before the binding) is kept.
 */
function accessIsOpen(row: PushSubscriptionRow, access: AccessRow, policy: WebSessionPolicy | null, now: Date): boolean {
  if (!row.authSessionId) return true;
  if (!access || !policy || access.userId !== row.userId) return false;
  if (access.expiresAt.getTime() <= now.getTime()) return false;
  return evaluateSessionPolicy({ createdAt: access.createdAt, lastActivityAt: access.updatedAt }, policy, now).valid;
}

/**
 * A subscription lives as long as the web access that registered it: closed, expired or past the
 * policy (idle / maximum duration), the device no longer receives (nor shows as receiving) this
 * account's content.
 */
async function splitByAccess(
  found: readonly RowWithAccess[],
  options: { sessionPolicy?: WebSessionPolicy; now?: Date } = {},
): Promise<{ open: PushSubscriptionRow[]; closed: string[] }> {
  const now = options.now ?? new Date();
  const policy = found.some(({ row }) => row.authSessionId) ? (options.sessionPolicy ?? (await getWebSessionPolicy())) : null;
  const open: PushSubscriptionRow[] = [];
  const closed: string[] = [];
  for (const { row, access } of found) {
    if (accessIsOpen(row, access, policy, now)) open.push(row);
    else closed.push(row.id);
  }
  return { open, closed };
}

/** This account's subscriptions (on one endpoint), removing those whose web access is closed. */
async function openSubscriptionsOf(userId: string, endpoint?: string): Promise<PushSubscriptionRow[]> {
  const mine = eq(pushSubscriptions.userId, userId);
  const found = await subscriptionsWithAccess(endpoint ? and(mine, eq(pushSubscriptions.endpoint, endpoint)) : mine);
  const { open, closed } = await splitByAccess(found);
  if (closed.length) await db.delete(pushSubscriptions).where(and(mine, inArray(pushSubscriptions.id, closed)));
  return open;
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
  if (!userId) return [];
  const rows = await openSubscriptionsOf(userId);
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

/** True when this endpoint is registered for this account (lets the browser show the M08 switch state). */
export async function isEndpointSubscribed(userId: string, endpoint: string): Promise<boolean> {
  if (!userId || !endpoint) return false;
  return (await openSubscriptionsOf(userId, endpoint)).length > 0;
}

/** « Ce navigateur reçoit aussi les notifications d'un autre compte Nuera Dev. » (never says which). */
export async function isEndpointSharedWithOtherAccount(userId: string, endpoint: string): Promise<boolean> {
  if (!endpoint) return false;
  // Another account's rows are only read (never pruned from here): a closed access does not count.
  const found = await subscriptionsWithAccess(and(eq(pushSubscriptions.endpoint, endpoint), ne(pushSubscriptions.userId, userId)));
  return (await splitByAccess(found)).open.length > 0;
}

// ---------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------

export interface PushPayload {
  title: string;
  body?: string | null;
  /** Same-origin path opened by a click (« /workspace/<id> »). */
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
  /** Set when nothing was attempted (feature disabled, no recipient, no subscription). */
  skipped: string | null;
}

export interface SendPushOptions {
  /** Recipients (mandatory): only these accounts' devices receive the payload. */
  userIds: readonly string[];
  timeoutMs?: number;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Overrides the environment configuration (tests). */
  config?: PushConfig;
  /** Overrides process.env for the recipient tag key and the push service hosts (tests). */
  env?: Record<string, string | undefined>;
  /** Overrides the web-session policy read from the instance settings (tests). */
  sessionPolicy?: WebSessionPolicy;
  /** Clock (tests). */
  now?: Date;
}

const DEFAULT_ICON = '/icon/192';

function safePath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  return value.slice(0, 500);
}

/** Topic header: ≤ 32 URL-safe base64 characters, derived from the tag. */
function topicOf(tag: string | null | undefined): string | undefined {
  if (!tag) return undefined;
  return Buffer.from(tag).toString('base64url').slice(0, 32) || undefined;
}

export async function sendPush(payload: PushPayload, options: SendPushOptions): Promise<SendPushResult> {
  const config = options.config ?? getPushConfig();
  if (!config.enabled) return { sent: 0, pruned: 0, failed: 0, skipped: config.reason };
  const userIds = [...new Set(options.userIds ?? [])].filter((id) => typeof id === 'string' && id.length > 0);
  if (userIds.length === 0) return { sent: 0, pruned: 0, failed: 0, skipped: 'Aucun destinataire.' };

  const tags = new Map<string, string>();
  try {
    for (const userId of userIds) tags.set(userId, recipientTag(userId, options.env));
  } catch {
    return { sent: 0, pruned: 0, failed: 0, skipped: MISSING_SECRET };
  }

  const found = await subscriptionsWithAccess(inArray(pushSubscriptions.userId, userIds));
  if (found.length === 0) return { sent: 0, pruned: 0, failed: 0, skipped: 'Aucun appareil abonné.' };

  // Never to a device whose web access is closed, expired or past the policy: pruned instead.
  const { open: rows, closed: gone } = await splitByAccess(found, options);
  if (rows.length === 0) {
    await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, gone));
    return { sent: 0, pruned: gone.length, failed: 0, skipped: 'Aucun appareil abonné.' };
  }

  const common = {
    title: payload.title.slice(0, 200),
    body: payload.body ? payload.body.slice(0, 500) : '',
    url: safePath(payload.url),
    tag: payload.tag ?? payload.notificationId ?? null,
    icon: payload.icon ?? DEFAULT_ICON,
    severity: payload.severity ?? 'info',
    kind: payload.kind ?? null,
    notificationId: payload.notificationId ?? null,
  };
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const topic = topicOf(payload.tag);
  const urgency = payload.severity === 'danger' || payload.kind === 'permission_request' || payload.kind === 'session_attention' ? 'high' : 'normal';

  const env = options.env ?? process.env;
  const delivered: string[] = [];
  let failed = 0;
  await Promise.all(
    rows.map(async (row) => {
      // Registered before the push service hosts were enforced: never contacted.
      if (!isPushServiceEndpoint(row.endpoint, env)) {
        failed += 1;
        return;
      }
      try {
        const body = JSON.stringify({ ...common, recipient: tags.get(row.userId) });
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
          // A redirect is a failure: it could point at an internal host.
          redirect: 'manual',
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
