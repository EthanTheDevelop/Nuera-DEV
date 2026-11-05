import type { SearchResults } from './contract';

export class SearchError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'SearchError';
    this.status = status;
  }
}

export type SearchFetch = (url: string, init: RequestInit) => Promise<Response>;

/** GET /api/search?q= (owner session cookie). */
export async function fetchSearch(query: string, signal: AbortSignal, fetcher: SearchFetch = fetch): Promise<SearchResults> {
  const response = await fetcher(`/api/search?q=${encodeURIComponent(query)}`, {
    signal,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new SearchError(response.status, 'Recherche indisponible.');
  return (await response.json()) as SearchResults;
}

export type SearchClient = (query: string, signal: AbortSignal) => Promise<SearchResults>;

const abortError = () => new DOMException('Recherche annulée.', 'AbortError');

/**
 * One request per query shared by the palette's groups (projects, sessions, actions), reused for a few
 * seconds only. A new query aborts the previous request; a caller's own signal only detaches that caller.
 */
export function createSearchClient(fetcher: SearchFetch = (url, init) => fetch(url, init), reuseMs = 5_000): SearchClient {
  let current: { query: string; controller: AbortController; promise: Promise<SearchResults>; at: number } | null = null;
  return (query, signal) => {
    if (signal.aborted) return Promise.reject(abortError());
    if (!current || current.query !== query || Date.now() - current.at > reuseMs) {
      current?.controller.abort();
      const controller = new AbortController();
      const promise = fetchSearch(query, controller.signal, fetcher);
      // A failed request is not reused for the next caller.
      const entry = { query, controller, promise, at: Date.now() };
      promise.catch(() => {
        if (current === entry) current = null;
      });
      current = entry;
    }
    const { promise } = current;
    return new Promise<SearchResults>((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      promise
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', onAbort));
    });
  };
}
