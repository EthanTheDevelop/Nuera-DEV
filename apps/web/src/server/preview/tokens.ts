import 'server-only';
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { PREVIEW_COOKIE_TTL_MS, PREVIEW_HANDOFF_TTL_MS } from '@/lib/preview';

/**
 * « Aperçu » credentials, both HMAC-SHA256 signed with keys derived (HKDF) from BETTER_AUTH_SECRET —
 * one key per purpose, so a handoff token is never a valid cookie and conversely:
 *
 *  - handoff token (`?jeton=` of `https://PREVIEW_HOST/__nuera/entree`): 60 s, single use (its nonce
 *    is remembered by this process until it expires), carries the account, its web access (Better
 *    Auth session row), the run and the first path to open;
 *  - cookie `nuera_apercu` (preview host only): 12 h, carries the account, its web access and the run.
 *
 * Format: `base64url(JSON claims).base64url(HMAC)`. Neither is ever accepted on the application host.
 * Changing BETTER_AUTH_SECRET invalidates them (like every web session).
 */

export interface PreviewGrant {
  userId: string;
  /** Better Auth session row of the access that asked for the preview (signing out closes it). */
  authSessionId: string;
  runId: string;
}

export interface HandoffClaims extends PreviewGrant {
  /** First path to open (`/`, `/devis?id=3`). */
  path: string;
  expiresAt: number;
}

export interface CookieClaims extends PreviewGrant {
  expiresAt: number;
}

type Purpose = 'handoff' | 'cookie';

const keys = new Map<string, Buffer>();

function keyFor(purpose: Purpose): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error("BETTER_AUTH_SECRET manque : l'aperçu ne peut pas signer ses accès.");
  const id = `${purpose}:${secret}`;
  let key = keys.get(id);
  if (!key) {
    key = Buffer.from(hkdfSync('sha256', secret, 'nuera-dev:apercu', `nuera-dev:apercu:${purpose}`, 32));
    keys.clear();
    keys.set(id, key);
  }
  return key;
}

function sign(purpose: Purpose, payload: string): string {
  return createHmac('sha256', keyFor(purpose)).update(payload).digest('base64url');
}

function encode(purpose: Purpose, claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payload}.${sign(purpose, payload)}`;
}

function decode(purpose: Purpose, token: string | null | undefined): Record<string, unknown> | null {
  if (!token || token.length > 2048) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(purpose, payload), 'base64url');
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 && value.length <= 2048 ? value : null);

function grantOf(claims: Record<string, unknown>): PreviewGrant | null {
  const userId = str(claims.u);
  const authSessionId = str(claims.s);
  const runId = str(claims.r);
  return userId && authSessionId && runId ? { userId, authSessionId, runId } : null;
}

// --- Single use of handoff tokens (one web process: docs/SECURITY.md §11) ----------------------

const holder = globalThis as unknown as { __nueraPreviewNonces?: Map<string, number> };

function usedNonces(): Map<string, number> {
  holder.__nueraPreviewNonces ??= new Map();
  return holder.__nueraPreviewNonces;
}

function prune(now: number): void {
  for (const [nonce, expiresAt] of usedNonces()) if (expiresAt <= now) usedNonces().delete(nonce);
}

/** Forgets the used nonces (tests). */
export function resetPreviewNonces(): void {
  usedNonces().clear();
}

// --- Public API ----------------------------------------------------------------------------------

export function issueHandoffToken(grant: PreviewGrant & { path: string }, now = Date.now()): { token: string; expiresAt: number } {
  const expiresAt = now + PREVIEW_HANDOFF_TTL_MS;
  const token = encode('handoff', {
    k: 'handoff',
    u: grant.userId,
    s: grant.authSessionId,
    r: grant.runId,
    p: grant.path,
    exp: expiresAt,
    n: randomBytes(16).toString('base64url'),
  });
  return { token, expiresAt };
}

/** Valid, unexpired, never used before → its claims (and it is spent); anything else → null. */
export function consumeHandoffToken(token: string | null | undefined, now = Date.now()): HandoffClaims | null {
  const claims = decode('handoff', token);
  if (!claims || claims.k !== 'handoff') return null;
  const grant = grantOf(claims);
  const expiresAt = typeof claims.exp === 'number' ? claims.exp : 0;
  const nonce = str(claims.n);
  const path = str(claims.p) ?? '/';
  if (!grant || !nonce || expiresAt <= now || expiresAt > now + PREVIEW_HANDOFF_TTL_MS) return null;
  prune(now);
  if (usedNonces().has(nonce)) return null;
  usedNonces().set(nonce, expiresAt);
  return { ...grant, path: path.startsWith('/') && !path.startsWith('//') ? path : '/', expiresAt };
}

export function issuePreviewCookie(grant: PreviewGrant, now = Date.now()): { value: string; expiresAt: number; maxAgeSeconds: number } {
  const expiresAt = now + PREVIEW_COOKIE_TTL_MS;
  return {
    value: encode('cookie', { k: 'cookie', u: grant.userId, s: grant.authSessionId, r: grant.runId, exp: expiresAt }),
    expiresAt,
    maxAgeSeconds: Math.floor(PREVIEW_COOKIE_TTL_MS / 1000),
  };
}

export function readPreviewCookie(value: string | null | undefined, now = Date.now()): CookieClaims | null {
  const claims = decode('cookie', value);
  if (!claims || claims.k !== 'cookie') return null;
  const grant = grantOf(claims);
  const expiresAt = typeof claims.exp === 'number' ? claims.exp : 0;
  if (!grant || expiresAt <= now || expiresAt > now + PREVIEW_COOKIE_TTL_MS) return null;
  return { ...grant, expiresAt };
}

/** `Set-Cookie` of the preview cookie (host-only: no Domain; HttpOnly; SameSite from the config). */
export function previewCookieHeader(name: string, value: string, options: { maxAgeSeconds: number; secure: boolean; sameSite: 'lax' | 'none' }): string {
  return [
    `${name}=${value}`,
    'Path=/',
    `Max-Age=${options.maxAgeSeconds}`,
    'HttpOnly',
    options.sameSite === 'none' ? 'SameSite=None' : 'SameSite=Lax',
    ...(options.secure ? ['Secure'] : []),
  ].join('; ');
}
