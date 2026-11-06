import { createHash, randomBytes } from 'node:crypto';

/**
 * Same formulas as `@nuera/shared/tokens` (this package stays free of workspace dependencies: the
 * `migrate` image only installs @nuera/db). Tokens are never stored nor logged, only their sha256.
 */

/** sha256 hex — what `environments.token_hash` and `invitations.token_hash` store. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Invitation / recovery link token: base64url of 32 random bytes (43 characters). */
export function generateLinkToken(): string {
  return randomBytes(32).toString('base64url');
}
