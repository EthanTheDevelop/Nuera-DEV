/*
 * Nuera Dev service worker — Web Push only (no offline cache: the app always talks to VPS-3).
 *
 * Payload (JSON, sent by apps/web/src/server/push): { title, body, url, tag, icon, severity, kind, notificationId }
 *  - push              → showNotification(title, { body, icon, tag, data: { url } })
 *  - notificationclick → focus a window already on that page, else navigate an open window, else open one
 *  - pushsubscriptionchange → re-subscribe with the server key and register the new endpoint
 * Only same-origin paths are ever opened.
 */

const DEFAULT_TITLE = 'Nuera Dev';
const DEFAULT_ICON = '/icon/192';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
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

self.addEventListener('push', (event) => {
  const data = readPayload(event);
  const title = typeof data.title === 'string' && data.title.trim() ? data.title.slice(0, 200) : DEFAULT_TITLE;
  const url = sameOriginUrl(data.url);
  const options = {
    body: typeof data.body === 'string' ? data.body.slice(0, 500) : '',
    icon: sameOriginIcon(data.icon),
    lang: 'fr',
    data: { url: url.pathname + url.search + url.hash, notificationId: data.notificationId || null },
  };
  if (typeof data.tag === 'string' && data.tag) {
    options.tag = data.tag.slice(0, 120);
    options.renotify = true;
  }
  if (data.severity === 'danger' || data.kind === 'permission_request') options.requireInteraction = true;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = sameOriginUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        const current = new URL(client.url);
        if (current.pathname === target.pathname && current.search === target.search && 'focus' in client) {
          return client.focus();
        }
      }
      for (const client of windows) {
        if ('navigate' in client && 'focus' in client) {
          try {
            await client.focus();
            const navigated = await client.navigate(target.href);
            if (navigated) return navigated;
          } catch {
            // navigate() rejects for a window this worker does not control yet: open a new one.
          }
          break;
        }
      }
      return self.clients.openWindow(target.href);
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

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const response = await fetch('/api/push/config', { credentials: 'same-origin' });
      if (!response.ok) return;
      const config = await response.json();
      if (!config.enabled || !config.publicKey) return;
      const subscription = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.publicKey),
      });
      await fetch('/api/push/subscription', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      });
    })().catch(() => undefined),
  );
});
