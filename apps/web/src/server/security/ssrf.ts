import 'server-only';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import { environments } from '@nuera/db/schema';
import { isNotNull } from 'drizzle-orm';
import { AppError } from '@/server/errors';

/**
 * Guard of the outgoing requests whose address comes from a user (custom MCP servers, OAuth
 * metadata, Coolify): the web container holds the encryption key, the auth secret and every server
 * token, and sits on the internal network (runners, PostgreSQL). docs/MULTICOMPTE.md §7.
 *
 * Refused, unless the host (or one of its addresses) is listed in NUERA_PRIVATE_HOSTS
 * (comma-separated host names or IP addresses):
 *  - loopback (127.0.0.0/8, ::1), link-local (169.254.0.0/16, fe80::/10), unspecified (0.0.0.0/8, ::),
 *    multicast and broadcast;
 *  - the hosts of the registered servers (RUNNER_URL, `environments.url`) and of the database
 *    (DATABASE_URL), by name and by address.
 * Every address the name resolves to must pass; the request is then sent to that address only
 * (pinned: a second DNS answer cannot redirect it) and redirects are never followed.
 *
 *   const response = await guardedFetch(url, { method: 'POST', headers, body, signal, redirect: 'manual' });
 *   await assertAllowedDestination(url);   // form validation: AppError VALIDATION with a French message
 */

export class SsrfRefusedError extends Error {
  readonly host: string;

  constructor(host: string) {
    super(ssrfRefusalMessage(host));
    this.name = 'SsrfRefusedError';
    this.host = host;
  }
}

export function ssrfRefusalMessage(host: string): string {
  return `Adresse refusée : ${host} désigne une machine interne (boucle locale, lien local, serveur ou base de données de Nuera Dev).`;
}

export const SSRF_REFUSAL_DETAIL = "Un administrateur peut l'autoriser avec la variable NUERA_PRIVATE_HOSTS.";

const blocked = new BlockList();
blocked.addSubnet('0.0.0.0', 8, 'ipv4');
blocked.addSubnet('127.0.0.0', 8, 'ipv4');
blocked.addSubnet('169.254.0.0', 16, 'ipv4');
blocked.addSubnet('224.0.0.0', 4, 'ipv4');
blocked.addAddress('255.255.255.255', 'ipv4');
blocked.addAddress('::', 'ipv6');
blocked.addAddress('::1', 'ipv6');
blocked.addSubnet('fe80::', 10, 'ipv6');
blocked.addSubnet('ff00::', 8, 'ipv6');

/** `::ffff:127.0.0.1` → `127.0.0.1`; brackets removed; lower case. */
export function normalizeAddress(value: string): string {
  const bare = value.trim().replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
  return mapped ? mapped[1]! : bare;
}

/** True for loopback, link-local, unspecified, multicast and broadcast addresses. */
export function isReservedAddress(address: string): boolean {
  const value = normalizeAddress(address);
  const family = isIP(value);
  if (family === 4) return blocked.check(value, 'ipv4');
  if (family === 6) return blocked.check(value, 'ipv6');
  return true;
}

function allowList(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set(
    (env.NUERA_PRIVATE_HOSTS ?? '')
      .split(',')
      .map((item) => normalizeAddress(item))
      .filter(Boolean),
  );
}

type LookupImpl = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: LookupImpl = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const host = new URL(value).hostname;
    return host ? normalizeAddress(host) : null;
  } catch {
    return null;
  }
}

interface InternalHosts {
  names: Set<string>;
  addresses: Set<string>;
  at: number;
}

const INTERNAL_TTL_MS = 60_000;
const holder = globalThis as unknown as { __nueraSsrfInternal?: InternalHosts | null };

/** Forgets the hosts of the servers and of the database (a server was registered or changed). */
export function invalidateSsrfCache(): void {
  holder.__nueraSsrfInternal = null;
}

async function internalHosts(lookupImpl: LookupImpl): Promise<InternalHosts> {
  const cached = holder.__nueraSsrfInternal;
  if (cached && Date.now() - cached.at < INTERNAL_TTL_MS) return cached;
  const names = new Set<string>();
  for (const value of [process.env.DATABASE_URL, process.env.RUNNER_URL, process.env.NUERA_WEB_INTERNAL_URL]) {
    const host = hostOf(value);
    if (host) names.add(host);
  }
  try {
    const { db } = await import('@/server/db');
    const rows = await db.select({ url: environments.url }).from(environments).where(isNotNull(environments.url));
    for (const row of rows) {
      const host = hostOf(row.url);
      if (host) names.add(host);
    }
  } catch {
    // Database unreachable: the variables above still protect the default server and the database.
  }
  const addresses = new Set<string>();
  await Promise.all(
    [...names].map(async (name) => {
      if (isIP(name)) {
        addresses.add(name);
        return;
      }
      try {
        for (const item of await lookupImpl(name)) addresses.add(normalizeAddress(item.address));
      } catch {
        // Unknown name: compared by name only.
      }
    }),
  );
  const value = { names, addresses, at: Date.now() };
  holder.__nueraSsrfInternal = value;
  return value;
}

export interface CheckedDestination {
  url: URL;
  /** Address the request must be sent to (pinned). */
  address: string;
  family: 4 | 6;
  /** Listed in NUERA_PRIVATE_HOSTS. */
  allowListed: boolean;
}

export interface DestinationOptions {
  lookupImpl?: LookupImpl;
  env?: Record<string, string | undefined>;
}

/** Resolves and checks a destination; throws SsrfRefusedError when it is refused. */
export async function checkDestination(input: string | URL, options: DestinationOptions = {}): Promise<CheckedDestination> {
  const url = new URL(String(input));
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new SsrfRefusedError(url.host || url.protocol);
  const host = normalizeAddress(url.hostname);
  if (!host) throw new SsrfRefusedError(url.host);
  const lookupImpl = options.lookupImpl ?? defaultLookup;
  let resolved: Array<{ address: string; family: 4 | 6 }>;
  if (isIP(host)) {
    resolved = [{ address: host, family: isIP(host) as 4 | 6 }];
  } else {
    let answers: Array<{ address: string; family: number }>;
    try {
      answers = await lookupImpl(host);
    } catch {
      throw Object.assign(new Error(`Nom d'hôte introuvable : ${host}.`), { name: 'DnsLookupError' });
    }
    resolved = answers
      .map((item) => ({ address: normalizeAddress(item.address), family: (isIP(normalizeAddress(item.address)) || 4) as 4 | 6 }))
      .filter((item) => isIP(item.address));
    if (resolved.length === 0) throw Object.assign(new Error(`Nom d'hôte introuvable : ${host}.`), { name: 'DnsLookupError' });
  }
  const allowed = allowList(options.env);
  const allowListed = allowed.has(host) || resolved.some((item) => allowed.has(item.address));
  if (!allowListed) {
    if (resolved.some((item) => isReservedAddress(item.address))) throw new SsrfRefusedError(host);
    const internal = await internalHosts(lookupImpl);
    if (internal.names.has(host) || resolved.some((item) => internal.addresses.has(item.address))) throw new SsrfRefusedError(host);
  }
  return { url, address: resolved[0]!.address, family: resolved[0]!.family, allowListed };
}

/** Form validation of an address typed by a user: AppError VALIDATION when it is refused. */
export async function assertAllowedDestination(input: string, options: DestinationOptions = {}): Promise<void> {
  try {
    await checkDestination(input, options);
  } catch (error) {
    if (error instanceof SsrfRefusedError) {
      throw new AppError('VALIDATION', error.message, { detail: SSRF_REFUSAL_DETAIL });
    }
    // Unknown host or network error: the connection test that follows reports it.
  }
}

function headerObject(init: HeadersInit | undefined): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  new Headers(init ?? {}).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function bodyOf(body: BodyInit | null | undefined): string | Uint8Array | null {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof URLSearchParams) return body.toString();
  throw new TypeError('Corps de requête non pris en charge par la garde des requêtes sortantes.');
}

function toResponse(res: IncomingMessage, method: string): Response {
  const headers = new Headers();
  const raw = res.rawHeaders;
  for (let index = 0; index + 1 < raw.length; index += 2) headers.append(raw[index]!, raw[index + 1]!);
  const status = res.statusCode ?? 502;
  const empty = method === 'HEAD' || status === 204 || status === 205 || status === 304;
  if (empty) {
    res.resume();
    return new Response(null, { status, statusText: res.statusMessage ?? '', headers });
  }
  const body = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, { status: Math.min(Math.max(status, 200), 599), statusText: res.statusMessage ?? '', headers });
}

/** Sends the request to the checked address only (no second DNS lookup), never following a redirect. */
function pinnedRequest(destination: CheckedDestination, init: RequestInit): Promise<Response> {
  const { url, address, family } = destination;
  const method = (init.method ?? 'GET').toUpperCase();
  const body = bodyOf(init.body);
  const signal = init.signal ?? null;
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : Object.assign(new Error('Requête annulée.'), { name: 'AbortError' }));
      return;
    }
    const requestImpl = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const hostname = normalizeAddress(url.hostname);
    const headers = headerObject(init.headers);
    if (body !== null && headers['content-length'] === undefined) headers['content-length'] = String(Buffer.byteLength(body));
    const req = requestImpl(url, {
      method,
      headers,
      // Pinned: the connection goes to the address that was checked, whatever DNS says now.
      lookup: ((_host: string, options: { all?: boolean } | undefined, callback: (...args: unknown[]) => void) => {
        if (options?.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      }) as never,
      ...(url.protocol === 'https:' && !isIP(hostname) ? { servername: hostname } : {}),
    });
    const onAbort = () => {
      const reason = signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('Requête annulée.'), { name: 'AbortError' });
      req.destroy(reason);
      reject(reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('response', (res) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal) {
        const stop = () => res.destroy(signal.reason instanceof Error ? signal.reason : undefined);
        if (signal.aborted) stop();
        else signal.addEventListener('abort', stop, { once: true });
        res.once('close', () => signal.removeEventListener('abort', stop));
      }
      try {
        resolve(toResponse(res, method));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(Object.assign(new TypeError('fetch failed'), { cause: error }));
    });
    if (body !== null) req.write(body);
    req.end();
  });
}

export interface GuardedFetchOptions extends DestinationOptions {
  /**
   * Transport used after the check (tests inject one). Without it, the request is sent to the
   * checked address (pinned) through node:http / node:https.
   */
  fetchImpl?: typeof fetch;
}

/** `fetch` for addresses chosen by a user: checked, pinned, redirects returned as is. */
export function createGuardedFetch(options: GuardedFetchOptions = {}): typeof fetch {
  const guarded = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const target = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const destination = await checkDestination(target, options);
    const request = { ...init, redirect: 'manual' as const };
    if (options.fetchImpl) return options.fetchImpl(destination.url, request);
    return pinnedRequest(destination, request);
  };
  return guarded as typeof fetch;
}

/** Default guarded fetch (real DNS, pinned connection). */
export const guardedFetch: typeof fetch = createGuardedFetch();
