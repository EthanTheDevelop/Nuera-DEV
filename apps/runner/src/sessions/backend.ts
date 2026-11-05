import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CommandSpec } from '../claude/bin';
import { RunnerError } from '../errors';
import { buildChildEnv } from '../safety/env';
import { execCommand, succeeded } from '../safety/exec';
import type { TerminalManager } from '../terminals/manager';
import { terminalEnv } from '../terminals/manager';
import type { Terminal } from '../terminals/terminal';

export interface SessionSpawnSpec {
  sessionId: string;
  title: string;
  cwd: string;
  worktreeId: string | null;
  cols: number;
  rows: number;
  claude: CommandSpec;
  args: string[];
  /** Variables specific to this session (NUERA_HOOK_URL, NUERA_SESSION_ID, MCP env…). */
  sessionEnv: Record<string, string>;
  /** tmux backend only: name of the tmux session. */
  tmuxName: string | null;
}

export interface SessionBackend {
  readonly kind: 'tmux' | 'pty';
  start(spec: SessionSpawnSpec): Promise<Terminal>;
  /** Process id of the CLI itself (tmux pane pid / direct PTY pid). */
  pid(terminal: Terminal, tmuxName: string | null): Promise<number | null>;
  /** Ends the CLI process (tmux kill-session / PTY kill). */
  kill(terminal: Terminal | null, tmuxName: string | null): Promise<void>;
  isAlive(terminal: Terminal | null, tmuxName: string | null): Promise<boolean>;
}

/** Direct PTY (Windows dev, or no tmux): the CLI dies with the runner. */
export class PtyBackend implements SessionBackend {
  readonly kind = 'pty' as const;
  constructor(private readonly terminals: TerminalManager) {}

  async start(spec: SessionSpawnSpec): Promise<Terminal> {
    return this.terminals.spawn({
      kind: 'session',
      title: spec.title,
      file: spec.claude.file,
      args: [...spec.claude.prefix, ...spec.args],
      cwd: spec.cwd,
      env: terminalEnv(spec.sessionEnv),
      cols: spec.cols,
      rows: spec.rows,
      worktreeId: spec.worktreeId,
      sessionId: spec.sessionId,
      scrollback: 10_000,
      idleTimeoutMs: null,
    });
  }

  async pid(terminal: Terminal): Promise<number | null> {
    for (let i = 0; i < 20 && !terminal.pid; i += 1) await new Promise((r) => setTimeout(r, 100));
    return terminal.pid;
  }

  async kill(terminal: Terminal | null): Promise<void> {
    terminal?.kill();
  }

  async isAlive(terminal: Terminal | null): Promise<boolean> {
    return Boolean(terminal?.alive);
  }
}

/**
 * tmux on a dedicated socket (`tmux -L nuera`, own config): sessions survive runner restarts and
 * web redeploys. The runner keeps one `tmux attach` PTY client per session. The owner can also
 * attach over SSH: `tmux -L nuera attach -t <name>`.
 */
export class TmuxBackend implements SessionBackend {
  readonly kind = 'tmux' as const;
  private readonly confFile: string;

  constructor(
    private readonly terminals: TerminalManager,
    dataDir: string,
    readonly socket = 'nuera',
  ) {
    this.confFile = path.join(dataDir, 'tmux.conf');
    writeFileSync(
      this.confFile,
      [
        '# Nuera Dev — tmux server dedicated to Claude Code sessions (socket "nuera").',
        'set -s escape-time 0',
        'set -g status off',
        'set -g history-limit 20000',
        'set -g mouse off',
        'set -g default-terminal "screen-256color"',
        "set -ga terminal-overrides ',xterm-256color:Tc'",
        'set -g remain-on-exit off',
        'set -g destroy-unattached off',
        'set -g window-size latest',
        '',
      ].join('\n'),
      'utf8',
    );
  }

  private base(): string[] {
    return ['-L', this.socket, '-f', this.confFile];
  }

  async run(args: string[], timeoutMs = 10_000) {
    return execCommand('tmux', [...this.base(), ...args], { env: buildChildEnv(), timeoutMs });
  }

  static async version(): Promise<string | null> {
    if (process.platform === 'win32') return null;
    const result = await execCommand('tmux', ['-V'], { env: buildChildEnv(), timeoutMs: 5000 });
    return succeeded(result) ? result.stdout.trim() : null;
  }

  async listSessions(): Promise<string[]> {
    const result = await this.run(['list-sessions', '-F', '#{session_name}']);
    if (!succeeded(result)) return [];
    return result.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }

  async hasSession(name: string): Promise<boolean> {
    return succeeded(await this.run(['has-session', '-t', `=${name}`]));
  }

  async start(spec: SessionSpawnSpec): Promise<Terminal> {
    if (!spec.tmuxName) throw new RunnerError('INTERNAL', 'Nom de session tmux manquant.');
    const envArgs = Object.entries({ TERM: 'screen-256color', COLORTERM: 'truecolor', ...spec.sessionEnv }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const result = await this.run(
      [
        'new-session',
        '-d',
        '-s',
        spec.tmuxName,
        '-x',
        String(spec.cols),
        '-y',
        String(spec.rows),
        '-c',
        spec.cwd,
        ...envArgs,
        '--',
        spec.claude.file,
        ...spec.claude.prefix,
        ...spec.args,
      ],
      20_000,
    );
    if (!succeeded(result)) {
      throw new RunnerError('INTERNAL', "tmux n'a pas pu démarrer la session.", { raw: `${result.stderr}${result.stdout}`.trim() });
    }
    return this.attach(spec.tmuxName, spec);
  }

  /** PTY client `tmux attach` (also used to re-attach after a runner restart). */
  attach(name: string, spec: Pick<SessionSpawnSpec, 'sessionId' | 'title' | 'cwd' | 'worktreeId' | 'cols' | 'rows'>): Terminal {
    return this.terminals.spawn({
      kind: 'session',
      title: spec.title,
      file: 'tmux',
      args: [...this.base(), 'attach-session', '-t', `=${name}`],
      cwd: spec.cwd,
      env: terminalEnv(),
      cols: spec.cols,
      rows: spec.rows,
      worktreeId: spec.worktreeId,
      sessionId: spec.sessionId,
      scrollback: 10_000,
      idleTimeoutMs: null,
    });
  }

  async pid(_terminal: Terminal, tmuxName: string | null): Promise<number | null> {
    if (!tmuxName) return null;
    const result = await this.run(['display-message', '-p', '-t', `=${tmuxName}`, '#{pane_pid}']);
    const pid = Number(result.stdout.trim());
    return succeeded(result) && Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  async kill(terminal: Terminal | null, tmuxName: string | null): Promise<void> {
    if (tmuxName) await this.run(['kill-session', '-t', `=${tmuxName}`]);
    terminal?.kill();
  }

  async isAlive(_terminal: Terminal | null, tmuxName: string | null): Promise<boolean> {
    return tmuxName ? this.hasSession(tmuxName) : false;
  }
}

/** `nuera-<project-slug>-<worktree>` (tmux forbids `.` and `:`), made unique with a suffix. */
export function tmuxSessionName(projectSlug: string, worktreeName: string, taken: Set<string>): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const base = `nuera-${clean(projectSlug)}-${clean(worktreeName)}`.slice(0, 80);
  let name = base;
  for (let i = 2; taken.has(name); i += 1) name = `${base}-${i}`;
  return name;
}
