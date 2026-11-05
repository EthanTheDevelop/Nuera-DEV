'use client';

import type { OperationDto } from '@nuera/shared/runner';
import { parseRunnerEvent } from '@nuera/shared/events';
import { useEffect, useState } from 'react';

export interface OperationStreamState {
  operation: OperationDto | null;
  /** Finalised journal lines (raw git / npm output, never rephrased). */
  log: string;
  /** Line updated in place (git progress, npm spinner). */
  liveLine: string | null;
  /** The relay says VPS-3 does not answer (the operation may still be running there). */
  unavailable: boolean;
  /** The stream could not be opened (session expired, unknown operation…). */
  failed: boolean;
}

const MAX_LOG = 64 * 1024;

/**
 * A2 live progress: `operation.progress` events of /api/stream/operations/<id> (first event = full
 * journal, then `logAppend` + `liveLine`). The browser's EventSource reconnects by itself and the
 * runner sends a fresh snapshot each time; the stream is closed once the operation has ended.
 */
export function useOperationStream(operationId: string | null): OperationStreamState {
  const [state, setState] = useState<OperationStreamState>({ operation: null, log: '', liveLine: null, unavailable: false, failed: false });

  useEffect(() => {
    if (!operationId) return;
    setState({ operation: null, log: '', liveLine: null, unavailable: false, failed: false });
    const source = new EventSource(`/api/stream/operations/${encodeURIComponent(operationId)}`);
    let errors = 0;
    source.onmessage = (message: MessageEvent<string>) => {
      const event = parseRunnerEvent(message.data);
      if (!event) return;
      errors = 0;
      if (event.type === 'stream.error') {
        setState((current) => ({ ...current, unavailable: true }));
        return;
      }
      if (event.type !== 'operation.progress') return;
      const { operation, log, logAppend, liveLine } = event.data;
      setState((current) => {
        let next = log !== undefined ? log : current.log;
        if (logAppend?.length) next = `${next}${next && !next.endsWith('\n') ? '\n' : ''}${logAppend.join('\n')}\n`;
        if (next.length > MAX_LOG) next = next.slice(next.length - MAX_LOG);
        return {
          operation,
          log: next,
          liveLine: liveLine !== undefined ? liveLine : current.liveLine,
          unavailable: false,
          failed: false,
        };
      });
      if (operation.status === 'succeeded' || operation.status === 'failed' || operation.status === 'cancelled') source.close();
    };
    source.onerror = () => {
      errors += 1;
      // EventSource retries on its own; after a closed stream (4xx) it stops: say so after a few tries.
      if (source.readyState === EventSource.CLOSED || errors >= 5) {
        setState((current) => (current.operation && current.operation.status !== 'running' ? current : { ...current, failed: true }));
      }
    };
    return () => source.close();
  }, [operationId]);

  return state;
}
