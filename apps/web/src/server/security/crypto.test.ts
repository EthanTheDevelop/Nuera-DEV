import { createCipheriv, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cipherKeyId,
  decryptJson,
  decryptSecret,
  encryptJson,
  encryptSecret,
  isBoundCipher,
  needsReencryption,
  reencryptSecret,
  SecretDecryptionError,
  SecretScopes,
  type SecretScope,
} from './crypto';

const keyA = randomBytes(32).toString('base64');
const keyB = randomBytes(32).toString('base64');

const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_B = '22222222-2222-4222-8222-222222222222';
const SCOPE: SecretScope = SecretScopes.projectEnvVar(PROJECT_A, 'DATABASE_URL');

function flipChar(value: string, index: number): string {
  const c = value[index]!;
  return `${value.slice(0, index)}${c === 'A' ? 'B' : 'A'}${value.slice(index + 1)}`;
}

/** A value written before the multi-account model: `<keyId>:<iv>.<tag>.<data>`, AAD = keyId. */
function legacyCipher(plain: string, keyBase64: string, keyId = 'v1'): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(keyId, 'utf8'));
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${keyId}:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
}

describe('encryptSecret / decryptSecret (AES-256-GCM, bound to the owning row)', () => {
  beforeEach(() => {
    vi.stubEnv('APP_ENCRYPTION_KEY', keyA);
    vi.stubEnv('APP_ENCRYPTION_KEY_ID', '');
    vi.stubEnv('APP_ENCRYPTION_PREVIOUS_KEYS', '');
  });

  it('round-trips UTF-8 text with the bound "b1.v1:" prefix', () => {
    const plain = 'ghp_jeton·secret — éàü 🔐';
    const cipher = encryptSecret(plain, SCOPE);
    expect(cipher.startsWith('b1.v1:')).toBe(true);
    expect(isBoundCipher(cipher)).toBe(true);
    expect(cipherKeyId(cipher)).toBe('v1');
    expect(cipher).not.toContain(plain);
    expect(decryptSecret(cipher, SCOPE)).toBe(plain);
  });

  it('uses a fresh IV for every encryption', () => {
    expect(encryptSecret('même valeur', SCOPE)).not.toBe(encryptSecret('même valeur', SCOPE));
  });

  it('round-trips JSON values (bound)', () => {
    const value = { headers: { Authorization: 'Bearer x' }, n: 3, list: [true, null] };
    const scope = SecretScopes.mcpServer(PROJECT_A);
    const cipher = encryptJson(value, scope);
    expect(isBoundCipher(cipher)).toBe(true);
    expect(decryptJson<typeof value>(cipher, scope)).toEqual(value);
  });

  it('refuses a ciphertext copied under another row, table or owner (isolation)', () => {
    const cipher = encryptSecret('secret du projet A', SCOPE);
    // Same table, another project (another space): fails.
    expect(() => decryptSecret(cipher, SecretScopes.projectEnvVar(PROJECT_B, 'DATABASE_URL'))).toThrow(SecretDecryptionError);
    // Same project, another variable: fails.
    expect(() => decryptSecret(cipher, SecretScopes.projectEnvVar(PROJECT_A, 'OTHER'))).toThrow(SecretDecryptionError);
    // Same owner id, another table: fails.
    expect(() => decryptSecret(cipher, { table: 'mcp_servers', ownerId: `${PROJECT_A}:DATABASE_URL` })).toThrow(SecretDecryptionError);
    // A space's Coolify token moved to another space's row.
    const coolify = encryptJson({ token: 'coolify-a' }, SecretScopes.integration(PROJECT_A, 'coolify'));
    expect(() => decryptJson(coolify, SecretScopes.integration(PROJECT_B, 'coolify'))).toThrow(SecretDecryptionError);
    // A bound value never decrypts through the legacy JSON path.
    expect(() => decryptJson(coolify)).toThrow(/portée est requise/);
    // Stripping the marker does not turn it into a valid legacy value.
    expect(() => decryptSecret(cipher.slice(3), SCOPE)).toThrow(SecretDecryptionError);
  });

  it('rejects a tampered ciphertext, tag or IV', () => {
    const cipher = encryptSecret('valeur sensible', SCOPE);
    const prefix = 'b1.v1:';
    const [iv, tag, data] = cipher.slice(prefix.length).split('.') as [string, string, string];
    expect(() => decryptSecret(`${prefix}${iv}.${tag}.${flipChar(data, 0)}`, SCOPE)).toThrow(SecretDecryptionError);
    expect(() => decryptSecret(`${prefix}${iv}.${flipChar(tag, 2)}.${data}`, SCOPE)).toThrow(SecretDecryptionError);
    expect(() => decryptSecret(`${prefix}${flipChar(iv, 1)}.${tag}.${data}`, SCOPE)).toThrow(SecretDecryptionError);
  });

  it('rejects a ciphertext relabelled with another key id (key id is authenticated)', () => {
    vi.stubEnv('APP_ENCRYPTION_PREVIOUS_KEYS', `v0:${keyA}`);
    const cipher = encryptSecret('valeur', SCOPE);
    expect(() => decryptSecret(cipher.replace(/^b1\.v1:/, 'b1.v0:'), SCOPE)).toThrow(SecretDecryptionError);
    const legacy = legacyCipher('valeur', keyA);
    expect(() => decryptSecret(legacy.replace(/^v1:/, 'v0:'), SCOPE)).toThrow(SecretDecryptionError);
  });

  it('rejects malformed values, unknown key ids and invalid scopes', () => {
    expect(() => decryptSecret('pas-un-chiffré', SCOPE)).toThrow(SecretDecryptionError);
    expect(() => decryptSecret('v9:AAAA.BBBB.CCCC', SCOPE)).toThrow(SecretDecryptionError);
    expect(() => decryptSecret('b1.v9:AAAA.BBBB.CCCC', SCOPE)).toThrow(SecretDecryptionError);
    expect(() => decryptSecret(encryptSecret('x', SCOPE).replace(/^b1\.v1:/, 'b1.zz:'), SCOPE)).toThrow(/inconnue/);
    expect(() => encryptSecret('x', { table: '', ownerId: 'a' })).toThrow(/Portée de secret invalide/);
    expect(() => encryptSecret('x', { table: 'a|b', ownerId: 'a' })).toThrow(/Portée de secret invalide/);
    expect(() => encryptSecret('x', { table: 'projects', ownerId: '' })).toThrow(/Portée de secret invalide/);
    expect(() => decryptSecret(encryptSecret('x', SCOPE), { table: 'projects', ownerId: '' })).toThrow(/Portée de secret invalide/);
  });

  it('fails to decrypt with another key', () => {
    const cipher = encryptSecret('valeur', SCOPE);
    vi.stubEnv('APP_ENCRYPTION_KEY', keyB);
    expect(() => decryptSecret(cipher, SCOPE)).toThrow(SecretDecryptionError);
  });

  it('refuses a missing or wrongly sized key', () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', '');
    expect(() => encryptSecret('x', SCOPE)).toThrow(/APP_ENCRYPTION_KEY manquante/);
    vi.stubEnv('APP_ENCRYPTION_KEY', randomBytes(16).toString('base64'));
    expect(() => encryptSecret('x', SCOPE)).toThrow(/32 octets/);
  });

  it('still decrypts legacy values (AAD = key id) and re-encrypts them bound to their row', () => {
    const legacy = legacyCipher('ancienne valeur', keyA);
    expect(isBoundCipher(legacy)).toBe(false);
    expect(cipherKeyId(legacy)).toBe('v1');
    expect(decryptSecret(legacy, SCOPE)).toBe('ancienne valeur');
    expect(needsReencryption(legacy)).toBe(true);
    const bound = reencryptSecret(legacy, SCOPE);
    expect(isBoundCipher(bound)).toBe(true);
    expect(needsReencryption(bound)).toBe(false);
    expect(decryptSecret(bound, SCOPE)).toBe('ancienne valeur');
    // Once bound, the value no longer opens under another row.
    expect(() => decryptSecret(bound, SecretScopes.projectEnvVar(PROJECT_B, 'DATABASE_URL'))).toThrow(SecretDecryptionError);
  });

  it('keeps the legacy JSON API working for callers not migrated yet', () => {
    const legacy = encryptJson({ token: 'x' });
    expect(isBoundCipher(legacy)).toBe(false);
    expect(legacy.startsWith('v1:')).toBe(true);
    expect(decryptJson<{ token: string }>(legacy)).toEqual({ token: 'x' });
    // …and the scoped reader accepts it too (migration path).
    expect(decryptJson<{ token: string }>(legacy, SecretScopes.integration(PROJECT_A, 'coolify'))).toEqual({ token: 'x' });
    expect(decryptJson<{ token: string }>(reencryptSecret(legacy, SecretScopes.githubSource(PROJECT_A)), SecretScopes.githubSource(PROJECT_A))).toEqual({ token: 'x' });
  });

  it('supports rotation: previous keys decrypt, reencryptSecret moves to the current key', () => {
    const old = encryptSecret('à faire tourner', SCOPE);
    expect(cipherKeyId(old)).toBe('v1');

    vi.stubEnv('APP_ENCRYPTION_KEY', keyB);
    vi.stubEnv('APP_ENCRYPTION_KEY_ID', 'v2');
    vi.stubEnv('APP_ENCRYPTION_PREVIOUS_KEYS', `v1:${keyA}`);

    expect(decryptSecret(old, SCOPE)).toBe('à faire tourner');
    expect(needsReencryption(old)).toBe(true);
    const rotated = reencryptSecret(old, SCOPE);
    expect(cipherKeyId(rotated)).toBe('v2');
    expect(needsReencryption(rotated)).toBe(false);
    expect(reencryptSecret(rotated, SCOPE)).toBe(rotated);
    expect(decryptSecret(rotated, SCOPE)).toBe('à faire tourner');
    // A previous-key legacy value is rotated and bound in one step.
    const oldLegacy = legacyCipher('très ancienne', keyA, 'v1');
    const boundRotated = reencryptSecret(oldLegacy, SCOPE);
    expect(boundRotated.startsWith('b1.v2:')).toBe(true);
    expect(decryptSecret(boundRotated, SCOPE)).toBe('très ancienne');
  });

  it('reencryptSecret refuses a current-key bound value that belongs to another row', () => {
    const cipher = encryptSecret('valeur', SCOPE);
    expect(() => reencryptSecret(cipher, SecretScopes.projectEnvVar(PROJECT_B, 'DATABASE_URL'))).toThrow(SecretDecryptionError);
  });

  it('reports garbage as needing re-encryption without throwing', () => {
    expect(needsReencryption('pas-un-chiffré')).toBe(true);
    expect(isBoundCipher('pas-un-chiffré')).toBe(false);
    expect(cipherKeyId('pas-un-chiffré')).toBeNull();
  });
});
