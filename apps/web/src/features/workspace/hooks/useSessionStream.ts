'use client';

import { parseRunnerEvent, type RunnerEvent } from '@nuera/shared/events';
import { useEffect, useRef, useState } from 'react';

export type SessionStreamState = 'connecting' | 'open' | 'reconnecting';

/**
 * Conversation stream of one session (`/api/stream/sessions/<id>`, relayed from the runner):
 * `session.status`, `session.event`, `session.permission`, `stream.reset`, heartbeats. The browser's
 * own reconnection sends `Last-Event-ID`; a stream recreated by hand passes `?lastEventId=` (CLAUDE.md
 * lesson) and the runner replays or answers `stream.reset`. Back-off 1 → 30 s, 10 s while the runner
 * is unreachable.
 */
export function useSessionStream(sessionId: string, onEvent: (event: RunnerEvent) => void, enabled = true): SessionStreamState {
  const [state, setState] = useState<SessionStreamState>('connecting');
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
    } = { source: null, timer: null, attempt: 0, lastEventId: null, disposed: false };

    const schedule = (delayMs: number) => {
      if (conn.disposed) return;
      if (conn.timer) clearTimeout(conn.timer);
      setState('reconnecting');
      conn.timer = setTimeout(connect, delayMs);
    };

    function connect() {
      if (conn.disposed) return;
      conn.source?.close();
      const base = `/api/stream/sessions/${encodeURIComponent(sessionId)}`;
      const url = conn.lastEventId ? `${base}?lastEventId=${encodeURIComponent(conn.lastEventId)}` : base;
      const es = new EventSource(url, { withCredentials: true });
      conn.source = es;
      es.addEventListener('open', () => {
        conn.attempt = 0;
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
        } else {
          setState('reconnecting');
        }
      });
    }

    connect();
    const onOnline = () => schedule(0);
    window.addEventListener('online', onOnline);
    return () => {
      conn.disposed = true;
      window.removeEventListener('online', onOnline);
      if (conn.timer) clearTimeout(conn.timer);
      conn.source?.close();
    };
  }, [sessionId, enabled]);

  return state;
}
