import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encryption of application secrets at rest (integration credentials, MCP headers, project env vars…).
 *
 * AES-256-GCM, 96-bit random IV, 128-bit tag. Ciphertext format (ASCII, safe for `text` columns):
 *
 *     <keyId>:<base64url(iv)>.<base64url(tag)>.<base64url(ciphertext)>      e.g. "v1:Zm9v.YmFy.YmF6"
 *
 * Keys:
 *   APP_ENCRYPTION_KEY            current key — 32 bytes, base64 (`pnpm setup:env` generates it)
 *   APP_ENCRYPTION_KEY_ID         id of the current key (default "v1"), written as the prefix
 *   APP_ENCRYPTION_PREVIOUS_KEYS  old keys still accepted for decryption: "v0:<base64>,v-1:<base64>"
 *
 * Rotation (docs/SECURITY.md): add a new key with a new id, move the old one to
 * APP_ENCRYPTION_PREVIOUS_KEYS, re-encrypt stored values with `reencryptSecret()` (or by saving
 * them again), then drop the previous key. Decryption picks the key from the prefix.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;

export class SecretDecryptionError extends Error {
  constructor(message = 'Déchiffrement impossible : clé inconnue ou donnée altérée.') {
    super(message);
    this.name = 'SecretDecryptionError';
  }
}

interface KeyRing {
  currentId: string;
  keys: Map<string, Buffer>;
}

let cachedRing: { signature: string; ring: KeyRing } | null = null;

function parseKey(value: string, name: string): Buffer {
  const key = Buffer.from(value.trim(), 'base64');
  if (key.length !== 32) {
    throw new Error(`${name} invalide : 32 octets encodés en base64 attendus (\`pnpm setup:env\` en génère une).`);
  }
  return key;
}

function loadKeyRing(): KeyRing {
  const current = process.env.APP_ENCRYPTION_KEY ?? '';
  const currentId = (process.env.APP_ENCRYPTION_KEY_ID ?? '').trim() || 'v1';
  const previous = process.env.APP_ENCRYPTION_PREVIOUS_KEYS ?? '';
  const signature = `${currentId}\u0000${current}\u0000${previous}`;
  if (cachedRing?.signature === signature) return cachedRing.ring;

  if (!current.trim()) {
    throw new Error('APP_ENCRYPTION_KEY manquante : renseignez-la dans .env (voir .env.example).');
  }
  if (!KEY_ID_PATTERN.test(currentId)) {
    throw new Error('APP_ENCRYPTION_KEY_ID invalide : lettres, chiffres, « - » ou « _ » (16 max).');
  }
  const keys = new Map<string, Buffer>([[currentId, parseKey(current, 'APP_ENCRYPTION_KEY')]]);
  for (const entry of previous.split(',').map((item) => item.trim()).filter(Boolean)) {
    const separator = entry.indexOf(':');
    const id = separator > 0 ? entry.slice(0, separator) : '';
    if (!KEY_ID_PATTERN.test(id)) {
      throw new Error('APP_ENCRYPTION_PREVIOUS_KEYS invalide : format attendu « id:clé_base64 » séparé par des virgules.');
    }
    if (!keys.has(id)) keys.set(id, parseKey(entry.slice(separator + 1), `APP_ENCRYPTION_PREVIOUS_KEYS (${id})`));
  }
  const ring = { currentId, keys };
  cachedRing = { signature, ring };
  return ring;
}

/** Encrypts a UTF-8 string with the current key. */
export function encryptSecret(plain: string): string {
  const { currentId, keys } = loadKeyRing();
  const key = keys.get(currentId)!;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  // The key id is authenticated too: a ciphertext cannot be relabelled to another key.
  cipher.setAAD(Buffer.from(currentId, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${currentId}:${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

function parseCipher(cipherText: string): { keyId: string; iv: Buffer; tag: Buffer; data: Buffer } {
  const separator = cipherText.indexOf(':');
  if (separator <= 0) throw new SecretDecryptionError('Donnée chiffrée invalide.');
  const keyId = cipherText.slice(0, separator);
  const parts = cipherText.slice(separator + 1).split('.');
  if (parts.length !== 3 || !KEY_ID_PATTERN.test(keyId)) throw new SecretDecryptionError('Donnée chiffrée invalide.');
  const [iv, tag, data] = parts.map((part) => Buffer.from(part, 'base64url')) as [Buffer, Buffer, Buffer];
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new SecretDecryptionError('Donnée chiffrée invalide.');
  return { keyId, iv, tag, data };
}

/** Decrypts a value produced by `encryptSecret` (current or previous key). Throws SecretDecryptionError. */
export function decryptSecret(cipherText: string): string {
  const { keyId, iv, tag, data } = parseCipher(cipherText);
  const key = loadKeyRing().keys.get(keyId);
  if (!key) throw new SecretDecryptionError(`Clé de chiffrement « ${keyId} » inconnue.`);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(keyId, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretDecryptionError();
  }
}

export function encryptJson(value: unknown): string {
  return encryptSecret(JSON.stringify(value));
}

export function decryptJson<T>(cipherText: string): T {
  return JSON.parse(decryptSecret(cipherText)) as T;
}

/** Id of the key that encrypted this value ("v1"), or null when the format is not recognised. */
export function cipherKeyId(cipherText: string): string | null {
  try {
    return parseCipher(cipherText).keyId;
  } catch {
    return null;
  }
}

/** True when the value was encrypted with a key other than the current one. */
export function needsReencryption(cipherText: string): boolean {
  return cipherKeyId(cipherText) !== loadKeyRing().currentId;
}

/** Decrypts with whichever key matches and re-encrypts with the current key (rotation). */
export function reencryptSecret(cipherText: string): string {
  return needsReencryption(cipherText) ? encryptSecret(decryptSecret(cipherText)) : cipherText;
}

/** Masked rendering for the UI: never reveals more than the last 4 characters (« •••• 3f9c »). */
export function maskSecret(plain: string, visible = 4): string {
  if (plain.length <= visible * 2) return '••••';
  return `•••• ${plain.slice(-visible)}`;
}
