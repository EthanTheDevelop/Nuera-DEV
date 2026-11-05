import { describe, expect, it } from 'vitest';
import { isValidRunnerAuthorization } from './runner-token';

const TOKEN = 'rUnNeR-tOkEn-0123456789abcdef';

describe('isValidRunnerAuthorization', () => {
  it('accepts exactly "Bearer <RUNNER_TOKEN>"', () => {
    expect(isValidRunnerAuthorization(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isValidRunnerAuthorization(`bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it('refuses wrong, partial or malformed values', () => {
    expect(isValidRunnerAuthorization(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(isValidRunnerAuthorization(`Bearer ${TOKEN.slice(1)}`, TOKEN)).toBe(false);
    expect(isValidRunnerAuthorization(TOKEN, TOKEN)).toBe(false);
    expect(isValidRunnerAuthorization(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(isValidRunnerAuthorization(`Bearer ${TOKEN} extra`, TOKEN)).toBe(false);
    expect(isValidRunnerAuthorization('Bearer ', TOKEN)).toBe(false);
    expect(isValidRunnerAuthorization(null, TOKEN)).toBe(false);
  });

  it('refuses everything when RUNNER_TOKEN is missing or too short', () => {
    expect(isValidRunnerAuthorization('Bearer ', '')).toBe(false);
    expect(isValidRunnerAuthorization('Bearer court', 'court')).toBe(false);
    expect(isValidRunnerAuthorization(`Bearer ${TOKEN}`, undefined)).toBe(false);
  });
});
