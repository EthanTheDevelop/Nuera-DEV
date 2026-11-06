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

  it('never lets a free-form session env carry a database, runner, encryption or auth secret, nor switch the Claude account', () => {
    for (const name of [
      'RUNNER_DATABASE_URL',
      'DATABASE_URL',
      'RUNNER_TOKEN',
      'APP_ENCRYPTION_KEY',
      'APP_ENCRYPTION_PREVIOUS_KEYS',
      'BETTER_AUTH_SECRET',
      'CLAUDE_CONFIG_DIR',
      'runner_database_url',
    ]) {
      expect(isRejectedSessionEnvName(name), name).toBe(true);
    }
    // Inherited by no child process either (CLAUDE_CONFIG_DIR excepted: the runner sets it itself for every claude process).
    for (const name of ['RUNNER_DATABASE_URL', 'APP_ENCRYPTION_PREVIOUS_KEYS']) expect(isDeniedEnvName(name), name).toBe(true);
  });

  it('denies the per-server settings of a runner (NUERA_*) and the Git identity variables in a session env', () => {
    for (const name of ['NUERA_ENVIRONMENT_ID', 'NUERA_CLAUDE_CONFIG_DIR', 'NUERA_DB_POOL_MAX', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_EMAIL']) {
      expect(isRejectedSessionEnvName(name), name).toBe(true);
    }
    expect(isDeniedProjectEnvName('NUERA_ENVIRONMENT_ID')).toBe(true);
    // A project may still use names of its own CI (RUNNER_OS…).
    expect(isDeniedProjectEnvName('RUNNER_OS')).toBe(false);
  });
});
