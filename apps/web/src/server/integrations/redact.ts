import 'server-only';

/**
 * Redaction of every text that may end up in a diagnostic, a log line, an error `raw` field or a
 * notification (research §7.1 « Never logged »):
 *  - exact-match replacement of the secrets currently known by the caller (and their base64 and
 *    `x-access-token:` forms);
 *  - patterns for GitHub tokens (incl. ~520-char stateless `ghs_` tokens with dots), fine-grained
 *    PATs, Coolify/Sanctum `<id>|<secret>` tokens, server (runner) `nrt_` tokens, Authorization
 *    headers and PEM private keys.
 */

const MASK = '[masqué]';

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
  /gh[opsur]_[A-Za-z0-9._-]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\b\d+\|[A-Za-z0-9]{20,}\b/g,
  /x-access-token:[^@\s"']+/g,
  /\bnrt_[A-Za-z0-9_-]{32,}/g, // runner (server) tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT (app JWT, OAuth)
];

const AUTH_HEADER = /(authorization["']?\s*[:=]\s*["']?)(basic|bearer|token)\s+[^\s"',}]+/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactSecrets(text: string, knownSecrets: ReadonlyArray<string | null | undefined> = []): string {
  if (!text) return text;
  let out = text;
  for (const secret of knownSecrets) {
    if (!secret || secret.length < 6) continue;
    const forms = new Set([
      secret,
      Buffer.from(secret, 'utf8').toString('base64'),
      Buffer.from(`x-access-token:${secret}`, 'utf8').toString('base64'),
    ]);
    for (const form of forms) out = out.replace(new RegExp(escapeRegExp(form), 'g'), MASK);
  }
  out = out.replace(AUTH_HEADER, (_match, prefix: string, scheme: string) => `${prefix}${scheme} ${MASK}`);
  for (const pattern of PATTERNS) out = out.replace(pattern, MASK);
  return out;
}

/** Redacts and truncates a provider message or a CLI output before storing/showing it. */
export function sanitizeText(
  text: unknown,
  max = 2_000,
  knownSecrets: ReadonlyArray<string | null | undefined> = [],
): string | undefined {
  if (text === null || text === undefined) return undefined;
  const value = typeof text === 'string' ? text : JSON.stringify(text);
  if (!value) return undefined;
  const redacted = redactSecrets(value, knownSecrets);
  return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
}

/** Message of a provider error body: `{ message }` (GitHub, Coolify) or plain text. */
export function providerMessageOf(body: unknown): string | undefined {
  if (typeof body === 'string') return sanitizeText(body.trim(), 300);
  if (body && typeof body === 'object' && 'message' in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string') return sanitizeText(message, 300);
  }
  return undefined;
}
