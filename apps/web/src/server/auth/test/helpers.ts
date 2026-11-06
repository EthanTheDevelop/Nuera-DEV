/**
 * Test-only helpers of the authentication suites (real Better Auth, real PostgreSQL): cookie jar of
 * the server-side calls, TOTP codes computed from the manual key, request headers of one device.
 */
import { generate } from 'otplib';
import postgres from 'postgres';

export const SAFARI_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';

/** Headers of a request from one device (cookie jar, Origin of the app, extra headers). */
export function requestFrom(appUrl: string, cookie?: string, extra: Record<string, string> = {}): Headers {
  const headers = new Headers({ 'user-agent': SAFARI_MAC, origin: appUrl, ...extra });
  if (cookie) headers.set('cookie', cookie);
  return headers;
}

/** Cookie jar update from Set-Cookie lines (an empty value or Max-Age=0 removes the cookie). */
export function mergeCookies(setCookies: string[], existing = ''): string {
  const jar = new Map<string, string>();
  for (const part of existing.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name) jar.set(name, rest.join('='));
  }
  for (const line of setCookies) {
    const [pair = '', ...attributes] = line.split(';');
    const [name = '', ...rest] = pair.trim().split('=');
    if (!name) continue;
    const value = rest.join('=');
    if (value === '' || attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute))) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

export async function totp(manualKey: string): Promise<string> {
  return generate({ secret: manualKey.replace(/\s+/g, '') });
}

/** The `next/headers` cookie store read from a Cookie header (what the code under test sees). */
export function cookieStore(headers: Headers) {
  const all = (headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf('=');
      return { name: index < 0 ? part : part.slice(0, index), value: index < 0 ? '' : part.slice(index + 1) };
    });
  return {
    getAll: () => all,
    get: (name: string) => all.find((cookie) => cookie.name === name),
    has: (name: string) => all.some((cookie) => cookie.name === name),
    set: () => undefined,
    delete: () => undefined,
  };
}

/** false (with a warning) when the local cluster does not answer; NUERA_REQUIRE_PG=1 makes it fatal. */
export async function postgresAvailable(adminUrl: string, suite: string): Promise<boolean> {
  const sql = postgres(adminUrl, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    await sql`select 1`;
    return true;
  } catch (error) {
    if (process.env.NUERA_REQUIRE_PG === '1') throw error;
    console.warn(`[${suite}] PostgreSQL injoignable (${new URL(adminUrl).host}) : tests ignorés. Lancez \`pnpm db:local\`.`);
    return false;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

/** Drops (and recreates unless `drop`) a test database of this lot. */
export async function recreateDatabase(adminUrl: string, name: string, drop = false): Promise<void> {
  if (!/^nuera_(w4|x3)_[a-z0-9_]{1,40}$/.test(name)) throw new Error('nom de base de test invalide');
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    if (!drop) await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}
