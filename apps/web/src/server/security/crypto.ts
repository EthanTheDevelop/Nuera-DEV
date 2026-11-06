import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encryption of application secrets at rest (integration credentials, MCP headers, project env vars,
 * runner tokens…). AES-256-GCM, 96-bit random IV, 128-bit tag. docs/MULTICOMPTE.md §11.
 *
 * Bound format (current) — the ciphertext is tied to the row that owns it:
 *
 *     b1.<keyId>:<base64url(iv)>.<base64url(tag)>.<base64url(ciphertext)>
 *     associated data = "<keyId>|<table>|<ownerId>"
 *
 *   const stored = encryptSecret(value, SecretScopes.projectEnvVar(project.id, key));
 *   const value = decryptSecret(row.valueEncrypted, SecretScopes.projectEnvVar(row.projectId, row.key));
 *
 * A ciphertext copied under another row (another project, space, source or MCP server) fails to
 * decrypt: whoever can write to the database cannot move a secret from one space to another.
 *
 * Legacy format (written before the multi-account model, still decrypted, never written by the
 * bound API): `<keyId>:<iv>.<tag>.<ciphertext>` with associated data = keyId only. A scoped
 * `decryptSecret` accepts it; `needsReencryption` reports it and `reencryptSecret` rewrites it bound.
 *
 * Keys:
 *   APP_ENCRYPTION_KEY            current key — 32 bytes, base64 (`pnpm setup:env` generates it)
 *   APP_ENCRYPTION_KEY_ID         id of the current key (default "v1"), written in the prefix
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
/** Marker of the bound format. The « . » never appears in a key id, so both formats are unambiguous. */
const BOUND_MARKER = 'b1.';
const TABLE_PATTERN = /^[a-z][a-z0-9_.]{0,62}$/;
const MAX_OWNER_ID = 300;

export class SecretDecryptionError extends Error {
  constructor(message = 'Déchiffrement impossible : clé inconnue ou donnée altérée.') {
    super(message);
    this.name = 'SecretDecryptionError';
  }
}

/**
 * Row a secret belongs to. `table` names the column family (« project_env_vars »), `ownerId` the
 * owning row (« <projectId>:<KEY> », a space, source or MCP server id…). Build it with `SecretScopes`.
 */
export interface SecretScope {
  table: string;
  ownerId: string;
}

/**
 * The scopes of every encrypted column (one place, so writers and readers always agree).
 * Promoting `environments.next_token_encrypted` to `token_encrypted` is a plain copy: both columns
 * share the scope of their server.
 */
export const SecretScopes = {
  /** `project_env_vars.value_encrypted`: the project and the variable name (unique per project). */
  projectEnvVar: (projectId: string, key: string): SecretScope => ({ table: 'project_env_vars', ownerId: `${projectId}:${key}` }),
  /** `github_sources.secrets_encrypted`. */
  githubSource: (sourceId: string): SecretScope => ({ table: 'github_sources', ownerId: sourceId }),
  /** `integrations.secrets_encrypted` (one row per space and kind: Coolify, Figma). */
  integration: (spaceId: string, kind: string): SecretScope => ({ table: 'integrations', ownerId: `${spaceId}:${kind}` }),
  /** `mcp_servers.secrets_encrypted` (generate the row id before the insert). */
  mcpServer: (serverId: string): SecretScope => ({ table: 'mcp_servers', ownerId: serverId }),
  /** `instance_mcp_servers.secrets_encrypted` (configuration Claude commune; generate the row id before the insert). */
  instanceMcpServer: (serverId: string): SecretScope => ({ table: 'instance_mcp_servers', ownerId: serverId }),
  /** `environments.token_encrypted` and `environments.next_token_encrypted`. */
  environmentToken: (environmentId: string): SecretScope => ({ table: 'environments', ownerId: environmentId }),
  /** Signed state of the GitHub App manifest flow (never stored): bound to the account that started it. */
  githubManifestState: (userId: string): SecretScope => ({ table: 'github_manifest_state', ownerId: userId }),
} as const;

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

function assertScope(scope: SecretScope): SecretScope {
  if (!scope || !TABLE_PATTERN.test(scope.table)) throw new Error('Portée de secret invalide : table attendue.');
  if (typeof scope.ownerId !== 'string' || scope.ownerId.length === 0 || scope.ownerId.length > MAX_OWNER_ID) {
    throw new Error('Portée de secret invalide : propriétaire attendu.');
  }
  return scope;
}

/** "<keyId>|<table>|<ownerId>": neither the key id nor the table may contain « | », so it is unambiguous. */
function boundAad(keyId: string, scope: SecretScope): Buffer {
  return Buffer.from(`${keyId}|${scope.table}|${scope.ownerId}`, 'utf8');
}

function seal(plain: string, keyId: string, key: Buffer, aad: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${keyId}:${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

interface ParsedCipher {
  bound: boolean;
  keyId: string;
  iv: Buffer;
  tag: Buffer;
  data: Buffer;
}

function parseCipher(cipherText: string): ParsedCipher {
  if (typeof cipherText !== 'string') throw new SecretDecryptionError('Donnée chiffrée invalide.');
  const bound = cipherText.startsWith(BOUND_MARKER);
  const body = bound ? cipherText.slice(BOUND_MARKER.length) : cipherText;
  const separator = body.indexOf(':');
  if (separator <= 0) throw new SecretDecryptionError('Donnée chiffrée invalide.');
  const keyId = body.slice(0, separator);
  const parts = body.slice(separator + 1).split('.');
  if (parts.length !== 3 || !KEY_ID_PATTERN.test(keyId)) throw new SecretDecryptionError('Donnée chiffrée invalide.');
  const [iv, tag, data] = parts.map((part) => Buffer.from(part, 'base64url')) as [Buffer, Buffer, Buffer];
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new SecretDecryptionError('Donnée chiffrée invalide.');
  return { bound, keyId, iv, tag, data };
}

function open(parsed: ParsedCipher, aad: Buffer): string {
  const key = loadKeyRing().keys.get(parsed.keyId);
  if (!key) throw new SecretDecryptionError(`Clé de chiffrement « ${parsed.keyId} » inconnue.`);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, parsed.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(parsed.tag);
    return Buffer.concat([decipher.update(parsed.data), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretDecryptionError();
  }
}

/** Encrypts a UTF-8 string with the current key, bound to the row that owns it. */
export function encryptSecret(plain: string, scope: SecretScope): string {
  assertScope(scope);
  const { currentId, keys } = loadKeyRing();
  return `${BOUND_MARKER}${seal(plain, currentId, keys.get(currentId)!, boundAad(currentId, scope))}`;
}

/**
 * Decrypts a value of this row (current or previous key). A value in the legacy format is accepted
 * (re-encrypt it with `reencryptSecret`). Throws SecretDecryptionError, notably for a ciphertext
 * that belongs to another row.
 */
export function decryptSecret(cipherText: string, scope: SecretScope): string {
  assertScope(scope);
  const parsed = parseCipher(cipherText);
  return open(parsed, parsed.bound ? boundAad(parsed.keyId, scope) : Buffer.from(parsed.keyId, 'utf8'));
}

/** JSON variant of `encryptSecret` (bound format). */
export function encryptJson(value: unknown, scope: SecretScope): string;
/** @deprecated Legacy unbound format, kept for the callers not migrated yet: pass a `SecretScope`. */
export function encryptJson(value: unknown): string;
export function encryptJson(value: unknown, scope?: SecretScope): string {
  const plain = JSON.stringify(value);
  if (scope) return encryptSecret(plain, scope);
  const { currentId, keys } = loadKeyRing();
  return seal(plain, currentId, keys.get(currentId)!, Buffer.from(currentId, 'utf8'));
}

/** JSON variant of `decryptSecret` (bound or legacy format). */
export function decryptJson<T>(cipherText: string, scope: SecretScope): T;
/** @deprecated Legacy unbound format only (a bound value needs its scope): pass a `SecretScope`. */
export function decryptJson<T>(cipherText: string): T;
export function decryptJson<T>(cipherText: string, scope?: SecretScope): T {
  if (scope) return JSON.parse(decryptSecret(cipherText, scope)) as T;
  const parsed = parseCipher(cipherText);
  if (parsed.bound) throw new SecretDecryptionError('Donnée chiffrée liée à une ligne : sa portée est requise.');
  return JSON.parse(open(parsed, Buffer.from(parsed.keyId, 'utf8'))) as T;
}

/** Id of the key that encrypted this value ("v1"), or null when the format is not recognised. */
export function cipherKeyId(cipherText: string): string | null {
  try {
    return parseCipher(cipherText).keyId;
  } catch {
    return null;
  }
}

/** True for a value in the bound format (false for the legacy format or garbage). */
export function isBoundCipher(cipherText: string): boolean {
  try {
    return parseCipher(cipherText).bound;
  } catch {
    return false;
  }
}

/**
 * True when the value should be rewritten: legacy (unbound) format, or a key other than the current
 * one. The scope is not needed to tell (the format and the key id are in clear).
 */
export function needsReencryption(cipherText: string): boolean {
  try {
    const parsed = parseCipher(cipherText);
    return !parsed.bound || parsed.keyId !== loadKeyRing().currentId;
  } catch {
    return true;
  }
}

/**
 * Decrypts (legacy or bound, any known key) and re-encrypts bound to `scope` with the current key.
 * Returns the value unchanged when it is already bound with the current key — after checking that it
 * really belongs to `scope` (throws SecretDecryptionError otherwise).
 */
export function reencryptSecret(cipherText: string, scope: SecretScope): string {
  const plain = decryptSecret(cipherText, scope);
  return needsReencryption(cipherText) ? encryptSecret(plain, scope) : cipherText;
}

/** Masked rendering for the UI: never reveals more than the last 4 characters (« •••• 3f9c »). */
export function maskSecret(plain: string, visible = 4): string {
  if (plain.length <= visible * 2) return '••••';
  return `•••• ${plain.slice(-visible)}`;
}
