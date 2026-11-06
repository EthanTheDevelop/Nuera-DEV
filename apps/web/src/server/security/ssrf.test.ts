import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertAllowedDestination, checkDestination, createGuardedFetch, invalidateSsrfCache, isReservedAddress, SsrfRefusedError } from './ssrf';

/*
 * SSRF guard of the addresses typed by users (custom MCP servers, OAuth metadata, Coolify):
 * internal destinations refused unless NUERA_PRIVATE_HOSTS lists them, every resolved address
 * checked, the connection pinned to the checked address, redirects never followed.
 */

const lookups: Record<string, string[]> = {
  'public.example': ['93.184.216.34'],
  'mixed.example': ['93.184.216.34', '127.0.0.1'],
  'mapped.example': ['::ffff:127.0.0.1'],
  'runner.internal': ['10.9.8.7'],
  'pinned.test': ['127.0.0.1'],
  'metadata.example': ['169.254.169.254'],
};
const lookupImpl = async (host: string) => {
  const answers = lookups[host];
  if (!answers) throw new Error('ENOTFOUND');
  return answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

let server: Server;
let port = 0;
const seen: Array<{ host: string | undefined; path: string | undefined }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ host: req.headers.host, path: req.url });
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  delete process.env.NUERA_PRIVATE_HOSTS;
  process.env.RUNNER_URL = 'http://runner.internal:4100';
  process.env.DATABASE_URL = 'postgres://nuera:nuera@db.internal:5432/nuera';
  invalidateSsrfCache();
  seen.length = 0;
});

describe('SSRF guard', () => {
  it('classifies loopback, link-local, unspecified, multicast and mapped addresses', () => {
    for (const address of ['127.0.0.1', '127.1.2.3', '0.0.0.0', '169.254.169.254', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '[::1]']) {
      expect(isReservedAddress(address), address).toBe(true);
    }
    for (const address of ['93.184.216.34', '10.0.0.5', '192.168.1.10', '2001:4860:4860::8888']) {
      expect(isReservedAddress(address), address).toBe(false);
    }
  });

  it('refuses internal destinations, by name and by every resolved address', async () => {
    const refused = ['http://127.0.0.1:8080/mcp', 'https://mixed.example/mcp', 'https://mapped.example', 'http://169.254.169.254/latest', 'https://metadata.example', 'https://[::1]/mcp', 'file:///etc/passwd'];
    for (const url of refused) {
      expect(await checkDestination(url, { lookupImpl }).catch((cause: unknown) => cause), url).toBeInstanceOf(SsrfRefusedError);
    }
    // Unknown name: not an SSRF refusal (the connection test reports it).
    const unknown = await checkDestination('http://localhost.invalid', { lookupImpl }).catch((cause: unknown) => cause);
    expect(unknown).toBeInstanceOf(Error);
    expect(unknown).not.toBeInstanceOf(SsrfRefusedError);
    // The hosts of the registered servers and of the database.
    await expect(checkDestination('https://runner.internal/mcp', { lookupImpl })).rejects.toBeInstanceOf(SsrfRefusedError);
    await expect(checkDestination('https://10.9.8.7/', { lookupImpl })).rejects.toBeInstanceOf(SsrfRefusedError);
    await expect(checkDestination('https://db.internal/', { lookupImpl: async (host) => (host === 'db.internal' ? [{ address: '10.1.1.1', family: 4 }] : lookupImpl(host)) })).rejects.toBeInstanceOf(
      SsrfRefusedError,
    );
    // A public address is accepted.
    await expect(checkDestination('https://public.example/mcp', { lookupImpl })).resolves.toMatchObject({ address: '93.184.216.34', allowListed: false });
  });

  it('lets NUERA_PRIVATE_HOSTS allow a private host (by name or by address)', async () => {
    await expect(checkDestination('http://127.0.0.1:8080/mcp', { lookupImpl, env: { NUERA_PRIVATE_HOSTS: '127.0.0.1' } })).resolves.toMatchObject({ allowListed: true });
    await expect(checkDestination('https://runner.internal/', { lookupImpl, env: { NUERA_PRIVATE_HOSTS: 'runner.internal' } })).resolves.toMatchObject({ allowListed: true });
    await expect(assertAllowedDestination('http://127.0.0.1:8080/mcp', { lookupImpl })).rejects.toMatchObject({
      code: 'VALIDATION',
      message: 'Adresse refusée : 127.0.0.1 désigne une machine interne (boucle locale, lien local, serveur ou base de données de Nuera Dev).',
      detail: "Un administrateur peut l'autoriser avec la variable NUERA_PRIVATE_HOSTS.",
    });
    // An unknown name is left to the connection test.
    await expect(assertAllowedDestination('https://unknown.example/', { lookupImpl })).resolves.toBeUndefined();
  });

  it('connects to the checked address only (pinned) and never follows a redirect', async () => {
    const guarded = createGuardedFetch({ lookupImpl, env: { NUERA_PRIVATE_HOSTS: 'pinned.test' } });
    // `pinned.test` does not exist in DNS: only the pinned address can reach the local server.
    const response = await guarded(`http://pinned.test:${port}/hello`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(seen.at(-1)).toEqual({ host: `pinned.test:${port}`, path: '/hello' });
    const redirect = await guarded(`http://pinned.test:${port}/redirect`);
    expect(redirect.status).toBe(302);
    expect(seen.map((item) => item.path)).toEqual(['/hello', '/redirect']);
    // Without the allow-list, the same request never leaves.
    const refused = createGuardedFetch({ lookupImpl, env: {} });
    await expect(refused(`http://pinned.test:${port}/hello`)).rejects.toBeInstanceOf(SsrfRefusedError);
    expect(seen).toHaveLength(2);
  });

  it('honours an abort signal', async () => {
    const guarded = createGuardedFetch({ lookupImpl, env: { NUERA_PRIVATE_HOSTS: 'pinned.test' } });
    const controller = new AbortController();
    controller.abort(Object.assign(new Error('stop'), { name: 'AbortError' }));
    await expect(guarded(`http://pinned.test:${port}/hello`, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
