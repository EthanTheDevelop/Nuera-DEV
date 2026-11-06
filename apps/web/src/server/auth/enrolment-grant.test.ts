import { beforeEach, describe, expect, it } from 'vitest';
import { clearEnrolmentGrants, consumeEnrolmentGrant, ENROLMENT_GRANT_TTL_MS, issueEnrolmentGrant } from './enrolment-grant';

/*
 * Enrolment grants (MULTICOMPTE §6): the only way to open a password session for an account without
 * 2FA. Bound to one e-mail, single use, 60 s.
 */

beforeEach(() => clearEnrolmentGrants());

describe("autorisations d'enrôlement", () => {
  it("n'ouvre que l'e-mail pour lequel elle a été émise (casse et espaces ignorés)", () => {
    const nonce = issueEnrolmentGrant({ email: ' Camille@Example.TEST ', purpose: 'invitation' });
    expect(consumeEnrolmentGrant(nonce, 'camille@example.test')).toBe(true);
  });

  it("ne sert qu'une fois, et une tentative avec un autre e-mail la brûle", () => {
    const nonce = issueEnrolmentGrant({ email: 'camille@example.test', purpose: 'recovery' });
    expect(consumeEnrolmentGrant(nonce, 'ethan@example.test')).toBe(false);
    expect(consumeEnrolmentGrant(nonce, 'camille@example.test')).toBe(false);
    const again = issueEnrolmentGrant({ email: 'camille@example.test', purpose: 'recovery' });
    expect(consumeEnrolmentGrant(again, 'camille@example.test')).toBe(true);
    expect(consumeEnrolmentGrant(again, 'camille@example.test')).toBe(false);
  });

  it('expire après 60 s ; sans jeton ni e-mail, rien', () => {
    const now = 1_000_000;
    const nonce = issueEnrolmentGrant({ email: 'camille@example.test', purpose: 'setup' }, now);
    expect(consumeEnrolmentGrant(nonce, 'camille@example.test', now + ENROLMENT_GRANT_TTL_MS)).toBe(false);
    expect(consumeEnrolmentGrant(null, 'camille@example.test')).toBe(false);
    expect(consumeEnrolmentGrant(issueEnrolmentGrant({ email: 'camille@example.test', purpose: 'setup' }), null)).toBe(false);
    expect(() => issueEnrolmentGrant({ email: '  ', purpose: 'setup' })).toThrow();
  });
});
