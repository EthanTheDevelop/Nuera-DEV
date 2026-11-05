import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cipherKeyId,
  decryptJson,
  decryptSecret,
  encryptJson,
  encryptSecret,
  needsReencryption,
  reencryptSecret,
  SecretDecryptionError,
} from './crypto';

const keyA = randomBytes(32).toString('base64');
const keyB = randomBytes(32).toString('base64');

function flipChar(value: string, index: number): string {
  const c = value[index]!;
  return `${value.slice(0, index)}${c === 'A' ? 'B' : 'A'}${value.slice(index + 1)}`;
}

describe('encryptSecret / decryptSecret (AES-256-GCM)', () => {
  beforeEach(() => {
    vi.stubEnv('APP_ENCRYPTION_KEY', keyA);
    vi.stubEnv('APP_ENCRYPTION_KEY_ID', '');
    vi.stubEnv('APP_ENCRYPTION_PREVIOUS_KEYS', '');
  });

  it('round-trips UTF-8 text with the "v1:" key-id prefix', () => {
    const plain = 'ghp_jeton·secret — éàü 🔐';
    const cipher = encryptSecret(plain);
    expect(cipher.startsWith('v1:')).toBe(true);
    expect(cipher).not.toContain(plain);
    expect(decryptSecret(cipher)).toBe(plain);
  });

  it('uses a fresh IV for every encryption', () => {
    expect(encryptSecret('même valeur')).not.toBe(encryptSecret('même valeur'));
  });

  it('round-trips JSON values', () => {
    const value = { headers: { Authorization: 'Bearer x' }, n: 3, list: [true, null] };
    expect(decryptJson<typeof value>(encryptJson(value))).toEqual(value);
  });

  it('rejects a tampered ciphertext, tag or IV', () => {
    const cipher = encryptSecret('valeur sensible');
    const [prefix, body] = [cipher.slice(0, 3), cipher.slice(3)];
    const [iv, tag, data] = body.split('.') as [string, string, string];
    expect(() => decryptSecret(`${prefix}${iv}.${tag}.${flipChar(data, 0)}`)).toThrow(SecretDecryptionError);
    expect(() => decryptSecret(`${prefix}${iv}.${flipChar(tag, 2)}.${data}`)).toThrow(SecretDecryptionError);
    expect(() => decryptSecret(`${prefix}${flipChar(iv, 1)}.${tag}.${data}`)).toThrow(SecretDecryptionError);
  });

  it('rejects a ciphertext relabelled with another key id (key id is authenticated)', () => {
    vi.stubEnv('APP_ENCRYPTION_PREVIOUS_KEYS', `v0:${keyA}`);
    const cipher = encryptSecret('valeur');
    expect(() => decryptSecret(cipher.replace(/^v1:/, 'v0:'))).toThrow(SecretDecryptionError);
  });

  it('rejects malformed values and unknown key ids', () => {
    expect(() => decryptSecret('pas-un-chiffré')).toThrow(SecretDecryptionError);
    expect(() => decryptSecret('v9:AAAA.BBBB.CCCC')).toThrow(SecretDecryptionError);
    expect(() => decryptSecret(encryptSecret('x').replace(/^v1:/, 'zz:'))).toThrow(/inconnue/);
  });

  it('fails to decrypt with another key', () => {
    const cipher = encryptSecret('valeur');
    vi.stubEnv('APP_ENCRYPTION_KEY', keyB);
    expect(() => decryptSecret(cipher)).toThrow(SecretDecryptionError);
  });

  it('refuses a missing or wrongly sized key', () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', '');
    expect(() => encryptSecret('x')).toThrow(/APP_ENCRYPTION_KEY manquante/);
    vi.stubEnv('APP_ENCRYPTION_KEY', randomBytes(16).toString('base64'));
    expect(() => encryptSecret('x')).toThrow(/32 octets/);
  });

  it('supports rotation: previous keys decrypt, reencryptSecret moves to the current key', () => {
    const old = encryptSecret('à faire tourner');
    expect(cipherKeyId(old)).toBe('v1');

    vi.stubEnv('APP_ENCRYPTION_KEY', keyB);
    vi.stubEnv('APP_ENCRYPTION_KEY_ID', 'v2');
    vi.stubEnv('APP_ENCRYPTION_PREVIOUS_KEYS', `v1:${keyA}`);

    expect(decryptSecret(old)).toBe('à faire tourner');
    expect(needsReencryption(old)).toBe(true);
    const rotated = reencryptSecret(old);
    expect(cipherKeyId(rotated)).toBe('v2');
    expect(needsReencryption(rotated)).toBe(false);
    expect(reencryptSecret(rotated)).toBe(rotated);
    expect(decryptSecret(rotated)).toBe('à faire tourner');
  });
});
