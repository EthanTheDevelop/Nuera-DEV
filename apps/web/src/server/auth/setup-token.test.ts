import { describe, expect, it } from 'vitest';
import { checkSetupToken, isSetupTokenConfigured } from './setup-token';

const TOKEN = 'b3J0LXNldHVwLXRva2VuLTE4';

describe('SETUP_TOKEN rules', () => {
  it('is "not configured" when missing, blank or shorter than 16 characters', () => {
    expect(isSetupTokenConfigured(undefined)).toBe(false);
    expect(isSetupTokenConfigured('   ')).toBe(false);
    expect(isSetupTokenConfigured('court-123')).toBe(false);
    expect(checkSetupToken(TOKEN, undefined)).toBe('not_configured');
    expect(checkSetupToken('court-123', 'court-123')).toBe('not_configured');
  });

  it('accepts the exact token (surrounding spaces ignored)', () => {
    expect(checkSetupToken(TOKEN, TOKEN)).toBe('ok');
    expect(checkSetupToken(`  ${TOKEN}\n`, TOKEN)).toBe('ok');
  });

  it('refuses a wrong, partial, longer, differently cased or empty token', () => {
    expect(checkSetupToken(`${TOKEN}x`, TOKEN)).toBe('invalid');
    expect(checkSetupToken(TOKEN.slice(0, -1), TOKEN)).toBe('invalid');
    expect(checkSetupToken(TOKEN.toUpperCase(), TOKEN)).toBe('invalid');
    expect(checkSetupToken('', TOKEN)).toBe('invalid');
    expect(checkSetupToken(null, TOKEN)).toBe('invalid');
    expect(checkSetupToken(undefined, TOKEN)).toBe('invalid');
  });
});
