import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventBus, GLOBAL, sessionChannel } from '../src/events/bus';
import { Git, unsafeNetworkConfigKeys } from '../src/git/git';
import { parseNumstatZ, parsePushPorcelain, parseStatusV2, parseUnifiedDiff, parseWorktreeList, additionDiff } from '../src/git/parse';
import { parseProgressLine, ProgressStream } from '../src/git/progress';
import { detectPackageManager, parseInstalledPackages } from '../src/git/clone';
import { buildChildEnv, isDeniedEnvName, rejectedEnvNames } from '../src/safety/env';
import { execCommand } from '../src/safety/exec';
import { redactSecrets } from '../src/safety/redact';
import { parseTestOutput, TestOutputParser } from '../src/runs/test-parser';
import { detectPort } from '../src/runs/manager';
import { lineDiffCounts, planFromTodoWrite, toolOutcome, toolTarget } from '../src/sessions/tool-meta';
import { alwaysLabelFrom, permissionTitle, resolvedLabel } from '../src/sessions/permission-text';
import { sanitizeStatusLine } from '../src/sessions/statusline';
import { extractAssistantTexts } from '../src/sessions/transcript';
import { permissionNotificationCopy, sanitizeInstruction } from '../src/sessions/manager';
import { walkDiskUsage } from '../src/system/disk-usage';
import { buildMcpConfig, buildSettings, HOOK_EVENTS } from '../src/sessions/runtime-files';
import { parseAuthStatus, parseMcpGet, userScopeMcpConfig } from '../src/claude/cli';
import { tmuxSessionName } from '../src/sessions/backend';

describe('environment sanitisation', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/nuera',
    LANG: 'fr_FR.UTF-8',
    TERM: 'xterm',
    ANTHROPIC_API_KEY: 'sk-ant-xxx',
    ANTHROPIC_BASE_URL: 'https://proxy',
    CLAUDE_CODE_OAUTH_TOKEN: 'tok',
    RUNNER_TOKEN: 'secret',
    DATABASE_URL: 'postgres://x',
    BETTER_AUTH_SECRET: 's',
    APP_ENCRYPTION_KEY: 'k',
    SETUP_TOKEN: 't',
    VAPID_PRIVATE_KEY: 'v',
    GITHUB_FALLBACK_TOKEN: 'ghp_x',
    GIT_DIR: '/tmp/evil',
    NODE_OPTIONS: '--require evil',
    CLAUDE_CONFIG_DIR: '/home/nuera/.claude',
    RANDOM_THING: 'x',
  };

  it('keeps only the allow-list and never a secret', () => {
    const env = buildChildEnv({}, { source });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/nuera', LANG: 'fr_FR.UTF-8', TERM: 'xterm', CLAUDE_CONFIG_DIR: '/home/nuera/.claude' });
  });

  it('drops denied names from extra variables (strict) but keeps project variables', () => {
    expect(buildChildEnv({ GITHUB_TOKEN: 'x', MY_VAR: 'ok' }, { source: {} })).toEqual({ MY_VAR: 'ok' });
    expect(buildChildEnv({ DATABASE_URL: 'postgres://app', ANTHROPIC_API_KEY: 'no', NUERA_X: 'no' }, { source: {}, policy: 'project' })).toEqual({
      DATABASE_URL: 'postgres://app',
    });
    expect(isDeniedEnvName('VAPID_PUBLIC_KEY')).toBe(true);
    expect(rejectedEnvNames(['PATH', 'FOO', 'RUNNER_TOKEN'])).toEqual(['PATH', 'RUNNER_TOKEN']);
  });

  it('runs commands without a shell and with the sanitised environment', async () => {
    process.env.RUNNER_TOKEN_TEST_LEAK = 'nope';
    const result = await execCommand(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env)))'], {
      env: buildChildEnv({}, { source: { ...process.env, RUNNER_TOKEN: 'secret', ANTHROPIC_API_KEY: 'x' } }),
    });
    const keys = JSON.parse(result.stdout) as string[];
    expect(keys).not.toContain('RUNNER_TOKEN');
    expect(keys).not.toContain('ANTHROPIC_API_KEY');
    // Shell metacharacters are plain arguments.
    const echo = await execCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '$(whoami) && rm -rf /'], {});
    expect(echo.stdout).toBe('$(whoami) && rm -rf /');
  });

  it('caps output and enforces timeouts', async () => {
    const big = await execCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], { maxOutputBytes: 1000 });
    expect(big.stdout.length).toBe(1000);
    expect(big.truncated).toBe(true);
    const slow = await execCommand(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 500 });
    expect(slow.timedOut).toBe(true);
  });
});

describe('git network guard (Claude can edit .git/config)', () => {
  it('flags only the repository keys that could redirect or weaken a network command', () => {
    const records = [
      ['local', 'core.bare\nfalse'],
      ['local', 'remote.origin.url\nhttps://github.com/o/r.git'],
      ['local', 'http.postbuffer\n524288000'],
      ['local', 'http.sslverify\nfalse'],
      ['local', 'http.https://github.com/o/r.git.sslverify\nfalse'],
      ['local', 'http.https://github.com/.proxy\nhttp://evil:8080'],
      ['local', 'url.ext::sh -c x.insteadof\nhttps://github.com/'],
      ['worktree', 'protocol.ext.allow\nalways'],
      ['local', 'remote.https://github.com/o/r.git.pushurl\nhttps://evil.example/r.git'],
      ['local', 'core.ignorecase'],
      ['command', 'http.https://github.com/.extraheader\nAUTHORIZATION: basic eA=='],
      ['command', 'protocol.allow\nnever'],
    ];
    const output = `${records.map(([scope, entry]) => `${scope}\0${entry}`).join('\0')}\0`;
    expect(unsafeNetworkConfigKeys(output)).toEqual([
      'http.https://github.com/o/r.git.sslverify',
      'http.https://github.com/.proxy',
      'url.ext::sh -c x.insteadof',
      'protocol.ext.allow',
      'remote.https://github.com/o/r.git.pushurl',
    ]);
  });

  it('refuses an authenticated network command before git reads the token', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nuera-gitguard-'));
    try {
      execFileSync('git', ['init', '-q', 'repo'], { cwd: root, stdio: 'ignore' });
      const repo = path.join(root, 'repo');
      const gitCli = new Git(path.join(root, 'data'), 'https://github.com/');
      await expect(gitCli.assertSafeNetworkConfig(repo)).resolves.toBeUndefined();
      // A URL-specific key outranks the runner's own `http.sslVerify=true` (same uid as Claude).
      execFileSync('git', ['config', 'http.https://github.com/o/r.git.sslVerify', 'false'], { cwd: repo, stdio: 'ignore' });
      await expect(
        gitCli.run(['ls-remote', 'https://github.com/o/r.git'], { cwd: repo, network: true, extraHeader: 'AUTHORIZATION: basic eC1hY2Nlc3M=', timeoutMs: 30_000 }),
      ).rejects.toMatchObject({ code: 'CONFLICT', reason: 'GIT_CONFIG_UNSAFE' });
      // Pinned transports: same keys as a repository could set, so the runner's values win.
      const env = gitCli.buildEnv({ network: true });
      const pairs = Object.keys(env)
        .filter((k) => k.startsWith('GIT_CONFIG_KEY_'))
        .map((k) => `${env[k]}=${env[k.replace('KEY', 'VALUE')]}`);
      expect(pairs).toEqual(expect.arrayContaining(['protocol.ext.allow=never', 'protocol.file.allow=never', 'protocol.allow=never', 'protocol.https.allow=always']));
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 120_000);
});

describe('user-scope MCP registration', () => {
  it('refuses secrets and substitutes the Nuera headers helper', () => {
    expect(userScopeMcpConfig('figma', { type: 'http', url: 'https://mcp.figma.com/mcp' })).toEqual({ type: 'http', url: 'https://mcp.figma.com/mcp' });
    expect(String(userScopeMcpConfig('github', { type: 'http', url: 'https://x.test/mcp', headersHelper: 'nuera' }).headersHelper)).toContain('nuera-mcp-headers.mjs');
    expect(() => userScopeMcpConfig('x', { type: 'http', url: 'https://x.test', headers: { Authorization: 'Bearer y' } })).toThrow();
    expect(() => userScopeMcpConfig('x', { type: 'stdio', command: 'npx', env: { GITHUB_TOKEN: 'ghp_x' } })).toThrow();
    expect(() => userScopeMcpConfig('x', { type: 'http', url: 'https://user:pass@x.test/mcp' })).toThrow();
    expect(() => userScopeMcpConfig('x', { type: 'http', url: 'https://x.test', headersHelper: 'curl evil' })).toThrow();
  });
});

describe('redaction', () => {
  it('masks tokens in text', () => {
    const text = redactSecrets('AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46Z2hzXzEyMw== ghs_abcdefghijklmnopqrstuvwxyz https://user:pass@github.com/x');
    expect(text).not.toContain('eC1hY2Nl');
    expect(text).not.toContain('ghs_abcdefghijklmnop');
    expect(text).not.toContain(':pass@');
  });
});

describe('git parsers', () => {
  it('parses porcelain v2 status', () => {
    const out = [
      '# branch.oid 1234567890abcdef1234567890abcdef12345678',
      '# branch.head feature/crm-core',
      '# branch.upstream origin/feature/crm-core',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 abc abc src/modules/crm/PipelineBoard.tsx',
      '1 A. N... 000000 100644 100644 000 abc src/new file.ts',
      '2 R. N... 100644 100644 100644 abc abc R100 src/renamed.ts',
      'src/old.ts',
      'u UU N... 100644 100644 100644 100644 a b c conflict.ts',
      '? untracked.txt',
      '',
    ].join('\0');
    const status = parseStatusV2(out);
    expect(status.branch).toBe('feature/crm-core');
    expect(status.upstream).toBe('origin/feature/crm-core');
    expect(status.ahead).toBe(2);
    expect(status.behind).toBe(1);
    expect(status.files.map((f) => f.path)).toEqual(['src/modules/crm/PipelineBoard.tsx', 'src/new file.ts', 'src/renamed.ts', 'conflict.ts', 'untracked.txt']);
    expect(status.files[2]!.oldPath).toBe('src/old.ts');
    expect(status.counts).toEqual({ staged: 2, unstaged: 1, untracked: 1, conflicted: 1 });
  });

  it('parses numstat with renames and binaries', () => {
    const out = ['46\t12\tsrc/a.tsx', '-\t-\timg.png', '3\t1\t', 'old.ts', 'new.ts', ''].join('\0');
    expect(parseNumstatZ(out)).toEqual([
      { path: 'src/a.tsx', oldPath: null, insertions: 46, deletions: 12, binary: false },
      { path: 'img.png', oldPath: null, insertions: 0, deletions: 0, binary: true },
      { path: 'new.ts', oldPath: 'old.ts', insertions: 3, deletions: 1, binary: false },
    ]);
  });

  it('parses a unified diff into numbered hunks', () => {
    const diff = [
      'diff --git a/src/PipelineBoard.tsx b/src/PipelineBoard.tsx',
      'index 111..222 100644',
      '--- a/src/PipelineBoard.tsx',
      '+++ b/src/PipelineBoard.tsx',
      '@@ -12,4 +12,5 @@ export function PipelineBoard()',
      '   const stages = useStages(projectId);',
      '-  const total = deals.reduce(sum, 0);',
      '+  const totals = computeStageTotals(deals);',
      '+  const [dragged, setDragged] = useState(null);',
      ' ',
      '   return (',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.hunks).toHaveLength(1);
    const hunk = parsed.hunks[0]!;
    expect(hunk.context).toBe('export function PipelineBoard()');
    expect(hunk.lines.map((l) => [l.type, l.oldNumber, l.newNumber])).toEqual([
      ['context', 12, 12],
      ['del', 13, null],
      ['add', null, 13],
      ['add', null, 14],
      ['context', 14, 15],
      ['context', 15, 16],
    ]);
    expect(hunk.lines[5]!.noNewline).toBe(true);
    expect(parsed.insertions).toBe(2);
    expect(parsed.deletions).toBe(1);
    expect(parseUnifiedDiff('Binary files a/x.png and b/x.png differ\n').binary).toBe(true);
    expect(additionDiff('a\nb\n').hunks[0]!.lines).toHaveLength(2);
  });

  it('parses worktree list and push porcelain', () => {
    const list = parseWorktreeList('worktree /srv/dev/app\nHEAD abc\nbranch refs/heads/main\n\nworktree /srv/dev/.worktrees/app/x\nHEAD def\ndetached\n');
    expect(list).toEqual([
      { path: '/srv/dev/app', head: 'abc', branch: 'main', detached: false, bare: false, locked: false, prunable: false },
      { path: '/srv/dev/.worktrees/app/x', head: 'def', branch: null, detached: true, bare: false, locked: false, prunable: false },
    ]);
    const push = parsePushPorcelain('To https://github.com/a/b.git\n!\trefs/heads/x:refs/heads/x\t[rejected] (non-fast-forward)\nDone\n');
    expect(push[0]).toMatchObject({ flag: '!', to: 'refs/heads/x' });
  });

  it('parses clone progress (English and French) and splits live lines', () => {
    expect(parseProgressLine('Receiving objects:  64% (822/1284), 54.20 MiB | 10.00 MiB/s')).toMatchObject({ phase: 'receiving', percent: 64, bytes: Math.round(54.2 * 1024 * 1024) });
    expect(parseProgressLine("Réception d'objets: 100% (1284/1284), 84.2 Mio, fait.")).toMatchObject({ phase: 'receiving', percent: 100, overall: 80 });
    expect(parseProgressLine('Résolution des deltas: 50% (306/612)')?.overall).toBe(88);
    const stream = new ProgressStream();
    expect(stream.push("Clonage dans '/srv/dev/x'...\nReceiving objects:  10% (1/10)\r")).toEqual({ lines: ["Clonage dans '/srv/dev/x'..."], live: 'Receiving objects:  10% (1/10)' });
    expect(stream.push('Receiving objects: 100% (10/10), done.\n')).toEqual({ lines: ['Receiving objects: 100% (10/10), done.'], live: null });
  });

  it('detects the package manager and installed packages', () => {
    expect(detectPackageManager(new Set(['package.json', 'pnpm-lock.yaml']))).toEqual({ manager: 'pnpm', install: 'pnpm install --frozen-lockfile' });
    expect(detectPackageManager(new Set(['package.json', 'package-lock.json']))).toEqual({ manager: 'npm', install: 'npm ci' });
    expect(detectPackageManager(new Set(['README.md']))).toEqual({ manager: null, install: null });
    expect(parseInstalledPackages('added 912 packages, and audited 913 packages in 38s')).toBe(912);
  });
});

describe('test output parser', () => {
  it('reads Vitest summaries', () => {
    const report = parseTestOutput(' ✓ pipeline-totals.test.ts (6 tests) 41 ms\n\n Test Files  2 passed (2)\n      Tests  10 passed (10)\n   Duration  3.20s\n');
    expect(report?.counts).toMatchObject({ passed: 10, failed: 0, total: 10, durationMs: 3200, framework: 'vitest' });
  });

  it('reads Jest summaries', () => {
    const report = parseTestOutput('Tests:       1 failed, 9 passed, 10 total\nTime:        1.5 s\n');
    expect(report?.counts).toMatchObject({ passed: 9, failed: 1, total: 10, framework: 'jest', durationMs: 1500 });
  });

  it('reads Playwright live lines, re-runs and failures', () => {
    const parser = new TestOutputParser();
    parser.push('Running 24 tests using 4 workers\n');
    parser.push("  ✓  1 [chromium] › devis.spec.ts:12:5 › devis › création d'un devis (3.1s)\n");
    parser.push('  ✘  4 [chromium] › devis.spec.ts:84:5 › devis › export PDF (12.0s)\n');
    let report = parser.report();
    expect(report?.counts).toMatchObject({ passed: 1, failed: 1, running: 22, total: 24, framework: 'playwright' });
    expect(report?.tests[0]).toEqual({ name: "devis › création d'un devis", status: 'passed', durationMs: 3100, location: 'devis.spec.ts:12' });
    parser.push('  ✓  5 [chromium] › devis.spec.ts:84:5 › devis › export PDF (2.0s)\n');
    parser.push('  1) [chromium] › tests/e2e/devis.spec.ts:84:5 › devis › export PDF ──────\n');
    parser.push('    Error: expect(received).toContain(expected)\n    Expected substring: "Total"\n');
    parser.push('  1 failed\n  23 passed (31.2s)\n');
    report = parser.report({ finished: true });
    expect(report?.tests.map((t) => t.name)).toContain('devis › export PDF (relance)');
    expect(report?.counts).toMatchObject({ passed: 23, failed: 1, running: 0, durationMs: 31_200 });
    expect(report?.failures[0]).toMatchObject({ name: 'devis › export PDF', location: 'tests/e2e/devis.spec.ts:84' });
    expect(report?.failures[0]!.excerpt).toContain('Expected substring: "Total"');
  });

  it('returns null when nothing looks like test output', () => {
    expect(parseTestOutput('hello\nworld\n')).toBeNull();
  });

  it('detects dev server ports', () => {
    expect(detectPort('  ➜  Local:   http://localhost:5173/')).toBe(5173);
    expect(detectPort('\u001b[32mready\u001b[0m - started server on 0.0.0.0:3000')).toBe(3000);
    expect(detectPort('Listening on port 8080')).toBe(8080);
    expect(detectPort('no port here')).toBeNull();
  });
});

describe('tool lines', () => {
  const cwd = process.platform === 'win32' ? 'C:\\srv\\dev\\app' : '/srv/dev/app';
  const file = (rel: string) => (process.platform === 'win32' ? `${cwd}\\${rel.replace(/\//g, '\\')}` : `${cwd}/${rel}`);

  it('derives targets relative to the worktree', () => {
    expect(toolTarget('Read', { file_path: file('CLAUDE.md') }, cwd)).toBe('CLAUDE.md');
    expect(toolTarget('Bash', { command: 'npm run test -- crm' }, cwd)).toBe('npm run test -- crm');
    expect(toolTarget('Glob', { pattern: 'src/modules/crm/**/*.tsx' }, cwd)).toBe('src/modules/crm/**/*.tsx');
  });

  it('computes metas from tool responses', () => {
    expect(toolOutcome('Read', {}, { type: 'text', file: { numLines: 212 } }, 5, null).meta).toEqual({ kind: 'lines', count: 212 });
    expect(toolOutcome('Glob', {}, { filenames: ['a', 'b'], numFiles: 14 }, 5, null).meta).toEqual({ kind: 'matches', count: 14, unit: 'files' });
    expect(
      toolOutcome('Edit', {}, { structuredPatch: [{ lines: ['-a', '+b', '+c', ' d'] }] }, 5, null).meta,
    ).toEqual({ kind: 'diff', added: 2, removed: 1 });
    expect(toolOutcome('Write', { content: 'a\nb\nc\n' }, { type: 'create' }, 5, null).meta).toEqual({ kind: 'diff', added: 3, removed: 0 });
    expect(toolOutcome('Edit', { old_string: 'a\nb', new_string: 'a\nc\nd' }, {}, 5, null).meta).toEqual({ kind: 'diff', added: 2, removed: 1 });
    const bash = toolOutcome('Bash', { command: 'npm test' }, { stdout: '      Tests  10 passed (10)\n', stderr: '' }, 3200, null);
    expect(bash.meta).toMatchObject({ kind: 'command', exitCode: 0, durationMs: 3200 });
    expect(bash.tests?.counts.passed).toBe(10);
    const failed = toolOutcome('Bash', { command: 'npm run build' }, null, 900, 'Exit code 1\nType error');
    expect(failed.meta).toMatchObject({ kind: 'command', exitCode: 1 });
    expect(lineDiffCounts('a\nb\nc', 'a\nc')).toEqual({ added: 0, removed: 1 });
  });

  it('reads TodoWrite plans', () => {
    expect(planFromTodoWrite({ todos: [{ content: 'A', status: 'completed', activeForm: 'Fait A' }, { content: 'B', status: 'in_progress' }, { content: 'C' }] })).toEqual([
      { content: 'A', status: 'completed', activeForm: 'Fait A' },
      { content: 'B', status: 'in_progress', activeForm: null },
      { content: 'C', status: 'pending', activeForm: null },
    ]);
  });
});

describe('permissions copy', () => {
  it('titles requests in French by tool', () => {
    expect(permissionTitle('Bash')).toBe('Claude demande à exécuter une commande');
    expect(permissionTitle('Edit')).toBe('Claude demande à modifier un fichier');
    expect(permissionTitle('Write')).toBe('Claude demande à modifier un fichier');
    expect(permissionTitle('mcp__figma__get_code')).toBe('Claude demande à utiliser get_code (figma)');
  });

  it('builds the « Toujours pour … » label from the CLI suggestion', () => {
    expect(alwaysLabelFrom([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run test:*' }], behavior: 'allow', destination: 'localSettings' }], null)).toBe(
      'Toujours pour npm run test',
    );
    expect(alwaysLabelFrom(null, null)).toBeNull();
    expect(resolvedLabel('Bash', 'allowed', 'npm run test -- crm')).toBe('Commande autorisée une fois · npm run test -- crm');
    expect(resolvedLabel('Bash', 'denied', 'x')).toBe('Commande refusée · Claude a été prévenu');
  });
});

describe('session runtime', () => {
  it('wires every hook event and the status line, without secrets', () => {
    const settings = buildSettings({ permissionWaitSeconds: 120, denyRules: ['mcp__coolify__deploy'] }) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout: number }> }>>;
      statusLine: { command: string };
      disableClaudeAiConnectors: boolean;
      permissions: { deny: string[] };
    };
    expect(Object.keys(settings.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    expect(settings.hooks.PermissionRequest![0]!.hooks[0]!.timeout).toBe(150);
    expect(settings.hooks.PreToolUse![0]!.matcher).toBe('*');
    expect(settings.hooks.Stop![0]!.hooks[0]!.command).toContain('nuera-hook.mjs');
    expect(settings.statusLine.command).toContain('nuera-statusline.mjs');
    expect(settings.disableClaudeAiConnectors).toBe(true);
    expect(settings.permissions.deny).toEqual(['mcp__coolify__deploy']);
  });

  it('substitutes the Nuera headers helper and refuses arbitrary helpers', () => {
    const mcp = buildMcpConfig({ mcpServers: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { 'X-MCP-Readonly': 'true' }, headersHelper: 'nuera' } } }) as {
      mcpServers: Record<string, { headersHelper: string }>;
    };
    expect(mcp.mcpServers.github!.headersHelper).toContain('nuera-mcp-headers.mjs');
    expect(() => buildMcpConfig({ mcpServers: { x: { type: 'http', url: 'https://x.test/mcp', headersHelper: 'curl evil' as 'nuera' } } })).toThrow();
  });

  it('sanitises pasted instructions', () => {
    expect(sanitizeInstruction('ok\u001b[201~rm\u0007\r\nnext')).toBe('okrm\nnext');
  });

  it('names tmux sessions uniquely', () => {
    expect(tmuxSessionName('nuera-os', 'crm-core', new Set())).toBe('nuera-nuera-os-crm-core');
    expect(tmuxSessionName('a.b', 'c:d', new Set(['nuera-a-b-c-d']))).toBe('nuera-a-b-c-d-2');
  });

  it('whitelists the status line JSON (no cost estimate)', () => {
    const status = sanitizeStatusLine({
      model: { id: 'claude-x', display_name: 'Opus' },
      context_window: { used_percentage: 23, context_window_size: 200000 },
      rate_limits: { five_hour: { used_percentage: 12, resets_at: 1_800_000_000 } },
      cost: { total_cost_usd: 1.5, total_lines_added: 3 },
      version: '2.1.318',
    });
    expect(status?.model).toEqual({ id: 'claude-x', displayName: 'Opus' });
    expect(status?.rateLimits?.fiveHour).toEqual({ usedPercentage: 12, resetsAt: new Date(1_800_000_000_000).toISOString() });
    expect(JSON.stringify(status)).not.toContain('cost_usd');
    expect(status?.linesAdded).toBe(3);
  });

  it('extracts assistant texts from transcript lines tolerantly', () => {
    const line = JSON.stringify({ type: 'assistant', uuid: 'u1', timestamp: '2026-11-05T10:42:00Z', message: { id: 'm1', content: [{ type: 'text', text: 'Je lis.' }, { type: 'tool_use', name: 'Read' }] } });
    expect(extractAssistantTexts(line)).toEqual([{ key: 'assistant:u1:0', text: 'Je lis.', at: '2026-11-05T10:42:00Z' }]);
    expect(extractAssistantTexts(JSON.stringify({ type: 'assistant', isSidechain: true, uuid: 'u2', message: { content: [{ type: 'text', text: 'x' }] } }))).toEqual([]);
    expect(extractAssistantTexts('{broken')).toEqual([]);
    expect(extractAssistantTexts(JSON.stringify({ type: 'summary', summary: 'x' }))).toEqual([]);
  });
});

describe('claude CLI parsing', () => {
  it('whitelists auth status fields', () => {
    const auth = parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', accessToken: 'never' }), 0);
    expect(auth).toEqual({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', loginExpiresAt: null, email: null, organization: null });
    expect(JSON.stringify(auth)).not.toContain('never');
    expect(parseAuthStatus('{"loggedIn":false,"authMethod":"none"}', 1)?.loggedIn).toBe(false);
  });

  it('maps `claude mcp get` statuses', () => {
    expect(parseMcpGet('figma:\n  Status: ✔ Connected\n').state).toBe('connected');
    expect(parseMcpGet('figma:\n  Status: ! Needs authentication\n').state).toBe('needs_auth');
    expect(parseMcpGet('x:\n  Status: ✘ Failed to connect\n').state).toBe('failed');
    expect(parseMcpGet('No MCP server found with name: x').state).toBe('not_configured');
  });
});

describe('event bus', () => {
  it('replays by channel and detects ids from a previous instance', () => {
    const bus = new EventBus({ capacity: 3, seqBase: 1000 });
    const seen: number[] = [];
    const off = bus.subscribe(GLOBAL, (e) => seen.push(e.seq));
    bus.publish('heartbeat', {}, { channels: [GLOBAL] });
    bus.publish('heartbeat', {}, { channels: [sessionChannel('s')] });
    bus.publish('heartbeat', {}, { channels: [GLOBAL], replay: false });
    bus.publish('heartbeat', {}, { channels: [GLOBAL, sessionChannel('s')] });
    off();
    expect(seen).toEqual([1001, 1003, 1004]);
    expect(bus.replay(GLOBAL, 1001)!.map((e) => e.seq)).toEqual([1004]);
    expect(bus.replay(sessionChannel('s'), 1000)!.map((e) => e.seq)).toEqual([1002, 1004]);
    expect(bus.replay(GLOBAL, 999)).toBeNull();
    bus.publish('heartbeat', {}, { channels: [GLOBAL] });
    bus.publish('heartbeat', {}, { channels: [GLOBAL] });
    expect(bus.replay(GLOBAL, 1001)).toBeNull();
  });
});

describe('disk usage walk (du-like, bounded)', () => {
  it('sums the folder without following links, counts hard links once, and gives up past its budget', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nuera-du-'));
    const outside = mkdtempSync(path.join(os.tmpdir(), 'nuera-du-out-'));
    try {
      mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
      writeFileSync(path.join(root, 'a', 'one.bin'), Buffer.alloc(64 * 1024, 1));
      writeFileSync(path.join(root, 'a', 'b', 'two.bin'), Buffer.alloc(32 * 1024, 2));
      const base = await walkDiskUsage(root);
      expect(base).toBeGreaterThanOrEqual(96 * 1024);
      // A big file behind a symbolic link (here outside the root) is not walked; a hard link adds nothing.
      writeFileSync(path.join(outside, 'big.bin'), Buffer.alloc(4 * 1024 * 1024, 3));
      symlinkSync(outside, path.join(root, 'link'));
      linkSync(path.join(root, 'a', 'one.bin'), path.join(root, 'hard.bin'));
      const after = await walkDiskUsage(root);
      expect(after).not.toBeNull();
      expect(after! - base!).toBeLessThan(64 * 1024);
      expect(await walkDiskUsage(root, { entries: 2, ms: 10_000 })).toBeNull();
      expect(await walkDiskUsage(path.join(root, 'absent'))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('permission notification copy (Figma S5)', () => {
  it('names the session, the target and the project', () => {
    expect(permissionNotificationCopy({ sessionTitle: 'Tests e2e du devis', projectName: 'Nuera OS', target: 'npm run test -- e2e', requestTitle: 'Exécuter une commande' })).toEqual({
      title: 'Tests e2e du devis attend votre accord',
      body: 'npm run test -- e2e · Nuera OS · touchez pour répondre',
    });
    const fallback = permissionNotificationCopy({ sessionTitle: 'Export', projectName: null, target: '  ', requestTitle: 'Utiliser un outil MCP' });
    expect(fallback.body).toBe('Utiliser un outil MCP · touchez pour répondre');
    const long = permissionNotificationCopy({ sessionTitle: 'S', projectName: 'P', target: `rm -rf ${'x'.repeat(400)}\nsuite`, requestTitle: 'x' });
    expect(long.body.length).toBeLessThan(220);
    expect(long.body).toContain('… · P · touchez pour répondre');
  });
});
