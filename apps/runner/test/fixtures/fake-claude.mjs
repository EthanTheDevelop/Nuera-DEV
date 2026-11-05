#!/usr/bin/env node
// TEST-ONLY fake of the Claude Code CLI (selected with NUERA_CLAUDE_BIN in the runner tests).
// It is NOT used outside tests. It mimics what the runner relies on:
// - `--version`, `auth status --json`, `agents --json`, `mcp get <name>`;
// - interactive mode in a PTY: reads `--settings`, runs the configured hook commands with
//   realistic payloads (SessionStart, UserPromptSubmit on each submitted line, PreToolUse /
//   PostToolUse for Read/Edit/Bash, TodoWrite plan, PermissionRequest waiting for a decision,
//   Stop with last_assistant_message, SessionEnd), writes a transcript JSONL, calls the status line.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const out = (text) => process.stdout.write(text);

if (argv[0] === '--version') {
  out('2.1.999 (Claude Code)\n');
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  if (process.env.FAKE_CLAUDE_LOGGED_OUT === '1') {
    out(JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }));
    process.exit(1);
  }
  out(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', email: 'owner@example.com' }));
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
if (argv[0] === 'auth' && argv[1] === 'login') {
  out('Ouvrez ce lien pour vous connecter : https://claude.ai/oauth/authorize?fake=1\nPaste code here if prompted > ');
  process.stdin.once('data', () => {
    out('\nLogin successful\n');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 60_000).unref();
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
  const base = { session_id: sessionId, transcript_path: transcript, cwd, permission_mode: flag('--permission-mode') ?? 'default' };

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
      model: { id: 'claude-fake-1', display_name: 'Fake Opus' },
      version: '2.1.999',
      context_window: { used_percentage: 23, context_window_size: 200000 },
      rate_limits: { five_hour: { used_percentage: 12, resets_at: Math.floor(Date.now() / 1000) + 3600 } },
      cost: { total_cost_usd: 1.23, total_duration_ms: 4200, total_lines_added: 3, total_lines_removed: 1 },
    }, 5);
    statusText = r.stdout.trim();
  }

  let statusText = '';
  const prompt = () => out(`\r\n${statusText ? `[${statusText}] ` : ''}> `);

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

  out(`Fake Claude Code ${resumeId ? '(reprise)' : ''}\r\n`);
  await hook('SessionStart', { source: resumeId ? 'resume' : 'startup', model: 'claude-fake-1' });
  await statusLine();
  prompt();
  markReady();

  let toolCounter = 0;
  const nextToolId = () => `toolu_${++toolCounter}_${Math.random().toString(36).slice(2, 8)}`;

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
    await hook('UserPromptSubmit', { prompt: text, prompt_id: randomUUID() });
    writeTranscript({ type: 'user', message: { role: 'user', content: text } });
    if (text.includes('scenario:full')) await scenarioFull(text);
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
