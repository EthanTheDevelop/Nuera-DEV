'use client';

import { useCallback, useEffect, useState } from 'react';
import type { PushDeviceView } from '../lib/types';

/**
 * Web Push of THIS device (M08 « Notifications »): registers /sw.js, subscribes with the VAPID key of
 * /api/push/config, saves / deletes the subscription through /api/push/subscription. Never pretends:
 * every unavailable case carries its French reason.
 */

export type PushSupport =
  | { kind: 'checking' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'denied'; reason: string }
  | { kind: 'ready' };

export interface PushState {
  support: PushSupport;
  /** This browser has a subscription registered on the server. */
  subscribed: boolean;
  busy: boolean;
  error: string | null;
  devices: PushDeviceView[];
  enable: () => Promise<boolean>;
  disable: () => Promise<boolean>;
  removeDevice: (id: string) => Promise<boolean>;
  sendTest: () => Promise<{ sent: number } | null>;
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string; detail?: string } };
    if (body.error?.message) return body.error.detail ? `${body.error.message} ${body.error.detail}` : body.error.message;
  } catch {
    // not JSON
  }
  return `Le serveur a répondu ${response.status}.`;
}

function detectSupport(): PushSupport {
  if (typeof window === 'undefined') return { kind: 'checking' };
  if (!window.isSecureContext) return { kind: 'unsupported', reason: 'Les notifications push exigent une connexion sécurisée (https).' };
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') {
    return {
      kind: 'unsupported',
      reason:
        ios && !standalone
          ? "Sur iPhone, ajoutez d'abord Nuera Dev à l'écran d'accueil (Partager · Sur l'écran d'accueil), puis ouvrez-le depuis l'icône."
          : 'Ce navigateur ne prend pas en charge les notifications push.',
    };
  }
  if (Notification.permission === 'denied') {
    return { kind: 'denied', reason: 'Notifications refusées pour ce site : autorisez-les dans les réglages du navigateur.' };
  }
  return { kind: 'ready' };
}

export function usePushSubscription({ enabled, publicKey, initialDevices }: { enabled: boolean; publicKey: string | null; initialDevices: PushDeviceView[] }): PushState {
  const [support, setSupport] = useState<PushSupport>({ kind: 'checking' });
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState(initialDevices);
  const [snapshot, setSnapshot] = useState(initialDevices);
  if (snapshot !== initialDevices) {
    setSnapshot(initialDevices);
    setDevices(initialDevices);
  }

  const reload = useCallback(async (endpoint?: string | null) => {
    const query = endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : '';
    const response = await fetch(`/api/push/subscription${query}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(await readError(response));
    const body = (await response.json()) as { subscribed: boolean | null; devices: PushDeviceView[] };
    setDevices(body.devices);
    return body;
  }, []);

  useEffect(() => {
    const detected = detectSupport();
    setSupport(detected);
    if (detected.kind !== 'ready' || !enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const registration = await navigator.serviceWorker.getRegistration('/');
        const subscription = await registration?.pushManager.getSubscription();
        if (!subscription) return;
        const body = await reload(subscription.endpoint);
        if (!cancelled) setSubscribed(body.subscribed === true);
      } catch {
        // State unknown: the switch stays off, the next action reports the error.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, reload]);

  const enable = useCallback(async () => {
    if (!enabled || !publicKey) return false;
    setBusy(true);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setSupport(detectSupport());
        setError(permission === 'denied' ? 'Notifications refusées pour ce site : autorisez-les dans les réglages du navigateur.' : 'Autorisation des notifications non accordée.');
        return false;
      }
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) }));
      const response = await fetch('/api/push/subscription', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!response.ok) {
        if (!existing) await subscription.unsubscribe().catch(() => undefined);
        throw new Error(await readError(response));
      }
      setSubscribed(true);
      await reload(subscription.endpoint).catch(() => undefined);
      return true;
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "L'abonnement aux notifications a échoué.");
      return false;
    } finally {
      setBusy(false);
    }
  }, [enabled, publicKey, reload]);

  const disable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.getRegistration('/');
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        const response = await fetch('/api/push/subscription', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        if (!response.ok) throw new Error(await readError(response));
        await subscription.unsubscribe().catch(() => undefined);
      }
      setSubscribed(false);
      await reload().catch(() => undefined);
      return true;
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'La désinscription a échoué.');
      return false;
    } finally {
      setBusy(false);
    }
  }, [reload]);

  const removeDevice = useCallback(
    async (id: string) => {
      setError(null);
      const response = await fetch('/api/push/subscription', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!response.ok) {
        setError(await readError(response));
        return false;
      }
      const registration = typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration('/') : undefined;
      const subscription = await registration?.pushManager.getSubscription();
      const body = await reload(subscription?.endpoint).catch(() => null);
      if (body) setSubscribed(body.subscribed === true);
      return true;
    },
    [reload],
  );

  const sendTest = useCallback(async () => {
    setError(null);
    const response = await fetch('/api/push/test', { method: 'POST' });
    if (!response.ok) {
      setError(await readError(response));
      return null;
    }
    const body = (await response.json()) as { sent?: number };
    return { sent: body.sent ?? 0 };
  }, []);

  return { support, subscribed, busy, error, devices, enable, disable, removeDevice, sendTest };
}
