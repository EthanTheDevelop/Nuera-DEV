import 'server-only';
import { randomBytes } from 'node:crypto';

/**
 * Enrolment grants (docs/MULTICOMPTE.md §6): the only exception to « no password sign-in without
 * 2FA ». A server-side flow that has just checked something stronger than the password alone — the
 * SETUP_TOKEN of /configuration, a single-use invitation link, a single-use recovery link — signs the
 * account in with its password so that it can enrol its second factor. The grant is:
 *
 *   - bound to ONE e-mail (normalised): a grant issued for an invitation never opens a session for
 *     another account, whatever e-mail the Better Auth call carries;
 *   - single use and short-lived (60 s);
 *   - in-process only: the nonce never leaves the web process (it travels as a header of an
 *     `auth.api.*` call, never to a browser). Like the rate limiter (security/rate-limit.ts), this
 *     assumes ONE web process: with several replicas the grant would have to move to the database.
 *
 *   const nonce = issueEnrolmentGrant({ email, purpose: 'invitation' });
 *   await auth.api.signInEmail({ body: { email, password }, headers: { [ENROLMENT_GRANT_HEADER]: nonce } });
 *   // auth.ts, databaseHooks.session.create.before: consumeEnrolmentGrant(nonce, user.email)
 */

export const ENROLMENT_GRANT_HEADER = 'x-nuera-enrolment-grant';
export const ENROLMENT_GRANT_TTL_MS = 60_000;

export type EnrolmentPurpose = 'setup' | 'invitation' | 'recovery';

interface Grant {
  email: string;
  purpose: EnrolmentPurpose;
  expiresAt: number;
}

const store = globalThis as unknown as { __nueraEnrolmentGrants?: Map<string, Grant> };
const grants = (store.__nueraEnrolmentGrants ??= new Map<string, Grant>());

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function prune(now: number): void {
  for (const [key, grant] of grants) if (grant.expiresAt <= now) grants.delete(key);
}

/** One-time grant for a password sign-in of `email` before its second factor is enrolled. */
export function issueEnrolmentGrant(input: { email: string; purpose: EnrolmentPurpose }, now = Date.now()): string {
  prune(now);
  const email = normaliseEmail(input.email);
  if (!email) throw new Error("Autorisation d'enrôlement sans e-mail.");
  const nonce = randomBytes(24).toString('base64url');
  grants.set(nonce, { email, purpose: input.purpose, expiresAt: now + ENROLMENT_GRANT_TTL_MS });
  return nonce;
}

/**
 * true only when `nonce` is a live grant issued for `email`. The grant is consumed whatever the
 * answer (a nonce presented with the wrong e-mail is burnt).
 */
export function consumeEnrolmentGrant(nonce: string | null | undefined, email: string | null | undefined, now = Date.now()): boolean {
  if (!nonce) return false;
  const grant = grants.get(nonce);
  grants.delete(nonce);
  if (!grant || grant.expiresAt <= now || !email) return false;
  return grant.email === normaliseEmail(email);
}

/** Tests only: forgets every grant. */
export function clearEnrolmentGrants(): void {
  grants.clear();
}
