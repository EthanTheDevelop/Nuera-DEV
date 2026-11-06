'use client';

import { parseRunnerEvent, type RunnerEvent } from '@nuera/shared/events';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

export type SessionStreamState = 'connecting' | 'open' | 'reconnecting';

/** Failed (re)connections in a row, browser online, before the stream URL is probed. */
export const SESSION_STREAM_PROBE_AFTER = 3;

/**
 * What a probe of the stream URL proves (pure). 401: the web session is over → refresh, the
 * layout redirects to /connexion. 403 / 404: the session is no longer reachable by this account
 * (moved to another space, archived, account disabled) → stop retrying and refresh, the page then
 * renders its 404. Anything else (200 while the runner is down, 5xx, no network): keep retrying.
 */
export function sessionStreamProbeVerdict(status: number | null): 'refresh' | 'retry' {
  return status === 401 || status === 403 || status === 404 ? 'refresh' : 'retry';
}

/**
 * Conversation stream of one session (`/api/stream/sessions/<id>`, relayed from the runner):
 * `session.status`, `session.event`, `session.permission`, `stream.reset`, heartbeats. The browser's
 * own reconnection sends `Last-Event-ID`; a stream recreated by hand passes `?lastEventId=` (CLAUDE.md
 * lesson) and the runner replays or answers `stream.reset`. Back-off 1 → 30 s, 10 s while the runner
 * is unreachable. After {@link SESSION_STREAM_PROBE_AFTER} failures in a row while online, the URL
 * is probed once per failure streak: a permanent refusal stops the retries and refreshes the page
 * (never a blind refresh: without a network Next falls back to a full navigation, CLAUDE.md lesson).
 */
export function useSessionStream(sessionId: string, onEvent: (event: RunnerEvent) => void, enabled = true): SessionStreamState {
  const [state, setState] = useState<SessionStreamState>('connecting');
  const router = useRouter();
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (!enabled) return;
    // Mutable connection state of this effect run (one object: closures read the latest values).
    const conn: {
      source: EventSource | null;
      timer: ReturnType<typeof setTimeout> | null;
      attempt: number;
      lastEventId: string | null;
      disposed: boolean;
      probed: boolean;
    } = { source: null, timer: null, attempt: 0, lastEventId: null, disposed: false, probed: false };
    const base = `/api/stream/sessions/${encodeURIComponent(sessionId)}`;

    const stop = () => {
      conn.disposed = true;
      if (conn.timer) clearTimeout(conn.timer);
      conn.source?.close();
    };

    const schedule = (delayMs: number) => {
      if (conn.disposed) return;
      if (conn.timer) clearTimeout(conn.timer);
      setState('reconnecting');
      conn.timer = setTimeout(connect, delayMs);
    };

    async function probe() {
      conn.probed = true;
      const controller = new AbortController();
      let status: number | null = null;
      try {
        status = (await fetch(base, { cache: 'no-store', headers: { accept: 'text/event-stream' }, signal: controller.signal })).status;
      } catch {
        // No answer: the back-off goes on.
      } finally {
        controller.abort();
      }
      if (conn.disposed || sessionStreamProbeVerdict(status) !== 'refresh') return;
      stop();
      router.refresh();
    }

    function connect() {
      if (conn.disposed) return;
      conn.source?.close();
      const url = conn.lastEventId ? `${base}?lastEventId=${encodeURIComponent(conn.lastEventId)}` : base;
      const es = new EventSource(url, { withCredentials: true });
      conn.source = es;
      es.addEventListener('open', () => {
        conn.attempt = 0;
        conn.probed = false;
        setState('open');
      });
      es.addEventListener('message', (message) => {
        if (message.lastEventId) conn.lastEventId = message.lastEventId;
        const event = parseRunnerEvent(message.data);
        if (!event) return;
        if (event.type === 'stream.error') {
          // Runner unreachable (T5, shown by the shell): retry calmly.
          es.close();
          schedule(10_000);
        }
        handler.current(event);
      });
      es.addEventListener('error', () => {
        if (es.readyState === EventSource.CLOSED) {
          conn.attempt += 1;
          const delay = Math.min(30_000, 1_000 * 2 ** Math.min(conn.attempt - 1, 5));
          schedule(Math.round(delay * (0.8 + Math.random() * 0.4)));
          if (!conn.probed && conn.attempt >= SESSION_STREAM_PROBE_AFTER && navigator.onLine !== false) void probe();
        } else {
          setState('reconnecting');
        }
      });
    }

    connect();
    const onOnline = () => schedule(0);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('online', onOnline);
      stop();
    };
  }, [sessionId, enabled, router]);

  return state;
}
