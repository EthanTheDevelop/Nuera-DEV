import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { CreateTerminalRequest, TerminalDto } from '@nuera/shared/runner';
import type { Logger } from 'pino';
import { resolveClaudeCommand } from '../claude/bin';
import { claudeEnv, gitIdentityEnv } from '../claude/env';
import type { EnvironmentScope } from '../environment';
import { RunnerError } from '../errors';
import type { GitService } from '../git/service';
import { buildChildEnv, withTrustedEnv } from '../safety/env';
import { Terminal, type TerminalSpawnOptions } from './terminal';

const SHELL_IDLE_MS = 30 * 60_000;
const LOGIN_IDLE_MS = 10 * 60_000;
const SWEEP_MS = 60_000;
const MAX_TERMINALS = 32;

/** Environment for interactive PTYs (sanitised + terminal capabilities). */
export function terminalEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const base = buildChildEnv();
  return withTrustedEnv(base, {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    ...(process.platform !== 'win32' && !base.LANG ? { LANG: 'C.UTF-8' } : {}),
    ...extra,
  });
}

export function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'] };
  const shell = process.env.SHELL && /\/(bash|zsh|fish|sh)$/.test(process.env.SHELL) ? process.env.SHELL : '/bin/bash';
  return { file: shell, args: [] };
}

export class TerminalManager {
  private readonly terminals = new Map<string, Terminal>();
  private readonly sweeper: ReturnType<typeof setInterval>;
  private readonly exitHooks = new Set<(terminal: Terminal) => void>();

  constructor(
    private readonly deps: {
      dataDir: string;
      claudeBin: string | null;
      /** NUERA_CLAUDE_CONFIG_DIR: CLAUDE_CONFIG_DIR of the login, MCP login and status terminals. */
      claudeConfigDir: string | null;
      gitService: GitService;
      /** Server of this runner: a suspended server opens no shell. */
      environment: EnvironmentScope;
      logger: Logger;
    },
  ) {
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweeper.unref?.();
  }

  /** Low-level spawn (sessions, runs and tests use it directly). */
  spawn(options: TerminalSpawnOptions): Terminal {
    if (this.terminals.size >= MAX_TERMINALS) {
      throw new RunnerError('CONFLICT', 'Trop de terminaux ouverts sur le serveur.', { reason: 'RUN_LIMIT' });
    }
    const terminal = new Terminal(options);
    this.terminals.set(terminal.id, terminal);
    terminal.onExit(() => {
      for (const hook of this.exitHooks) hook(terminal);
      // Keep the exited terminal a moment so clients can read the end, private ones are dropped at once.
      const delay = terminal.isPrivate ? 0 : 5 * 60_000;
      setTimeout(() => this.forget(terminal.id), delay).unref?.();
    });
    if (!terminal.isPrivate) {
      this.deps.logger.info({ terminalId: terminal.id, kind: terminal.kind }, 'terminal ouvert');
    }
    return terminal;
  }

  onTerminalExit(hook: (terminal: Terminal) => void): () => void {
    this.exitHooks.add(hook);
    return () => this.exitHooks.delete(hook);
  }

  private scratchDir(name: string): string {
    const dir = path.join(this.deps.dataDir, 'scratch', name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private claude() {
    const cmd = resolveClaudeCommand(this.deps.claudeBin);
    if (!cmd) throw new RunnerError('CONFLICT', 'Le CLI Claude Code est introuvable sur le serveur.', { reason: 'CLAUDE_NOT_INSTALLED' });
    return cmd;
  }

  /** POST /v1/terminals */
  async create(input: CreateTerminalRequest & { cols: number; rows: number }): Promise<Terminal> {
    switch (input.kind) {
      case 'shell': {
        const { worktree, cwd } = await this.deps.gitService.resolveWorktree(input.worktreeId);
        await this.deps.environment.assertCanStartWork();
        const shell = defaultShell();
        return this.spawn({
          kind: 'shell',
          title: `Terminal · ${worktree.name}`,
          file: shell.file,
          args: shell.args,
          cwd,
          // Same Claude config as the server's sessions (a `claude` typed here uses the server's login).
          env: terminalEnv({ ...claudeEnv(this.deps.claudeConfigDir), ...gitIdentityEnv(input.gitIdentity) }),
          cols: input.cols,
          rows: input.rows,
          worktreeId: worktree.id,
          ownerUserId: input.actorUserId ?? null,
          idleTimeoutMs: SHELL_IDLE_MS,
        });
      }
      case 'claude-login': {
        const claude = this.claude();
        return this.spawn({
          kind: 'claude-login',
          title: 'Connexion à Claude',
          file: claude.file,
          args: [...claude.prefix, 'auth', 'login'],
          cwd: this.scratchDir('claude-login'),
          env: terminalEnv(claudeEnv(this.deps.claudeConfigDir)),
          cols: input.cols,
          rows: input.rows,
          ownerUserId: input.actorUserId ?? null,
          private: true,
          scrollback: 500,
          idleTimeoutMs: LOGIN_IDLE_MS,
        });
      }
      case 'mcp-login': {
        const claude = this.claude();
        return this.spawn({
          kind: 'mcp-login',
          title: `Connexion MCP · ${input.serverName}`,
          file: claude.file,
          args: [...claude.prefix, 'mcp', 'login', input.serverName, '--no-browser'],
          cwd: this.scratchDir('mcp-login'),
          env: terminalEnv(claudeEnv(this.deps.claudeConfigDir)),
          cols: input.cols,
          rows: input.rows,
          ownerUserId: input.actorUserId ?? null,
          private: true,
          scrollback: 500,
          idleTimeoutMs: LOGIN_IDLE_MS,
        });
      }
      case 'claude-status': {
        // `/status` is an interactive command: open the CLI in a scratch folder and let the owner
        // type /status (or /usage). Nothing is sent to Claude unless the owner types a prompt.
        const claude = this.claude();
        return this.spawn({
          kind: 'claude-status',
          title: 'Claude Code · /status',
          file: claude.file,
          args: [...claude.prefix],
          cwd: this.scratchDir('claude-status'),
          env: terminalEnv({ ...claudeEnv(this.deps.claudeConfigDir), ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }),
          cols: input.cols,
          rows: input.rows,
          ownerUserId: input.actorUserId ?? null,
          private: true,
          scrollback: 1000,
          idleTimeoutMs: LOGIN_IDLE_MS,
        });
      }
      default:
        throw new RunnerError('VALIDATION', 'Type de terminal inconnu.');
    }
  }

  get(id: string): Terminal {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new RunnerError('NOT_FOUND', 'Terminal introuvable ou fermé.', { reason: 'TERMINAL_CLOSED' });
    return terminal;
  }

  find(id: string): Terminal | undefined {
    return this.terminals.get(id);
  }

  list(): TerminalDto[] {
    return [...this.terminals.values()].map((t) => t.toDto());
  }

  get liveCount(): number {
    return [...this.terminals.values()].filter((t) => t.alive).length;
  }

  /** DELETE /v1/terminals/:id (a session terminal is stopped through the session instead). */
  close(id: string, options: { allowSession?: boolean } = {}): void {
    const terminal = this.get(id);
    if (terminal.kind === 'session' && !options.allowSession) {
      throw new RunnerError('CONFLICT', "Ce terminal est celui d'une session Claude : arrêtez la session pour le fermer.");
    }
    terminal.dispose();
    this.terminals.delete(id);
  }

  private forget(id: string) {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    if (terminal.alive) return;
    terminal.dispose();
    this.terminals.delete(id);
  }

  private sweep() {
    const now = Date.now();
    for (const terminal of this.terminals.values()) {
      if (!terminal.alive || terminal.idleTimeoutMs === null || terminal.subscriberCount > 0) continue;
      if (now - terminal.lastSubscriberAt > terminal.idleTimeoutMs) {
        this.deps.logger.info({ terminalId: terminal.id, kind: terminal.kind }, 'terminal inactif fermé');
        terminal.dispose();
        this.terminals.delete(terminal.id);
      }
    }
  }

  /** Kills every PTY and waits (bounded) for their exit, so ConPTY workers are released. */
  async closeAll(timeoutMs = 4000): Promise<void> {
    clearInterval(this.sweeper);
    const terminals = [...this.terminals.values()];
    const exits = terminals
      .filter((t) => t.alive)
      .map((t) => new Promise<void>((resolve) => {
        t.onExit(() => resolve());
        if (!t.alive) resolve();
      }));
    for (const terminal of terminals) terminal.kill();
    await Promise.race([Promise.all(exits), new Promise((r) => setTimeout(r, timeoutMs).unref?.())]);
    for (const terminal of terminals) terminal.dispose();
    this.terminals.clear();
  }
}
