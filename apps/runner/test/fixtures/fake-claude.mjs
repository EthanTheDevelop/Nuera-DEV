#!/usr/bin/env node
// TEST-ONLY fake of the Claude Code CLI (selected with NUERA_CLAUDE_BIN in the runner tests).
// It is NOT used outside tests. It mimics what the runner relies on:
// - `--version`, `auth status --json`, `agents --json`, `mcp get <name>`;
// - interactive mode in a PTY: reads `--settings`, runs the configured hook commands with
//   realistic payloads (SessionStart, UserPromptSubmit on each submitted line, PreToolUse /
//   PostToolUse for Read/Edit/Bash, TodoWrite plan, PermissionRequest waiting for a decision,
//   Stop with last_assistant_message, SessionEnd), writes a transcript JSONL, calls the status line.
//
// Local test stack extensions (apps/web/e2e/harness), active ONLY when CLAUDE_CONFIG_DIR is set
// (the stack gives an isolated one; the real ~/.claude is never read nor written):
// - `<CLAUDE_CONFIG_DIR>/nuera-fake-claude.json` holds the fake login state: `auth status` reads
//   it, `auth login` (after a code is typed) / `auth logout` write it;
// - `<CLAUDE_CONFIG_DIR>/nuera-fake-scenarios/<name>.json` are scripted turns run for an
//   instruction containing `scenario:<name>` (plan, say, read, grep, glob, edit, write, remove,
//   bash — optionally really executed —, wait — long step with streaming output, cancelled by
//   Échap —, fail, final). Edits really change the worktree, so diffs exist;
// - `/status` and `/usage` print a status block (claude-status terminals), `mcp login` waits for a code;
// - the process exits when its terminal closes or its parent disappears (no orphan after a kill).
// - Maj+Tab (`ESC [ Z`) cycles the permission mode like the real CLI (default → acceptEdits → plan →
//   auto, `--permission-mode` first) and redraws its footer (« ⏵⏵ accept edits on (shift+tab to
//   cycle) »; nothing in Manual); hooks then carry the new `permission_mode`;
// - `/model <alias>` (local, no hook) prints « Set model to <alias> » and the status line reports it.
//
// Usage limit (runner tests and test stack): `scenario:limit` (optionally `scenario:limit:<seconds>`,
// default 3600) or a scripted `{ fail: { error: 'rate_limit', resetInSeconds } }` starts a limit that
// resets after that delay. Until then EVERY prompt stops like the real CLI: the limit notice
// (« 5-hour limit reached ∙ resets 3:45pm (Europe/Paris) ») printed and written in the transcript as
// a CLI message (`isApiErrorMessage`), `StopFailure` (`error: rate_limit`) and a status line whose
// five-hour window is used at 100 % with its `resets_at`. The reset time is kept in
// `<CLAUDE_CONFIG_DIR>/nuera-fake-limit/<session>.json`, so a resumed conversation still hits it.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const out = (text) => process.stdout.write(text);

// Test stack only: login state and scripts live in the isolated CLAUDE_CONFIG_DIR.
const harnessDir = process.env.CLAUDE_CONFIG_DIR?.trim() || null;
const MARKER = harnessDir ? path.join(harnessDir, 'nuera-fake-claude.json') : null;
function readMarker() {
  if (!MARKER) return {};
  try {
    return JSON.parse(readFileSync(MARKER, 'utf8'));
  } catch {
    return {};
  }
}
function writeMarker(patch) {
  if (!MARKER) return;
  mkdirSync(path.dirname(MARKER), { recursive: true });
  writeFileSync(MARKER, `${JSON.stringify({ ...readMarker(), ...patch, updatedAt: new Date().toISOString() }, null, 2)}\n`);
}

if (argv[0] === '--version') {
  out('2.1.999 (Claude Code)\n');
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  const marker = readMarker();
  if (process.env.FAKE_CLAUDE_LOGGED_OUT === '1' || marker.loggedIn === false) {
    out(JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }));
    process.exit(1);
  }
  out(JSON.stringify({ loggedIn: true, authMethod: marker.authMethod ?? 'claude.ai', apiProvider: 'firstParty', subscriptionType: marker.subscriptionType ?? 'max', email: marker.email ?? 'owner@example.com' }));
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'logout') {
  writeMarker({ loggedIn: false });
  out('Successfully logged out from your Anthropic account.\n');
  process.exit(0);
}
if (argv[0] === 'agents') {
  out('[]');
  process.exit(0);
}
if (argv[0] === 'mcp' && argv[1] === 'get') {
  out(`${argv[2]}:\n  Scope: User config\n  Status: ✔ Connected\n  Type: http\n  URL: https://mcp.example.test/mcp\n`);
  process.exit(0);
}
if (argv[0] === 'mcp' && (argv[1] === 'add-json' || argv[1] === 'remove')) {
  out(`ok ${argv[1]} ${argv[argv.indexOf('--scope') + 2] ?? ''}\n`);
  process.exit(0);
}
if (argv[0] === 'mcp' && argv[1] === 'login') {
  out(`Authentification du serveur MCP « ${argv[2] ?? '?'} » : ouvrez https://mcp.example.test/oauth/authorize?fake=1\nPaste the authorization code > `);
  process.stdin.once('data', () => {
    out('\nAuthentication successful\n');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 300_000).unref();
} else if (argv[0] === 'auth' && argv[1] === 'login') {
  out('Ouvrez ce lien pour vous connecter : https://claude.ai/oauth/authorize?fake=1\nPaste code here if prompted > ');
  process.stdin.once('data', () => {
    writeMarker({ loggedIn: true, authMethod: 'claude.ai' });
    out('\nLogin successful\n');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), harnessDir ? 300_000 : 60_000).unref();
} else {
  void interactive();
}

function flag(name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1] ?? null;
}

async function interactive() {
  const resumeId = flag('--resume');
  const sessionId = resumeId ?? flag('--session-id') ?? randomUUID();
  const settingsFile = flag('--settings');
  const settings = settingsFile && existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
  const hooks = settings.hooks ?? {};
  const cwd = process.cwd();
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const projectDir = path.join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-').slice(0, 200));
  mkdirSync(projectDir, { recursive: true });
  const transcript = path.join(projectDir, `${sessionId}.jsonl`);
  if (!existsSync(transcript)) writeFileSync(transcript, '');
  // Runner tests: the trusted variables this CLI received (Claude config dir, Git identity).
  if (harnessDir) {
    const envDir = path.join(harnessDir, 'nuera-fake-env');
    mkdirSync(envDir, { recursive: true });
    const keys = ['CLAUDE_CONFIG_DIR', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
    writeFileSync(path.join(envDir, `${sessionId}.json`), JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]))));
    // What a real CLI would load at this launch (configuration commune): flags, settings rules and
    // env, MCP servers, appended system prompt, user-level rules and skills of the config dir.
    const read = (file) => {
      try {
        return file && existsSync(file) ? readFileSync(file, 'utf8') : null;
      } catch {
        return null;
      }
    };
    const mcpFile = flag('--mcp-config');
    let mcpServers = [];
    try {
      mcpServers = Object.keys(JSON.parse(read(mcpFile) ?? '{}').mcpServers ?? {});
    } catch {
      mcpServers = [];
    }
    const skillsDir = path.join(harnessDir, 'skills');
    const skills = existsSync(skillsDir)
      ? readdirSync(skillsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && existsSync(path.join(skillsDir, entry.name, 'SKILL.md')))
          .map((entry) => ({ name: entry.name, common: existsSync(path.join(skillsDir, entry.name, '.nuera-commun.json')) }))
      : [];
    const launchDir = path.join(harnessDir, 'nuera-fake-launch');
    mkdirSync(launchDir, { recursive: true });
    writeFileSync(
      path.join(launchDir, `${sessionId}.json`),
      JSON.stringify({
        argv,
        permissions: settings.permissions ?? {},
        settingsEnv: settings.env ?? {},
        mcpServers,
        appendSystemPrompt: read(flag('--append-system-prompt-file')),
        userRules: read(path.join(harnessDir, 'rules', 'nuera-commun.md')),
        skills,
        at: new Date().toISOString(),
      }),
    );
  }
  const base = { session_id: sessionId, transcript_path: transcript, cwd, permission_mode: flag('--permission-mode') ?? 'default' };

  // Usage limit of this conversation (see the header): epoch ms of its reset, 0 = none.
  const limitFile = path.join(configDir, 'nuera-fake-limit', `${sessionId}.json`);
  const readLimit = () => {
    try {
      return Number(JSON.parse(readFileSync(limitFile, 'utf8')).resetsAt) || 0;
    } catch {
      return 0;
    }
  };
  const startLimit = (seconds) => {
    mkdirSync(path.dirname(limitFile), { recursive: true });
    writeFileSync(limitFile, JSON.stringify({ resetsAt: Date.now() + Math.max(1, seconds) * 1000 }));
  };
  const limitActive = () => readLimit() > Date.now();
  const resetClock = (ms) => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const clock = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: zone }).format(new Date(ms)).replace(/\s+/g, '').toLowerCase();
    return `${clock} (${zone})`;
  };

  const writeTranscript = (entry) => appendFileSync(transcript, `${JSON.stringify({ sessionId, timestamp: new Date().toISOString(), uuid: randomUUID(), ...entry })}\n`);
  const assistantText = (text) => writeTranscript({ type: 'assistant', message: { id: `msg_${randomUUID()}`, role: 'assistant', content: [{ type: 'text', text }] } });

  function runCommand(command, input, timeoutSec) {
    return new Promise((resolve) => {
      const child = spawn(command, { shell: true, cwd, env: process.env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      let stdout = '';
      child.stdout.on('data', (d) => {
        stdout += d.toString('utf8');
      });
      const timer = setTimeout(() => child.kill(), (timeoutSec ?? 60) * 1000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout });
      });
      child.on('error', () => resolve({ code: -1, stdout: '' }));
      child.stdin.on('error', () => undefined);
      child.stdin.end(JSON.stringify(input));
    });
  }

  async function hook(event, payload, toolName) {
    const groups = hooks[event] ?? [];
    let output = '';
    for (const group of groups) {
      if (group.matcher && group.matcher !== '*' && toolName && !new RegExp(`^(${group.matcher})$`).test(toolName)) continue;
      for (const h of group.hooks ?? []) {
        if (h.type !== 'command') continue;
        const r = await runCommand(h.command, { ...base, hook_event_name: event, ...payload }, h.timeout);
        output += r.stdout;
      }
    }
    return output.trim();
  }

  async function statusLine() {
    if (!settings.statusLine?.command) return;
    const r = await runCommand(settings.statusLine.command, {
      session_id: sessionId,
      transcript_path: transcript,
      cwd,
      model: modelOverride ? { id: modelOverride, display_name: modelOverride } : { id: 'claude-fake-1', display_name: 'Fake Opus' },
      version: '2.1.999',
      context_window: { used_percentage: 23, context_window_size: 200000 },
      rate_limits: limitActive()
        ? { five_hour: { used_percentage: 100, resets_at: Math.floor(readLimit() / 1000) } }
        : { five_hour: { used_percentage: 12, resets_at: Math.floor(Date.now() / 1000) + 3600 } },
      cost: { total_cost_usd: 1.23, total_duration_ms: 4200, total_lines_added: 3, total_lines_removed: 1 },
    }, 5);
    statusText = r.stdout.trim();
  }

  let statusText = '';
  // Composer chips (header): current mode (Maj+Tab) and model typed with `/model`.
  const MODE_CYCLE = ['default', 'acceptEdits', 'plan', 'auto'];
  const MODE_FOOTERS = { acceptEdits: '⏵⏵ accept edits on (shift+tab to cycle)', plan: '⏸ plan mode on (shift+tab to cycle)', auto: '⏵⏵ auto mode on (shift+tab to cycle)' };
  let modelOverride = null;
  const footer = () => (MODE_FOOTERS[base.permission_mode] ? `\r\n${MODE_FOOTERS[base.permission_mode]}` : '');
  const prompt = () => out(`${footer()}\r\n${statusText ? `[${statusText}] ` : ''}> `);
  const cycleMode = () => {
    const at = MODE_CYCLE.indexOf(base.permission_mode);
    base.permission_mode = MODE_CYCLE[(at + 1) % MODE_CYCLE.length];
    out('\u001b[2J\u001b[H');
    prompt();
  };

  // A key typed in the terminal while the fake permission dialog is shown.
  let keyWaiter = null;
  // Cancels the step in progress on Échap (like the real CLI: no hook at all follows an interrupt).
  let cancelStep = null;
  const nextKey = () =>
    new Promise((resolve) => {
      keyWaiter = resolve;
    });

  // Input is captured (raw mode) before start-up; lines wait until the session is ready.
  let markReady;
  const ready = new Promise((resolve) => {
    markReady = resolve;
  });
  attachInput(ready);
  if (harnessDir) {
    // Test stack: never outlive the terminal or the runner (a stack is stopped with a tree kill).
    process.stdin.on('end', () => process.exit(0));
    const parent = process.ppid;
    setInterval(() => {
      try {
        process.kill(parent, 0);
      } catch (error) {
        if (error.code !== 'EPERM') process.exit(0);
      }
    }, 5000).unref();
  }

  out(`Fake Claude Code ${resumeId ? '(reprise)' : ''}\r\n`);
  await hook('SessionStart', { source: resumeId ? 'resume' : 'startup', model: 'claude-fake-1' });
  await statusLine();
  prompt();
  markReady();

  let toolCounter = 0;
  const nextToolId = () => `toolu_${++toolCounter}_${Math.random().toString(36).slice(2, 8)}`;

  // ------------------------------------------------------------------------------------------
  // Test stack: scripted turns (`scenario:<name>` → <CLAUDE_CONFIG_DIR>/nuera-fake-scenarios/<name>.json)
  // ------------------------------------------------------------------------------------------
  const permissionMode = flag('--permission-mode') ?? 'default';
  const AUTO_EDIT_MODES = new Set(['acceptEdits', 'auto', 'bypassPermissions', 'dontAsk']);
  const AUTO_ALL_MODES = new Set(['bypassPermissions', 'dontAsk']);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const absolute = (file) => (path.isAbsolute(file) ? file : path.join(cwd, file));
  const posixRelative = (abs) => path.relative(cwd, abs).split(path.sep).join('/');
  const toTerminal = (text) => text.replace(/\r?\n/g, '\r\n');

  const scriptsDir = harnessDir ? path.join(harnessDir, 'nuera-fake-scenarios') : null;
  function loadScript(name) {
    const file = path.join(scriptsDir, `${name}.json`);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }
  /** `scenario:<name>` in the instruction, else a script whose `match` phrases appear in it. */
  function scriptFor(text) {
    if (!scriptsDir) return null;
    const explicit = /scenario:([a-z0-9][a-z0-9-]{0,63})/.exec(text);
    if (explicit) return ['full', 'long', 'fail'].includes(explicit[1]) ? null : loadScript(explicit[1]);
    let names = [];
    try {
      names = readdirSync(scriptsDir).filter((name) => name.endsWith('.json')).sort();
    } catch {
      return null;
    }
    const lower = text.toLowerCase();
    for (const name of names) {
      const script = loadScript(name.slice(0, -5));
      if (Array.isArray(script?.match) && script.match.some((phrase) => lower.includes(String(phrase).toLowerCase()))) return script;
    }
    return null;
  }

  function walk(dir, files = []) {
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return files;
    }
    for (const name of entries) {
      if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
      const abs = path.join(dir, name);
      let info;
      try {
        info = statSync(abs);
      } catch {
        continue;
      }
      if (info.isDirectory()) walk(abs, files);
      else files.push(abs);
    }
    return files;
  }

  function globToRegExp(pattern) {
    let source = '';
    for (let i = 0; i < pattern.length; i += 1) {
      const c = pattern[i];
      if (c === '*' && pattern[i + 1] === '*') {
        source += '.*';
        i += pattern[i + 2] === '/' ? 2 : 1;
      } else if (c === '*') source += '[^/]*';
      else if (c === '?') source += '[^/]';
      else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${source}$`);
  }

  /** Line diff (LCS) as a `structuredPatch` hunk, so the runner shows the real « +3 −2 ». */
  function lineDiff(before, after) {
    const a = before.split('\n');
    const b = after.split('\n');
    const dp = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
    for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const lines = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        lines.push(` ${a[i]}`);
        i += 1;
        j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) lines.push(`-${a[i++]}`);
      else lines.push(`+${b[j++]}`);
    }
    while (i < a.length) lines.push(`-${a[i++]}`);
    while (j < b.length) lines.push(`+${b[j++]}`);
    return [{ oldStart: 1, oldLines: a.length, newStart: 1, newLines: b.length, lines }];
  }

  async function askPermission(tool, input, suggestions, label) {
    const raw = await hook('PermissionRequest', { tool_name: tool, tool_input: input, permission_suggestions: suggestions }, tool);
    let behavior = null;
    if (raw) {
      try {
        behavior = JSON.parse(raw).hookSpecificOutput?.decision?.behavior ?? null;
      } catch {
        behavior = null;
      }
    }
    if (!behavior) {
      out(`\r\nAutoriser ${label} ? (o/n) `);
      behavior = (await nextKey()) === 'o' ? 'allow' : 'deny';
    }
    return behavior;
  }

  /** Pre → (permission) → perform → Post/PostFailure. */
  async function toolStep(tool, input, perform, options) {
    const id = nextToolId();
    await hook('PreToolUse', { tool_name: tool, tool_input: input, tool_use_id: id }, tool);
    out(`● ${tool}(${options.label})\r\n`);
    if (options.ask) {
      const behavior = await askPermission(tool, input, options.suggestions, options.label);
      if (behavior !== 'allow') return { denied: true };
    }
    const started = Date.now();
    let result;
    try {
      result = await perform();
    } catch (error) {
      result = { failed: true, error: String(error?.message ?? error) };
    }
    const duration = options.durationMs ?? result.durationMs ?? Math.max(5, Date.now() - started);
    if (result.failed) {
      await hook('PostToolUseFailure', { tool_name: tool, tool_input: input, tool_use_id: id, error: result.error, is_interrupt: false, duration_ms: duration }, tool);
    } else {
      await hook('PostToolUse', { tool_name: tool, tool_input: input, tool_response: result.response, tool_use_id: id, duration_ms: duration }, tool);
    }
    return { denied: false, failed: Boolean(result.failed) };
  }

  function runShell(command, timeoutSec) {
    return new Promise((resolve) => {
      const child = spawn(command, { shell: true, cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => {
        stdout += d.toString('utf8');
        out(toTerminal(d.toString('utf8')));
      });
      child.stderr.on('data', (d) => {
        stderr += d.toString('utf8');
        out(toTerminal(d.toString('utf8')));
      });
      const timer = setTimeout(() => child.kill(), (timeoutSec ?? 300) * 1000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout: stdout.slice(-64 * 1024), stderr: stderr.slice(-16 * 1024) });
      });
      child.on('error', (error) => resolve({ code: 127, stdout: '', stderr: String(error.message) }));
    });
  }

  const defaultSuggestions = (tool, value) =>
    tool === 'Bash'
      ? [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: `${value.split(/\s+/).slice(0, 3).join(' ')}:*` }], behavior: 'allow', destination: 'localSettings' }]
      : [{ type: 'addRules', rules: [{ toolName: 'Edit', ruleContent: `${value.split('/')[0]}/**` }], behavior: 'allow', destination: 'localSettings' }];

  /** The turn stops on the usage limit, as the real CLI does. */
  async function hitLimit() {
    const notice = `5-hour limit reached ∙ resets ${resetClock(readLimit())}`;
    writeTranscript({ type: 'assistant', isApiErrorMessage: true, message: { id: `msg_${randomUUID()}`, role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: notice }] } });
    out(`\r\n⎿  ${notice}\r\n     /upgrade to increase your usage limit.\r\n`);
    // The failed request refreshed the status line (five-hour window at 100 %) before the turn ended.
    await statusLine();
    await hook('StopFailure', { error: 'rate_limit', error_details: notice });
  }

  async function finish(text) {
    assistantText(text);
    await hook('Stop', { last_assistant_message: text, stop_hook_active: false });
    await statusLine();
    out(`\r\n${text}\r\n`);
  }

  async function runScript(script) {
    const pace = typeof script.pace === 'number' ? script.pace : 250;
    let lastSaid = null;
    for (const step of script.steps ?? []) {
      if (pace) await sleep(pace);
      if (step.pause) {
        await sleep(step.pause);
      } else if (step.plan) {
        const todos = { todos: step.plan.map((item) => ({ content: item.content, status: item.status, activeForm: item.activeForm ?? item.content })) };
        const id = nextToolId();
        await hook('PreToolUse', { tool_name: 'TodoWrite', tool_input: todos, tool_use_id: id }, 'TodoWrite');
        await hook('PostToolUse', { tool_name: 'TodoWrite', tool_input: todos, tool_response: {}, tool_use_id: id }, 'TodoWrite');
      } else if (step.say) {
        lastSaid = step.say;
        assistantText(step.say);
        out(`\r\n${step.say}\r\n`);
      } else if (step.read) {
        const file = absolute(step.read);
        await toolStep('Read', { file_path: file }, async () => {
          if (!existsSync(file)) return { failed: true, error: 'File does not exist.' };
          const content = readFileSync(file, 'utf8');
          const lines = content ? content.split('\n').length - (content.endsWith('\n') ? 1 : 0) : 0;
          return { response: { type: 'text', file: { filePath: file, content, numLines: lines, startLine: 1, totalLines: lines } } };
        }, { label: step.read, durationMs: step.durationMs ?? 12 });
      } else if (step.grep) {
        const dir = absolute(step.grep.path ?? '.');
        const regex = new RegExp(step.grep.pattern, step.grep.ignoreCase ? 'i' : '');
        await toolStep('Grep', { pattern: step.grep.pattern, path: dir, output_mode: 'files_with_matches' }, async () => {
          const filenames = walk(dir).filter((file) => {
            try {
              return regex.test(readFileSync(file, 'utf8'));
            } catch {
              return false;
            }
          });
          return { response: { mode: 'files_with_matches', filenames, numFiles: filenames.length } };
        }, { label: step.grep.pattern, durationMs: 20 });
      } else if (step.glob) {
        const regex = globToRegExp(step.glob.pattern);
        await toolStep('Glob', { pattern: step.glob.pattern }, async () => {
          const filenames = walk(cwd).filter((file) => regex.test(posixRelative(file)));
          return { response: { filenames, numFiles: filenames.length, durationMs: 9, truncated: false } };
        }, { label: step.glob.pattern, durationMs: 9 });
      } else if (step.edit || step.write || step.remove) {
        const spec = step.edit ?? step.write ?? step.remove;
        const file = absolute(spec.file);
        const ask = step.ask ?? !AUTO_EDIT_MODES.has(permissionMode);
        const suggestions = step.suggestions ?? defaultSuggestions('Edit', spec.file);
        let result;
        if (step.edit) {
          const input = { file_path: file, old_string: spec.old, new_string: spec.new, replace_all: false };
          result = await toolStep('Edit', input, async () => {
            const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
            if (before === null) return { failed: true, error: 'File does not exist.' };
            if (!before.includes(spec.old)) return { failed: true, error: 'String to replace not found in file.' };
            writeFileSync(file, before.replace(spec.old, spec.new));
            return { response: { filePath: file, oldString: spec.old, newString: spec.new, originalFile: before, structuredPatch: lineDiff(spec.old, spec.new), userModified: false, replaceAll: false } };
          }, { label: spec.file, ask, suggestions, durationMs: 30 });
        } else if (step.write) {
          const input = { file_path: file, content: spec.content };
          result = await toolStep('Write', input, async () => {
            const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(file, spec.content);
            return { response: { type: before === null ? 'create' : 'update', filePath: file, content: spec.content, structuredPatch: before === null ? [] : lineDiff(before, spec.content), originalFile: before } };
          }, { label: spec.file, ask, suggestions, durationMs: 25 });
        } else {
          const command = `rm ${spec.file}`;
          const input = { command, description: spec.description ?? `Supprime ${spec.file}` };
          result = await toolStep('Bash', input, async () => {
            if (!existsSync(file)) return { failed: true, error: `Exit code 1\nrm: cannot remove '${spec.file}': No such file or directory` };
            unlinkSync(file);
            return { response: { stdout: '', stderr: '', interrupted: false, isImage: false } };
          }, { label: command, ask: step.ask ?? !AUTO_ALL_MODES.has(permissionMode), suggestions: step.suggestions ?? defaultSuggestions('Bash', command), durationMs: 40 });
        }
        if (result.denied) return finish(script.denied ?? "D'accord, je n'applique pas ce changement et je m'arrête là.");
      } else if (step.bash) {
        const spec = step.bash;
        const input = { command: spec.command, description: spec.description ?? null, ...(spec.timeoutSec ? { timeout: spec.timeoutSec * 1000 } : {}) };
        const result = await toolStep('Bash', input, async () => {
          if (spec.run) {
            const started = Date.now();
            const r = await runShell(spec.command, spec.timeoutSec);
            const combined = [r.stdout, r.stderr].filter(Boolean).join('\n');
            if (r.code !== 0) return { failed: true, error: `Exit code ${r.code}\n${combined}`, durationMs: Date.now() - started };
            return { response: { stdout: r.stdout, stderr: r.stderr, interrupted: false, isImage: false }, durationMs: Date.now() - started };
          }
          const output = spec.output ?? '';
          out(toTerminal(output));
          if ((spec.exitCode ?? 0) !== 0) return { failed: true, error: `Exit code ${spec.exitCode}\n${output}` };
          return { response: { stdout: output, stderr: '', interrupted: false, isImage: false } };
        }, { label: spec.command, ask: step.ask ?? !AUTO_ALL_MODES.has(permissionMode), suggestions: step.suggestions ?? defaultSuggestions('Bash', spec.command), durationMs: spec.durationMs });
        if (result.denied) return finish(script.denied ?? "D'accord, je ne lance pas cette commande.");
      } else if (step.wait) {
        // Long step (dev server, watch mode): streaming output until done or Échap.
        const spec = step.wait;
        const id = nextToolId();
        const input = { command: spec.command, description: spec.description ?? null };
        await hook('PreToolUse', { tool_name: 'Bash', tool_input: input, tool_use_id: id }, 'Bash');
        out(`● Bash(${spec.command})\r\n`);
        const lines = spec.output?.length ? spec.output : [];
        let index = 0;
        const printed = [];
        const ticker = lines.length
          ? setInterval(() => {
              const line = lines[index % lines.length];
              index += 1;
              printed.push(line);
              out(`${toTerminal(line)}\r\n`);
            }, Math.max(1, spec.every ?? 5) * 1000)
          : null;
        const cancelled = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), Math.max(1, spec.seconds ?? 120) * 1000);
          cancelStep = () => {
            clearTimeout(timer);
            resolve(true);
          };
        });
        cancelStep = null;
        if (ticker) clearInterval(ticker);
        // Claude Code runs neither PostToolUse(Failure) nor Stop after a user interrupt.
        if (cancelled) return;
        await hook('PostToolUse', { tool_name: 'Bash', tool_input: input, tool_response: { stdout: printed.slice(-200).join('\n'), stderr: '', interrupted: false, isImage: false }, tool_use_id: id, duration_ms: (spec.seconds ?? 120) * 1000 }, 'Bash');
      } else if (step.fail) {
        if (step.fail.error === 'rate_limit' && typeof step.fail.resetInSeconds === 'number') {
          startLimit(step.fail.resetInSeconds);
          await hitLimit();
          return;
        }
        await hook('StopFailure', { error: step.fail.error, error_details: step.fail.details ?? null });
        return;
      } else if (step.final) {
        return finish(step.final);
      }
    }
    return finish(lastSaid ?? 'Terminé.');
  }

  function printStatus(command) {
    const marker = readMarker();
    const loggedIn = marker.loggedIn !== false;
    const lines =
      command === '/status'
        ? [
            ' Claude Code v2.1.999 (faux CLI de test)',
            '',
            ` Session ID: ${sessionId}`,
            ` cwd: ${cwd}`,
            ` Login method: ${loggedIn ? 'Claude Max Account' : 'Not logged in · run /login'}`,
            ...(loggedIn ? [` Email: ${marker.email ?? 'owner@example.com'}`] : []),
            ' Model: Fake Opus',
          ]
        : [' Usage: not available in the test CLI.'];
    out(`\r\n${lines.join('\r\n')}\r\n`);
  }

  async function scenarioFull(promptText) {
    const todos = (done) => ({
      todos: [
        { content: 'Lire CLAUDE.md', status: done > 0 ? 'completed' : 'in_progress', activeForm: 'Lecture de CLAUDE.md' },
        { content: 'Modifier src/index.ts', status: done > 1 ? 'completed' : done === 1 ? 'in_progress' : 'pending', activeForm: 'Modification de src/index.ts' },
        { content: 'Lancer les tests', status: done > 2 ? 'completed' : done === 2 ? 'in_progress' : 'pending', activeForm: 'Lancement des tests' },
      ],
    });
    const todoId = nextToolId();
    await hook('PreToolUse', { tool_name: 'TodoWrite', tool_input: todos(0), tool_use_id: todoId }, 'TodoWrite');
    await hook('PostToolUse', { tool_name: 'TodoWrite', tool_input: todos(0), tool_response: {}, tool_use_id: todoId }, 'TodoWrite');

    assistantText("Je lis d'abord les conventions du dépôt.");
    const readId = nextToolId();
    const claudeMd = path.join(cwd, 'CLAUDE.md');
    const content = existsSync(claudeMd) ? readFileSync(claudeMd, 'utf8') : '';
    const lines = content ? content.split('\n').length - (content.endsWith('\n') ? 1 : 0) : 0;
    await hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: claudeMd }, tool_use_id: readId }, 'Read');
    out('● Read(CLAUDE.md)\r\n');
    await hook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: claudeMd }, tool_response: { type: 'text', file: { filePath: claudeMd, content, numLines: lines, startLine: 1, totalLines: lines } }, tool_use_id: readId, duration_ms: 12 }, 'Read');

    const todo2 = nextToolId();
    await hook('PreToolUse', { tool_name: 'TodoWrite', tool_input: todos(1), tool_use_id: todo2 }, 'TodoWrite');
    const editId = nextToolId();
    const target = path.join(cwd, 'src', 'index.ts');
    const editInput = { file_path: target, old_string: 'export const answer = 42;', new_string: 'export const answer = 43;\nexport const question = "?";' };
    await hook('PreToolUse', { tool_name: 'Edit', tool_input: editInput, tool_use_id: editId }, 'Edit');
    const decisionRaw = await hook('PermissionRequest', {
      tool_name: 'Edit',
      tool_input: editInput,
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Edit', ruleContent: 'src/**' }], behavior: 'allow', destination: 'localSettings' }],
    }, 'Edit');
    let behavior = null;
    if (decisionRaw) {
      try {
        behavior = JSON.parse(decisionRaw).hookSpecificOutput?.decision?.behavior ?? null;
      } catch {
        behavior = null;
      }
    }
    if (!behavior) {
      out('\r\nAutoriser la modification ? (o/n) ');
      behavior = (await nextKey()) === 'o' ? 'allow' : 'deny';
    }
    if (behavior === 'allow') {
      const before = readFileSync(target, 'utf8');
      writeFileSync(target, before.replace(editInput.old_string, editInput.new_string));
      await hook('PostToolUse', {
        tool_name: 'Edit',
        tool_input: editInput,
        tool_response: { filePath: target, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-export const answer = 42;', '+export const answer = 43;', '+export const question = "?";'] }] },
        tool_use_id: editId,
        duration_ms: 30,
      }, 'Edit');
    }

    const bashId = nextToolId();
    const bashInput = { command: 'npm run test -- crm', description: 'Lance la suite de tests du module.' };
    await hook('PreToolUse', { tool_name: 'Bash', tool_input: bashInput, tool_use_id: bashId }, 'Bash');
    await hook('PostToolUse', {
      tool_name: 'Bash',
      tool_input: bashInput,
      tool_response: { stdout: '$ vitest run crm\n ✓ pipeline-totals.test.ts (6 tests) 41 ms\n\n Test Files  2 passed (2)\n      Tests  10 passed (10)\n   Duration  3.20s\n', stderr: '', interrupted: false, isImage: false },
      tool_use_id: bashId,
      duration_ms: 3200,
    }, 'Bash');

    const final = behavior === 'allow' ? "C'est terminé : les dix tests passent." : "Modification refusée : je m'arrête là.";
    assistantText(final);
    await hook('Stop', { last_assistant_message: final, stop_hook_active: false });
    await statusLine();
    out(`\r\n${final}\r\n`);
    void promptText;
  }

  // A long Bash step (dev server): finishes after 120 s unless Échap cancels it.
  async function scenarioLong() {
    const id = nextToolId();
    const input = { command: 'npm run dev', description: 'Serveur de développement.' };
    await hook('PreToolUse', { tool_name: 'Bash', tool_input: input, tool_use_id: id }, 'Bash');
    out('● Bash(npm run dev)\r\n');
    const cancelled = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 120_000);
      cancelStep = () => {
        clearTimeout(timer);
        resolve(true);
      };
    });
    cancelStep = null;
    if (cancelled) return; // Claude Code runs neither PostToolUse(Failure) nor Stop after a user interrupt.
    await hook('PostToolUse', { tool_name: 'Bash', tool_input: input, tool_response: { stdout: 'ready\n', stderr: '', interrupted: false }, tool_use_id: id, duration_ms: 120_000 }, 'Bash');
    await hook('Stop', { last_assistant_message: 'Serveur arrêté.' });
  }

  async function onLine(line) {
    const text = line.trim();
    if (!text) return;
    if (text === '/exit') {
      await hook('SessionEnd', { reason: 'prompt_input_exit' });
      out('\r\nAu revoir.\r\n');
      process.exit(0);
    }
    const model = /^\/model\s+(\S+)$/.exec(text);
    if (model) {
      // Local command: no UserPromptSubmit hook, like the real CLI.
      modelOverride = model[1];
      out(`\r\n  ⎿  Set model to ${modelOverride}\r\n`);
      await statusLine();
      prompt();
      return;
    }
    if (harnessDir && (text === '/status' || text === '/usage')) {
      // Local commands: no UserPromptSubmit hook, like the real CLI.
      printStatus(text);
      prompt();
      return;
    }
    await hook('UserPromptSubmit', { prompt: text, prompt_id: randomUUID() });
    writeTranscript({ type: 'user', message: { role: 'user', content: text } });
    const limitStart = /scenario:limit(?::(\d{1,6}))?(?![a-z0-9-])/.exec(text);
    if (limitStart) startLimit(limitStart[1] ? Number(limitStart[1]) : 3600);
    if (limitActive()) {
      await hitLimit();
      prompt();
      return;
    }
    const script = scriptFor(text);
    if (script) await runScript(script);
    else if (text.includes('scenario:full')) await scenarioFull(text);
    else if (text.includes('scenario:long')) await scenarioLong();
    else if (text.includes('scenario:fail')) {
      await hook('StopFailure', { error: 'rate_limit', error_details: 'You have hit your session limit' });
    } else {
      const reply = `Reçu : ${text}`;
      assistantText(reply);
      await hook('Stop', { last_assistant_message: reply });
      out(`\r\n${reply}\r\n`);
    }
    prompt();
  }

  function attachInput(readyPromise) {
    const START = '\u001b[200~';
    const END = '\u001b[201~';
    let buffer = '';
    let pasting = false;
    let pending = '';
    let escTimer = null;
    let busy = readyPromise;
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');

    const interrupt = () => {
      out("\r\nInterrompu par l'utilisateur.\r\n");
      if (cancelStep) cancelStep();
    };
    const consume = () => {
      while (pending.length) {
        if (pending[0] === '\u001b') {
          if (pending.startsWith('\u001b[Z')) {
            pending = pending.slice(3);
            cycleMode();
            continue;
          }
          if (pending.startsWith(START) || pending.startsWith(END)) {
            pasting = pending.startsWith(START);
            pending = pending.slice(START.length);
            continue;
          }
          if (pending.length < START.length && (START.startsWith(pending) || END.startsWith(pending))) {
            // Maybe a sequence split across two reads (ConPTY): wait a little before calling it Échap.
            escTimer = setTimeout(() => {
              escTimer = null;
              pending = pending.slice(1);
              interrupt();
              consume();
            }, 80);
            return;
          }
          pending = pending.slice(1);
          interrupt();
          continue;
        }
        const ch = pending[0];
        pending = pending.slice(1);
        if (!pasting && (ch === '\r' || ch === '\n')) {
          const line = buffer;
          buffer = '';
          busy = busy.then(() => onLine(line)).catch(() => undefined);
        } else if (ch === '\u0003') {
          process.exit(130);
        } else {
          buffer += ch;
          out(ch);
        }
      }
    };

    process.stdin.on('data', (chunk) => {
      if (keyWaiter && !chunk.startsWith('\u001b')) {
        const resolve = keyWaiter;
        keyWaiter = null;
        resolve(chunk.trim().toLowerCase());
        return;
      }
      if (escTimer) {
        clearTimeout(escTimer);
        escTimer = null;
      }
      pending += chunk;
      consume();
    });
  }
}
