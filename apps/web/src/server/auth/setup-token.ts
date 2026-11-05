import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * SETUP_TOKEN gate of the owner setup (/configuration).
 * Comparison in constant time on SHA-256 digests (equal lengths whatever the input).
 * A token shorter than 16 characters is considered not configured: it would be guessable.
 */

export const SETUP_TOKEN_MIN_LENGTH = 16;

export type SetupTokenCheck = 'ok' | 'invalid' | 'not_configured';

export function isSetupTokenConfigured(expected: string | undefined = process.env.SETUP_TOKEN): boolean {
  return typeof expected === 'string' && expected.trim().length >= SETUP_TOKEN_MIN_LENGTH;
}

export function checkSetupToken(
  provided: string | null | undefined,
  expected: string | undefined = process.env.SETUP_TOKEN,
): SetupTokenCheck {
  if (!isSetupTokenConfigured(expected)) return 'not_configured';
  const candidate = typeof provided === 'string' ? provided.trim() : '';
  const a = createHash('sha256').update(candidate, 'utf8').digest();
  const b = createHash('sha256').update(expected!.trim(), 'utf8').digest();
  // Always run the comparison, even for an empty candidate.
  const same = timingSafeEqual(a, b);
  return same && candidate.length > 0 ? 'ok' : 'invalid';
}
