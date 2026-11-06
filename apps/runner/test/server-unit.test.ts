import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import type { Database } from '@nuera/db';
import { describe, expect, it } from 'vitest';
import { claudeEnv, gitIdentityEnv } from '../src/claude/env';
import { loadConfig, loadDotEnv, REPO_ROOT } from '../src/config';
import { EnvironmentContext } from '../src/environment';
import { Git } from '../src/git/git';
import { stripAnsi, TestOutputParser } from '../src/runs/test-parser';
import { redactSecrets } from '../src/safety/redact';
import { tighterLimit } from '../src/sessions/manager';
import { readLaunchFile, sessionDir, writeSessionFiles } from '../src/sessions/runtime-files';
import { transcriptsRoot } from '../src/sessions/transcript';

const baseEnv = { RUNNER_TOKEN: 'x'.repeat(32), DATABASE_URL: 'postgres://plein@db/nuera' };

describe('runner configuration (servers)', () => {
  it('prefers the restricted DSN, sizes the pool and keeps NUERA_ENVIRONMENT_ID as an assertion only', () => {
    const plain = loadConfig({ ...baseEnv });
    expect(plain).toMatchObject({ databaseUrl: 'postgres://plein@db/nuera', dbPoolMax: 5, environmentId: null, claudeConfigDir: null });
    const restricted = loadConfig({
      ...baseEnv,
      RUNNER_DATABASE_URL: 'postgres://nuera_env_1a2b3c4d@db/nuera',
      NUERA_DB_POOL_MAX: '3',
      NUERA_ENVIRONMENT_ID: '6F1D2C3B-0A9E-4D8C-B7A6-5F4E3D2C1B0A',
      NUERA_CLAUDE_CONFIG_DIR: './.data/envs/b/claude',
    });
    expect(restricted).toMatchObject({
      databaseUrl: 'postgres://nuera_env_1a2b3c4d@db/nuera',
      dbPoolMax: 3,
      environmentId: '6f1d2c3b-0a9e-4d8c-b7a6-5f4e3d2c1b0a',
      claudeConfigDir: path.resolve(REPO_ROOT, '.data/envs/b/claude'),
    });
    // Compose passes empty strings for unset optional variables.
    expect(loadConfig({ ...baseEnv, RUNNER_DATABASE_URL: '', NUERA_DB_POOL_MAX: '', NUERA_ENVIRONMENT_ID: '', NUERA_CLAUDE_CONFIG_DIR: '' })).toMatchObject({
      databaseUrl: 'postgres://plein@db/nuera',
      dbPoolMax: 5,
      environmentId: null,
      claudeConfigDir: null,
    });
    // Only RUNNER_DATABASE_URL is enough (a restricted runner never needs the full DSN).
    expect(loadConfig({ RUNNER_TOKEN: 'x'.repeat(32), RUNNER_DATABASE_URL: 'postgres://r@db/n' }).databaseUrl).toBe('postgres://r@db/n');
    expect(() => loadConfig({ RUNNER_TOKEN: 'x'.repeat(32) })).toThrow('RUNNER_DATABASE_URL ou DATABASE_URL manquant');
    expect(() => loadConfig({ ...baseEnv, NUERA_ENVIRONMENT_ID: 'vps-3' })).toThrow('NUERA_ENVIRONMENT_ID doit être un identifiant de serveur (UUID).');
  });

  it('reads NUERA_ENV_FILE before the root .env (a second runner on the same machine)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nuera-envfile-'));
    try {
      const second = path.join(dir, '.env.runner-b');
      const root = path.join(dir, '.env');
      writeFileSync(second, 'RUNNER_PORT=4110\nNUERA_DATA_DIR=./.data/envs/b/runner\n');
      writeFileSync(root, 'RUNNER_PORT=4100\nRUNNER_TOKEN=racine-0123456789abcdef\nNUERA_DATA_DIR=./.data/runner\n');
      const env: Record<string, string | undefined> = { NUERA_ENV_FILE: second, RUNNER_HOOK_PORT: '4111' };
      expect(loadDotEnv(env as NodeJS.ProcessEnv, root)).toBe(true);
      expect(env).toMatchObject({ RUNNER_PORT: '4110', NUERA_DATA_DIR: './.data/envs/b/runner', RUNNER_TOKEN: 'racine-0123456789abcdef', RUNNER_HOOK_PORT: '4111' });
      // Production never reads a file.
      const prod: Record<string, string | undefined> = { NODE_ENV: 'production', NUERA_ENV_FILE: second };
      expect(loadDotEnv(prod as NodeJS.ProcessEnv, root)).toBe(false);
      expect(prod.RUNNER_PORT).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('trusted variables of child processes', () => {
  it('builds CLAUDE_CONFIG_DIR and the Git identity, nothing when unset', () => {
    expect(claudeEnv(null)).toEqual({});
    expect(claudeEnv('/srv/claude-b')).toEqual({ CLAUDE_CONFIG_DIR: '/srv/claude-b' });
    expect(gitIdentityEnv(null)).toEqual({});
    expect(gitIdentityEnv({ name: 'Camille Martin', email: 'camille@example.test' })).toEqual({
      GIT_AUTHOR_NAME: 'Camille Martin',
      GIT_AUTHOR_EMAIL: 'camille@example.test',
      GIT_COMMITTER_NAME: 'Camille Martin',
      GIT_COMMITTER_EMAIL: 'camille@example.test',
    });
  });

  it('validates transcripts against the same config dir as the CLI', () => {
    expect(transcriptsRoot('/srv/claude-b', { CLAUDE_CONFIG_DIR: '/ailleurs' })).toBe(path.join('/srv/claude-b', 'projects'));
    expect(transcriptsRoot(null, { CLAUDE_CONFIG_DIR: '/ailleurs' })).toBe(path.join('/ailleurs', 'projects'));
    expect(transcriptsRoot(null, {})).toBe(path.join(os.homedir(), '.claude', 'projects'));
  });

  it('pins core.autocrlf=false on every git command (byte fidelity on Windows)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nuera-gitenv-'));
    try {
      const env = new Git(dir, 'https://github.com/').buildEnv({});
      const pairs = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_v, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
      expect(pairs).toContainEqual(['core.autocrlf', 'false']);
      expect(pairs.some(([key]) => key === 'core.eol')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('masks runner tokens', () => {
    const token = `nrt_${'A1b2C3d4'.repeat(5)}_-x`;
    expect(redactSecrets(`RUNNER_TOKEN=${token} fin`)).toBe('RUNNER_TOKEN=[jeton du runner masqué] fin');
  });
});

describe('session policies of a server', () => {
  it('keeps the stricter memory ceiling of the launch and of the server', () => {
    expect(tighterLimit(null, null)).toBeNull();
    expect(tighterLimit(2048, null)).toBe(2048);
    expect(tighterLimit(null, 1024)).toBe(1024);
    expect(tighterLimit(4096, 1024)).toBe(1024);
    expect(tighterLimit(512, 1024)).toBe(512);
  });

  it('blocks the bypass mode when the instance-wide block cannot be read (fail closed)', async () => {
    const unreadable = {
      select: () => {
        throw new Error('permission denied for table app_settings');
      },
    } as unknown as Database;
    const config = loadConfig({ ...baseEnv });
    const context = new EnvironmentContext({ db: unreadable, config, logger: pino({ level: 'silent' }) });
    expect(await context.forceBlockBypass()).toBe(true);
  });
});

describe('launch.json written by an older runner', () => {
  it('still resumes with its MCP config, deny rules and env (contract 2 fields are optional)', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'nuera-launch-'));
    try {
      const sessionId = '7f0b3c2e-1b2a-4c3d-9e8f-0a1b2c3d4e5f';
      mkdirSync(sessionDir(dataDir, sessionId), { recursive: true });
      // Exact shape of a file written before multi-account (no policy, no identity).
      const old = {
        sessionId,
        claudeSessionId: sessionId,
        permissionWaitSeconds: 90,
        maxConcurrentSessions: null,
        memoryLimitMb: 2048,
        env: { NODE_ENV: 'development' },
        denyRules: ['mcp__coolify__deploy'],
        hasMcp: true,
        updatedAt: '2026-10-01T08:00:00.000Z',
      };
      writeFileSync(path.join(sessionDir(dataDir, sessionId), 'launch.json'), JSON.stringify(old, null, 2));
      const read = await readLaunchFile(dataDir, sessionId);
      expect(read).toEqual(old);
      expect(read?.gitIdentity).toBeUndefined();
      expect(read?.blockBypassPermissions).toBeUndefined();

      // A rewrite keeps the new fields when given, and the file stays readable.
      await writeSessionFiles(dataDir, {
        sessionId,
        claudeSessionId: sessionId,
        launch: { denyRules: old.denyRules, env: old.env },
        permissionWaitSeconds: 90,
        maxConcurrentSessions: null,
        memoryLimitMb: 2048,
        hookToken: null,
        blockBypassPermissions: false,
        gitIdentity: { name: 'Camille Martin', email: 'camille@example.test' },
      });
      expect(await readLaunchFile(dataDir, sessionId)).toMatchObject({
        denyRules: ['mcp__coolify__deploy'],
        blockBypassPermissions: false,
        gitIdentity: { name: 'Camille Martin', email: 'camille@example.test' },
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('test report under a Windows PTY (ConPTY)', () => {
  it('reads every per-test line when a blank line is painted with a cursor move', () => {
    // Exact chunks of `cmd /d /s /c "node print-test.js"` under ConPTY (test/runs.test.ts).
    const chunks = [
      '\u001b[?9001h\u001b[?1004h',
      '\u001b[?25l\u001b[2J\u001b[m\u001b[H  VITE ready - Local: http://localhost:4321/\r\n\u001b]0;C:\\WINDOWS\\system32\\cmd.exe\u0007\u001b[?25h',
      '\u001b[?25l ✓ src/a.test.ts > somme 3ms\r\n ✓ src/a.test.ts > produit 2ms\u001b[5;1H Test Files  1 passed (1)\r\n      Tests  2 passed (2)\r\n   Duration  1.10s\r\n\u001b[?25h',
    ];
    const parser = new TestOutputParser();
    for (const chunk of chunks) parser.push(chunk);
    const report = parser.report({ finished: true });
    expect(report?.tests.map((t) => t.name)).toEqual(['src/a.test.ts > somme', 'src/a.test.ts > produit']);
    expect(report?.counts).toMatchObject({ passed: 2, total: 2, framework: 'vitest' });
  });

  it('turns row moves into line breaks and forward moves into spaces', () => {
    expect(stripAnsi('a\u001b[5;1Hb')).toBe('a\nb');
    expect(stripAnsi('Tests\u001b[2C2 passed')).toBe('Tests  2 passed');
    expect(stripAnsi('\u001b[1mgras\u001b[0m\u001b[K')).toBe('gras');
  });
});
