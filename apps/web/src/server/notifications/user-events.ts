import 'server-only';
import type { NotificationCreated } from '@nuera/shared/events';

/**
 * Per-account event channel of the web (docs/MULTICOMPTE.md §5: the global stream merges the
 * server's stream with this channel). In-process: one Node process serves the web. Events never
 * cross accounts: a listener only receives what is published for its own user id.
 *
 *   const unsubscribe = subscribeUserEvents(user.id, (event) => send(event));
 *   …
 *   unsubscribe();
 *
 * Published by the notification centre on creation (also when an unread notification with the same
 * dedup key is refreshed: same id, the bell replaces it) and when notifications are read.
 */

export type UserEvent =
  | { type: 'notification.created'; at: string; data: NotificationCreated }
  | {
      type: 'notification.read';
      at: string;
      /** `all`: every notification of the account is read now; otherwise these ids. */
      data: { all: true } | { all: false; ids: string[] };
    };

export type UserEventListener = (event: UserEvent) => void;

const globalForEvents = globalThis as unknown as { __nueraUserEvents?: Map<string, Set<UserEventListener>> };

function listeners(): Map<string, Set<UserEventListener>> {
  globalForEvents.__nueraUserEvents ??= new Map();
  return globalForEvents.__nueraUserEvents;
}

/** Delivers `event` to the listeners of `userId` only. A failing listener never stops the others. */
export function publishUserEvent(userId: string, event: UserEvent): void {
  if (!userId) return;
  const set = listeners().get(userId);
  if (!set) return;
  // Deleting from a Set while iterating it is safe (a listener may unsubscribe itself).
  for (const listener of set) {
    try {
      listener(event);
    } catch (error) {
      console.error('[user-events] écouteur en échec', error instanceof Error ? error.message : error);
    }
  }
}

/** Listens to the events of one account. Returns the unsubscribe function (idempotent). */
export function subscribeUserEvents(userId: string, listener: UserEventListener): () => void {
  if (!userId) throw new Error('Compte requis pour écouter ses événements.');
  const map = listeners();
  let set = map.get(userId);
  if (!set) {
    set = new Set();
    map.set(userId, set);
  }
  // Each subscription gets its own wrapper: a stale unsubscribe (called twice, or after the same
  // function subscribed again) never removes a newer subscription.
  const entry: UserEventListener = (event) => listener(event);
  set.add(entry);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const current = map.get(userId);
    if (!current) return;
    current.delete(entry);
    if (current.size === 0) map.delete(userId);
  };
}

/** Number of listeners of an account (diagnostics, tests). */
export function userEventListenerCount(userId: string): number {
  return listeners().get(userId)?.size ?? 0;
}
