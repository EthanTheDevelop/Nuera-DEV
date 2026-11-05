import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Runner → web callbacks (/api/internal/*) authenticate with `Authorization: Bearer RUNNER_TOKEN`.
 * Constant-time comparison on SHA-256 digests (equal lengths); a token shorter than 16 characters
 * is treated as not configured and refuses everything.
 */
export function isValidRunnerAuthorization(
  header: string | null | undefined,
  expected: string | undefined = process.env.RUNNER_TOKEN,
): boolean {
  if (!expected || expected.length < 16 || !header) return false;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  const provided = match?.[1] ?? '';
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b) && provided.length > 0;
}
