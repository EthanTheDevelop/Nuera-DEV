import { describe, expect, it } from 'vitest';
import { isDeniedEnvName, isDeniedProjectEnvName, isRejectedSessionEnvName } from './index';

describe('shared environment deny-lists', () => {
  it('denies Nuera secrets, Anthropic switches and Git/GitHub plumbing, whatever the case', () => {
    for (const name of ['RUNNER_TOKEN', 'anthropic_api_key', 'CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN', 'gh_token', 'GIT_DIR', 'npm_config_x', 'NUERA_ANY', 'VAPID_PRIVATE_KEY']) {
      expect(isDeniedEnvName(name)).toBe(true);
    }
    expect(isDeniedEnvName('STRIPE_KEY')).toBe(false);
  });

  it('refuses protected names in a session env, but lets a project define its own DATABASE_URL', () => {
    expect(isRejectedSessionEnvName('PATH')).toBe(true);
    expect(isRejectedSessionEnvName('Path')).toBe(true);
    expect(isRejectedSessionEnvName('ENABLE_CLAUDEAI_MCP_SERVERS')).toBe(true);
    expect(isRejectedSessionEnvName('MY_FLAG')).toBe(false);
    expect(isDeniedProjectEnvName('DATABASE_URL')).toBe(false);
    expect(isDeniedProjectEnvName('GITHUB_TOKEN')).toBe(false);
    expect(isDeniedProjectEnvName('LD_PRELOAD')).toBe(true);
    expect(isDeniedProjectEnvName('git_config_count')).toBe(true);
    expect(isDeniedProjectEnvName('nuera_x')).toBe(true);
  });
});
