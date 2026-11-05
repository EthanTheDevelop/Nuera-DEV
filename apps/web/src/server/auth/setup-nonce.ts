import 'server-only';
import { randomBytes } from 'node:crypto';

/**
 * One-time, in-process proof that a Better Auth call comes from the owner setup flow
 * (token-gated server action), not from a client. Lets the setup sign the freshly created owner
 * in with a password while their 2FA is not enrolled yet — a case refused for every other caller.
 * The nonce never leaves the server process: it is passed as a header to `auth.api.*`.
 */

export const SETUP_NONCE_HEADER = 'x-nuera-setup-nonce';
const TTL_MS = 60_000;

const store = globalThis as unknown as { __nueraSetupNonces?: Map<string, number> };
const nonces = (store.__nueraSetupNonces ??= new Map<string, number>());

export function issueSetupNonce(): string {
  const now = Date.now();
  for (const [key, expiresAt] of nonces) if (expiresAt <= now) nonces.delete(key);
  const nonce = randomBytes(24).toString('base64url');
  nonces.set(nonce, now + TTL_MS);
  return nonce;
}

export function consumeSetupNonce(nonce: string | null | undefined): boolean {
  if (!nonce) return false;
  const expiresAt = nonces.get(nonce);
  nonces.delete(nonce);
  return expiresAt !== undefined && expiresAt > Date.now();
}
