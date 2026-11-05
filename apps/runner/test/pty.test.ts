import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseRunnerEvent, type RunnerEvent } from '@nuera/shared/events';
import { terminalEnv } from '../src/terminals/manager';
import type { Terminal, TerminalFrame } from '../src/terminals/terminal';
import { auth, dbReady, startTestRunner, waitFor, type TestEnv } from './helpers';

// A tiny line-oriented "shell": prints a banner, echoes every line, exits on "quit".
const ECHO_SCRIPT = [
  "process.stdout.write('pret\\r\\n');",
  "let buf = '';",
  "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (d) => {",
  "  for (const ch of d) {",
  "    if (ch === '\\r' || ch === '\\n') {",
  "      if (buf === 'quit') process.exit(3);",
  "      process.stdout.write('\\r\\necho:' + buf + '\\r\\n');",
  "      buf = '';",
  "    } else buf += ch;",
  "  }",
  "});",
].join('\n');

function collect(terminal: Terminal): { frames: TerminalFrame[]; text: () => string; stop: () => void } {
  const frames: TerminalFrame[] = [];
  const stop = terminal.subscribe((f) => frames.push(f));
  const text = () =>
    frames
      .map((f) => (f.type === 'terminal.snapshot' || f.type === 'terminal.data' ? f.data.data : ''))
      .join('');
  return { frames, text, stop };
}

describe.skipIf(!dbReady)('PTY terminals (@lydell/node-pty + @xterm/headless mirror)', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await startTestRunner();
  }, 600_000);

  afterAll(async () => {
    await env?.close();
  }, 120_000);

  it('spawns, writes, reads and serves a snapshot to a new subscriber', async () => {
    const terminal = env.runner.services.terminals.spawn({
      kind: 'shell',
      title: 'test',
      file: process.execPath,
      args: ['-e', ECHO_SCRIPT],
      cwd: env.root,
      env: terminalEnv(),
      cols: 80,
      rows: 24,
    });
    const first = collect(terminal);
    await waitFor(() => first.text().includes('pret'), { timeoutMs: 60_000, label: 'banner' });
    expect(first.frames[0]!.type).toBe('terminal.snapshot');
    terminal.write('bonjour\r');
    await waitFor(() => first.text().includes('echo:bonjour'), { timeoutMs: 30_000, label: 'echo' });
    first.stop();

    // A reconnecting client gets the screen back from the mirror, without replaying old chunks.
    const second = collect(terminal);
    await waitFor(() => second.frames.length > 0, { timeoutMs: 10_000, label: 'snapshot' });
    expect(second.frames[0]!.type).toBe('terminal.snapshot');
    const snap = second.frames[0] as Extract<TerminalFrame, { type: 'terminal.snapshot' }>;
    expect(snap.data.data).toContain('echo:bonjour');
    expect(snap.data.cols).toBe(80);
    expect(terminal.screenText()).toContain('echo:bonjour');

    terminal.resize(100, 30, 'client-a');
    expect(second.frames.some((f) => f.type === 'terminal.resize' && f.data.cols === 100)).toBe(true);
    terminal.write('encore\r');
    await waitFor(() => second.text().includes('echo:encore'), { timeoutMs: 30_000, label: 'live after snapshot' });

    terminal.write('quit\r');
    await waitFor(() => second.frames.find((f) => f.type === 'terminal.exit'), { timeoutMs: 30_000, label: 'exit' });
    const exit = second.frames.find((f) => f.type === 'terminal.exit') as Extract<TerminalFrame, { type: 'terminal.exit' }>;
    expect(exit.data.exitCode).toBe(3);
    second.stop();
  }, 180_000);

  it('streams snapshot then data over SSE and accepts input/resize through the API', async () => {
    const terminal = env.runner.services.terminals.spawn({
      kind: 'shell',
      title: 'sse',
      file: process.execPath,
      args: ['-e', ECHO_SCRIPT],
      cwd: env.root,
      env: terminalEnv(),
      cols: 80,
      rows: 24,
    });
    await waitFor(() => terminal.screenText().includes('pret'), { timeoutMs: 60_000, label: 'banner' });

    const abort = new AbortController();
    const response = await fetch(`${env.apiUrl}/v1/terminals/${terminal.id}/stream`, { headers: auth, signal: abort.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const events: RunnerEvent[] = [];
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index: number;
          while ((index = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const data = frame.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
            const event = data ? parseRunnerEvent(data) : null;
            if (event) events.push(event);
          }
        }
      } catch {
        // aborted
      }
    })();
    await waitFor(() => events.find((e) => e.type === 'terminal.snapshot'), { timeoutMs: 20_000, label: 'sse snapshot' });
    const input = await env.runner.api.inject({ method: 'POST', url: `/v1/terminals/${terminal.id}/input`, headers: { ...auth, 'content-type': 'application/json' }, payload: JSON.stringify({ data: 'via-api\r' }) });
    expect(input.statusCode).toBe(200);
    await waitFor(
      () => events.some((e) => e.type === 'terminal.data' && e.data.data.includes('echo:via-api')),
      { timeoutMs: 30_000, label: 'sse data' },
    );
    const resize = await env.runner.api.inject({ method: 'POST', url: `/v1/terminals/${terminal.id}/resize`, headers: { ...auth, 'content-type': 'application/json' }, payload: JSON.stringify({ cols: 90, rows: 20 }) });
    expect(resize.statusCode).toBe(200);
    expect(terminal.cols).toBe(90);
    abort.abort();
    await pump;
    const closed = await env.runner.api.inject({ method: 'DELETE', url: `/v1/terminals/${terminal.id}`, headers: auth });
    expect(closed.statusCode).toBe(200);
    const gone = await env.runner.api.inject({ method: 'GET', url: `/v1/terminals/${terminal.id}`, headers: auth });
    expect(gone.statusCode).toBe(404);
  }, 180_000);
});
