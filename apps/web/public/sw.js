/*
 * Nuera Dev service worker — Web Push only (no offline cache: the app always talks to its server).
 *
 * Payload (JSON, sent by apps/web/src/server/push):
 *   { title, body, url, tag, icon, severity, kind, notificationId, recipient }
 * `recipient` is an opaque tag of the account the notification is meant for (several accounts may
 * use the same browser, one after the other).
 *  - push              → showNotification(title, { body, icon, tag, data: { url, recipient } })
 *  - notificationclick → opens the target through the click guard /parametres/notification, which
 *    checks that the signed-in account is the recipient (otherwise: « Cette notification concerne un
 *    autre compte Nuera Dev : connectez-vous avec ce compte pour l'ouvrir. »), in the window already
 *    on that page when there is one; a notification without a recipient tag opens (or focuses) the
 *    page directly
 *  - pushsubscriptionchange → re-subscribes and renews the row of the OLD endpoint through
 *    /api/push/subscription/renew, for the account signed in on this browser only (its session
 *    cookie goes with the request); the other accounts of the browser, or every account when nobody
 *    is signed in, turn notifications on again at their next visit (M08 « Activer »)
 * Only same-origin paths are ever opened.
 */

const DEFAULT_TITLE = 'Nuera Dev';
const DEFAULT_ICON = '/icon/192';
const GUARD_PATH = '/parametres/notification';
const RENEW_PATH = '/api/push/subscription/renew';
/** Last endpoint this worker saw, for a `pushsubscriptionchange` without `oldSubscription`. */
const MEMORY_CACHE = 'nuera-push-v1';
const MEMORY_KEY = '/__nuera/push-endpoint';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([self.clients.claim(), rememberCurrentEndpoint()]));
});

function sameOriginUrl(value) {
  try {
    const url = new URL(typeof value === 'string' && value ? value : '/', self.location.origin);
    return url.origin === self.location.origin ? url : new URL('/', self.location.origin);
  } catch {
    return new URL('/', self.location.origin);
  }
}

/** Same-origin icon path only (« //host/x » or « /\host/x » resolve to another origin). */
function sameOriginIcon(value) {
  if (typeof value !== 'string' || !value) return DEFAULT_ICON;
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search : DEFAULT_ICON;
  } catch {
    return DEFAULT_ICON;
  }
}

/** Recipient tag: base64url, 22 characters (HMAC truncated to 128 bits), anything else dropped. */
function recipientOf(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value) ? value : null;
}

function readPayload(event) {
  if (!event.data) return {};
  try {
    const data = event.data.json();
    return data && typeof data === 'object' ? data : {};
  } catch {
    try {
      return { body: event.data.text() };
    } catch {
      return {};
    }
  }
}

async function remember(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint) return;
  try {
    const cache = await caches.open(MEMORY_CACHE);
    await cache.put(MEMORY_KEY, new Response(endpoint, { headers: { 'content-type': 'text/plain' } }));
  } catch {
    // storage unavailable: the renewal falls back to oldSubscription only
  }
}

async function remembered() {
  try {
    const cache = await caches.open(MEMORY_CACHE);
    const response = await cache.match(MEMORY_KEY);
    return response ? (await response.text()) || null : null;
  } catch {
    return null;
  }
}

async function rememberCurrentEndpoint() {
  try {
    const subscription = await self.registration.pushManager.getSubscription();
    if (subscription) await remember(subscription.endpoint);
  } catch {
    // nothing to remember
  }
}

self.addEventListener('push', (event) => {
  const data = readPayload(event);
  const title = typeof data.title === 'string' && data.title.trim() ? data.title.slice(0, 200) : DEFAULT_TITLE;
  const url = sameOriginUrl(data.url);
  const options = {
    body: typeof data.body === 'string' ? data.body.slice(0, 500) : '',
    icon: sameOriginIcon(data.icon),
    lang: 'fr',
    data: { url: url.pathname + url.search + url.hash, notificationId: data.notificationId || null, recipient: recipientOf(data.recipient) },
  };
  if (typeof data.tag === 'string' && data.tag) {
    options.tag = data.tag.slice(0, 120);
    options.renotify = true;
  }
  if (data.severity === 'danger' || data.kind === 'permission_request') options.requireInteraction = true;
  event.waitUntil(Promise.all([self.registration.showNotification(title, options), rememberCurrentEndpoint()]));
});

/** Where a click goes: the guard when the notification names its recipient, the page itself otherwise. */
function clickTarget(data) {
  const target = sameOriginUrl(data && data.url);
  const recipient = recipientOf(data && data.recipient);
  if (!recipient) return { target, open: target, guarded: false };
  const guard = new URL(GUARD_PATH, self.location.origin);
  guard.searchParams.set('vers', target.pathname + target.search + target.hash);
  guard.searchParams.set('compte', recipient);
  return { target, open: guard, guarded: true };
}

function showsTarget(client, target) {
  try {
    const current = new URL(client.url);
    return current.pathname === target.pathname && current.search === target.search;
  } catch {
    return false;
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { target, open, guarded } = clickTarget(event.notification.data);
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // A window already on that page comes first. Without a recipient tag it is simply focused; with
      // one it still goes through the guard: the same path (« / », « /sessions ») may be showing
      // another account's page, and the click must then say the notification is not for it.
      const windows = [...all.filter((client) => showsTarget(client, target)), ...all.filter((client) => !showsTarget(client, target))];
      if (!guarded) {
        const same = windows.find((client) => showsTarget(client, target) && 'focus' in client);
        if (same) return same.focus();
      }
      for (const client of windows) {
        if ('navigate' in client && 'focus' in client) {
          try {
            await client.focus();
            const navigated = await client.navigate(open.href);
            if (navigated) return navigated;
          } catch {
            // navigate() rejects for a window this worker does not control yet: open a new one.
          }
          break;
        }
      }
      return self.clients.openWindow(open.href);
    })(),
  );
});

function urlBase64ToUint8Array(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

async function applicationServerKey(oldSubscription) {
  const fromOld = oldSubscription && oldSubscription.options && oldSubscription.options.applicationServerKey;
  if (fromOld) return fromOld;
  const response = await fetch(RENEW_PATH, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) return null;
  const config = await response.json();
  return config && config.enabled && config.publicKey ? urlBase64ToUint8Array(config.publicKey) : null;
}

/**
 * The push service replaced the subscription: subscribe again and ask the server to move the row of
 * the OLD endpoint that belongs to the signed-in account (the server never moves another account's
 * row, and writes nothing without a session). Never posts to /api/push/subscription: that would file
 * the device under the signed-in account even when it had not turned notifications on.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const oldEndpoint = (event.oldSubscription && event.oldSubscription.endpoint) || (await remembered());
      if (!oldEndpoint) return;
      let subscription = event.newSubscription || null;
      if (!subscription) {
        const key = await applicationServerKey(event.oldSubscription);
        if (!key) return;
        subscription = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      const response = await fetch(RENEW_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oldEndpoint, subscription: subscription.toJSON() }),
      });
      if (response.ok) await remember(subscription.endpoint);
    })().catch(() => undefined),
  );
});
