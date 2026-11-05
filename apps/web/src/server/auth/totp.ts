/**
 * TOTP helpers for the enrolment screen: base32 secret (manual entry) and otpauth:// URI (QR code).
 * Same format as Better Auth's `createOTP(secret).url(issuer, account)`: the raw secret string is
 * used as UTF-8 bytes and encoded in RFC 4648 base32 without padding.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const TOTP_ISSUER = 'Nuera Dev';
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD = 30;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function totpSecretToBase32(rawSecret: string): string {
  return base32Encode(new TextEncoder().encode(rawSecret));
}

export function buildOtpAuthUri(input: { rawSecret: string; account: string; issuer?: string }): string {
  const issuer = input.issuer ?? TOTP_ISSUER;
  const params = new URLSearchParams({
    secret: totpSecretToBase32(input.rawSecret),
    issuer,
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD),
  });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(input.account)}?${params.toString()}`;
}

/** « ABCD EFGH IJKL … » for manual entry. */
export function groupSecret(base32: string, size = 4): string {
  return base32.match(new RegExp(`.{1,${size}}`, 'g'))?.join(' ') ?? base32;
}

/** Keeps digits only (« 123 456 » → « 123456 »). */
export function normaliseTotpCode(input: string): string {
  return input.replace(/\D/g, '');
}

/** Backup codes look like « AbCde-12fGh »: trims spaces, keeps case (Better Auth compares exactly). */
export function normaliseBackupCode(input: string): string {
  return input.replace(/\s+/g, '');
}
