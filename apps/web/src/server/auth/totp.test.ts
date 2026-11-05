import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { base32Encode, buildOtpAuthUri, groupSecret, normaliseBackupCode, normaliseTotpCode, totpSecretToBase32 } from './totp';

const bytes = (text: string) => new TextEncoder().encode(text);

/** Reference TOTP (RFC 6238, SHA-1, 6 digits) computed from the raw secret bytes. */
function referenceTotp(rawSecret: string, time: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30_000)));
  const hmac = createHmac('sha1', Buffer.from(rawSecret, 'utf8')).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 15;
  const value = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, '0');
}

/** Decodes RFC 4648 base32 (what authenticator apps do with the manual key). */
function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/\s+/g, '')) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

describe('TOTP enrolment helpers', () => {
  it('encodes base32 like RFC 4648 (without padding)', () => {
    expect(base32Encode(bytes(''))).toBe('');
    expect(base32Encode(bytes('f'))).toBe('MY');
    expect(base32Encode(bytes('fo'))).toBe('MZXQ');
    expect(base32Encode(bytes('foo'))).toBe('MZXW6');
    expect(base32Encode(bytes('foob'))).toBe('MZXW6YQ');
    expect(base32Encode(bytes('fooba'))).toBe('MZXW6YTB');
    expect(base32Encode(bytes('foobar'))).toBe('MZXW6YTBOI');
  });

  it('builds the otpauth URI that authenticator apps expect', () => {
    const uri = new URL(buildOtpAuthUri({ rawSecret: 'abcdefghijklmnopqrstuvwxyz012345', account: 'nezar@nuera.studio' }));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/Nuera Dev:nezar@nuera.studio');
    expect(uri.searchParams.get('issuer')).toBe('Nuera Dev');
    expect(uri.searchParams.get('digits')).toBe('6');
    expect(uri.searchParams.get('period')).toBe('30');
    expect(uri.searchParams.get('secret')).toBe(totpSecretToBase32('abcdefghijklmnopqrstuvwxyz012345'));
  });

  it('the manual key decodes back to the secret Better Auth verifies with', () => {
    const raw = 'Kq3vZ8pX1mN0sT7wY4rB6dF2hJ9lC5aE';
    const manual = groupSecret(totpSecretToBase32(raw));
    expect(base32Decode(manual).toString('utf8')).toBe(raw);
    const now = Date.UTC(2026, 10, 5, 9, 30);
    expect(referenceTotp(base32Decode(manual).toString('utf8'), now)).toBe(referenceTotp(raw, now));
  });

  it('groups the key by 4 and normalises typed codes', () => {
    expect(groupSecret('ABCDEFGHIJ')).toBe('ABCD EFGH IJ');
    expect(normaliseTotpCode(' 123 456 ')).toBe('123456');
    expect(normaliseBackupCode(' AbCde-12345 ')).toBe('AbCde-12345');
  });
});
