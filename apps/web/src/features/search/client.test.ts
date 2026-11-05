import { describe, expect, it, vi } from 'vitest';
import { createSearchClient, SearchError } from './client';
import type { SearchResults } from './contract';

const results = (query: string): SearchResults => ({ query, projects: [], sessions: [], actions: [] });

function fakeFetch() {
  return vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async (url, init) => {
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const q = new URL(url, 'http://localhost').searchParams.get('q') ?? '';
    if (q === 'panne') return new Response('{}', { status: 503 });
    return Response.json(results(q));
  });
}

describe('client de recherche', () => {
  it('fait une seule requête pour les trois groupes de la palette', async () => {
    const fetcher = fakeFetch();
    const client = createSearchClient(fetcher);
    const signal = new AbortController().signal;
    const all = await Promise.all([client('devis', signal), client('devis', signal), client('devis', signal)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/search?q=devis');
    expect(all.map((r) => r.query)).toEqual(['devis', 'devis', 'devis']);
  });

  it('annule la requête précédente quand la recherche change', async () => {
    const fetcher = fakeFetch();
    const client = createSearchClient(fetcher);
    const first = new AbortController();
    const pending = client('de', first.signal);
    first.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(client('dev', new AbortController().signal)).resolves.toMatchObject({ query: 'dev' });
    const firstInit = fetcher.mock.calls[0]?.[1];
    expect(firstInit?.signal?.aborted).toBe(true);
  });

  it('signale une recherche indisponible et ne garde pas un échec', async () => {
    const fetcher = fakeFetch();
    const client = createSearchClient(fetcher);
    await expect(client('panne', new AbortController().signal)).rejects.toBeInstanceOf(SearchError);
    await expect(client('panne', new AbortController().signal)).rejects.toBeInstanceOf(SearchError);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
