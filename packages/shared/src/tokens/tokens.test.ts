import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateLinkToken,
  generateRunnerToken,
  hashToken,
  isLinkToken,
  isRunnerTokenFormat,
  RUNNER_TOKEN_PREFIX,
  safeEqual,
  tokenFingerprint,
} from './index';

describe('jetons', () => {
  it('jeton de runner : « nrt_ » + base64url de 32 octets, jamais deux fois le même', () => {
    const token = generateRunnerToken();
    expect(token).toMatch(/^nrt_[A-Za-z0-9_-]{43}$/);
    expect(token.startsWith(RUNNER_TOKEN_PREFIX)).toBe(true);
    expect(Buffer.from(token.slice(4), 'base64url')).toHaveLength(32);
    expect(new Set(Array.from({ length: 50 }, generateRunnerToken)).size).toBe(50);
    expect(isRunnerTokenFormat(token)).toBe(true);
    expect(isRunnerTokenFormat('ancien-jeton-sans-prefixe')).toBe(false);
    expect(isRunnerTokenFormat(`nrt_${'a'.repeat(42)}`)).toBe(false);
  });

  it("jeton de lien (invitation, récupération) : base64url de 32 octets", () => {
    const token = generateLinkToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(isLinkToken(token)).toBe(true);
    expect(isLinkToken(`${token}=`)).toBe(false);
    expect(isLinkToken('../../etc/passwd')).toBe(false);
    expect(isLinkToken('')).toBe(false);
  });

  it('empreinte sha256 hexadécimale, identique à celle de la base (migrate, recovery-link)', () => {
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const token = generateRunnerToken();
    expect(hashToken(token)).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    expect(hashToken('é')).toBe(createHash('sha256').update(Buffer.from('é', 'utf8')).digest('hex'));
    expect(tokenFingerprint('abc')).toBe('ba7816bf');
    expect(tokenFingerprint(token)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('comparaison en temps constant, quelles que soient les longueurs', () => {
    const token = generateRunnerToken();
    expect(safeEqual(token, `${token}`)).toBe(true);
    expect(safeEqual(token, generateRunnerToken())).toBe(false);
    expect(safeEqual(token, token.slice(0, -1))).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('', 'x')).toBe(false);
  });
});
