import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { and, eq, inArray } from 'drizzle-orm';
import { commandRuns, type Database } from '@nuera/db';
import { formatTestCounts } from '@nuera/shared/events';
import { DEFAULT_DEV_SERVER_NAME, devServerEntries, type GitIdentity, type RunDto, type TestReport } from '@nuera/shared/runner';
import type { Logger } from 'pino';
import type { ClaudeAccounts } from '../claude/accounts';
import { claudeEnv, gitIdentityEnv } from '../claude/env';
import { getProject, getRunRow } from '../db/lookups';
import type { EnvironmentScope } from '../environment';
import { GLOBAL, runChannel, type EventBus } from '../events/bus';
import { RunnerError } from '../errors';
import type { GitService } from '../git/service';
import { tailText } from '../safety/redact';
import type { TerminalManager } from '../terminals/manager';
import { terminalEnv } from '../terminals/manager';
import type { Terminal } from '../terminals/terminal';
import { buildChildEnv } from '../safety/env';
import { platformShellForPty } from './shell';
import { stripAnsi, TestOutputParser } from './test-parser';

type RunRow = typeof commandRuns.$inferSelect;
type CommandKind = RunDto['kind'];

const OUTPUT_TAIL = 64 * 1024;
const MAX_LIVE_RUNS = 8;

/**
 * Port of a dev server from its output (« Local: http://localhost:3001 », http://127.0.0.1:5173/, « port 8080 »).
 * The LAST address announced wins, and a line saying a port is taken (« Port 3000 is in use…, using available
 * port 3001 instead », « EADDRINUSE ») never designates it: two dev servers of the same framework start on the
 * same default port, and the second one moves — reading its first number previewed the OTHER project.
 */
export function detectPort(text: string): number | null {
  const lines = stripAnsi(text).split(/\r?\n/);
  const valid = (value: string | undefined) => {
    const port = Number(value);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  };
  let fromUrl: number | null = null;
  let fromWord: number | null = null;
  const url = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[a-z0-9.-]+\.local):(\d{2,5})\b/gi;
  for (const line of lines) {
    if (/in use|already used|eaddrinuse|occupé/i.test(line)) {
      // « …is in use, using available port 3001 instead »: only the port it moves to counts.
      const moved = /(?:using|trying|switching to|instead)[^\d]{0,40}?(\d{2,5})/i.exec(line.replace(/^.*?in use/i, ''));
      const port = valid(moved?.[1]);
      if (port) fromWord = port;
      continue;
    }
    for (const match of line.matchAll(url)) {
      const port = valid(match[1]);
      if (port) fromUrl = port;
    }
    const word = /\bport\s*[:=]?\s*(\d{2,5})\b/i.exec(line);
    const port = valid(word?.[1]);
    if (port) fromWord = port;
  }
  return fromUrl ?? fromWord;
}

/** A free TCP port on the loopback, offered to the dev server as PORT (frameworks that honour it never collide). */
async function freeLoopbackPort(): Promise<number | null> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(null));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(() => resolve(port));
    });
  });
}

/** How long after its start a dev server may still announce a different address (it moved to another port). */
const PORT_SETTLE_MS = 60_000;

interface LiveRun {
  id: string;
  row: RunRow;
  terminal: Terminal;
  output: string;
  parser: TestOutputParser | null;
  tests: TestReport | null;
  stopping: boolean;
  publishTimer: ReturnType<typeof setTimeout> | null;
  dbTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Project commands (install/dev/build/test/lint/custom) in a worktree, through the platform shell
 * (see runs/shell.ts), in a PTY so the output keeps its colours. Live output → `run.output`,
 * status/port/test summary → `run.status` and the command_runs row.
 */
export class RunManager {
  private readonly live = new Map<string, LiveRun>();

  constructor(
    private readonly deps: {
      db: Database;
      environment: EnvironmentScope;
      bus: EventBus;
      git: GitService;
      terminals: TerminalManager;
      logger: Logger;
      /** Claude config folder of the project's account (lot P1), for a `claude` started by a command. */
      accounts: Pick<ClaudeAccounts, 'forSpace'>;
    },
  ) {}

  get liveCount(): number {
    return this.live.size;
  }

  liveCountForWorktree(worktreeId: string): number {
    let count = 0;
    for (const live of this.live.values()) if (live.row.worktreeId === worktreeId) count += 1;
    return count;
  }

  private dto(row: RunRow, tests: TestReport | null): RunDto {
    return {
      name: devServerName(row),
      id: row.id,
      projectId: row.projectId,
      worktreeId: row.worktreeId,
      kind: row.kind,
      command: row.command,
      status: row.status,
      exitCode: row.exitCode,
      pid: row.pid,
      port: row.port,
      summary: row.summary,
      tests,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
      live: this.live.has(row.id),
    };
  }

  async create(input: {
    projectId: string;
    worktreeId?: string;
    kind: CommandKind;
    command?: string;
    env: Record<string, string>;
    cols: number;
    rows: number;
    /** Account starting the command (`command_runs.actor_user_id`). */
    actorUserId?: string | null;
    /** Author and committer of the commits made by the command (trusted GIT_AUTHOR_* / GIT_COMMITTER_*). */
    gitIdentity?: GitIdentity | null;
    /** Dev server name (`kind: 'dev'`); default: the project's default one. */
    name?: string;
  }): Promise<RunDto> {
    if (this.live.size >= MAX_LIVE_RUNS) throw new RunnerError('CONFLICT', 'Trop de commandes en cours sur le serveur.', { reason: 'RUN_LIMIT' });
    const project = await getProject(this.deps.db, this.deps.environment.id, input.projectId);
    await this.deps.environment.assertCanStartWork();
    const { worktree, cwd } = await this.deps.git.resolveProjectWorktree(project.id, input.worktreeId);
    const account = await this.deps.accounts.forSpace(project.spaceId);
    const configured = (project.commands ?? {}) as Record<string, string | null | undefined>;
    // Dev server: one of the project's named servers (default: the default one, `commands.dev`).
    let devName: string | null = null;
    let devCommand: string | null = null;
    if (input.kind === 'dev') {
      const entries = devServerEntries(project.commands);
      const entry = input.name ? entries.find((e) => e.name === input.name) : entries[0];
      devName = input.name ?? entry?.name ?? DEFAULT_DEV_SERVER_NAME;
      devCommand = entry?.command ?? null;
    }
    const command = input.command ?? (input.kind === 'dev' ? devCommand : input.kind !== 'custom' ? configured[input.kind] ?? null : null);
    if (!command) throw new RunnerError('VALIDATION', 'Aucune commande configurée pour cette action.');
    if (input.kind === 'dev') {
      // Several dev servers per worktree (client + admin), never two of the same name.
      const running = [...this.live.values()].find(
        (r) => r.row.worktreeId === worktree.id && r.row.kind === 'dev' && !r.stopping && devServerName(r.row) === devName,
      );
      if (running) {
        throw new RunnerError('CONFLICT', `Le serveur de développement « ${devName} » tourne déjà dans ce worktree.`, {
          reason: 'DEV_SERVER_RUNNING',
          data: { runId: running.id },
        });
      }
    }
    const id = randomUUID();
    const [row] = await this.deps.db
      .insert(commandRuns)
      .values({
        id,
        projectId: project.id,
        environmentId: project.environmentId,
        worktreeId: worktree.id,
        kind: input.kind,
        command,
        status: 'running',
        actorUserId: input.actorUserId ?? null,
        ...(devName ? { details: { devServer: devName } } : {}),
      })
      .returning();
    const shell = platformShellForPty(command);
    // Dev server: a free port of its own (PORT, honoured by Next, Nuxt, Remix, Express…), unless the project sets one.
    const devPort = input.kind === 'dev' && !(input.env && 'PORT' in input.env) ? await freeLoopbackPort() : null;
    const env = terminalEnv({
      ...(devPort ? { PORT: String(devPort) } : {}),
      ...buildChildEnv(input.env, { policy: 'project', source: {} }),
      ...(input.kind === 'test' ? { CI: '1' } : {}),
      // Trusted, after the project variables (where the GIT_ prefix is refused anyway).
      ...gitIdentityEnv(input.gitIdentity),
      ...claudeEnv(account.configDir),
    });
    let terminal: Terminal;
    try {
      terminal = this.deps.terminals.spawn({
        kind: 'shell',
        title: `${command} · ${worktree.name}`,
        file: shell.file,
        args: shell.args,
        cwd,
        env,
        cols: input.cols,
        rows: input.rows,
        worktreeId: worktree.id,
        spaceId: project.spaceId,
        scrollback: 5000,
        idleTimeoutMs: null,
      });
    } catch (error) {
      await this.deps.db.update(commandRuns).set({ status: 'failed', finishedAt: new Date(), summary: 'Impossible de lancer la commande.' }).where(eq(commandRuns.id, id));
      throw error;
    }
    const live: LiveRun = {
      id,
      row: row!,
      terminal,
      output: '',
      parser: input.kind === 'test' || /\b(test|vitest|jest|playwright)\b/.test(command) ? new TestOutputParser() : null,
      tests: null,
      stopping: false,
      publishTimer: null,
      dbTimer: null,
    };
    this.live.set(id, live);
    terminal.onOutput((data) => this.onOutput(live, data));
    terminal.onExit((code) => void this.onExit(live, code));
    setTimeout(() => {
      if (terminal.pid && live.row.pid !== terminal.pid) {
        live.row = { ...live.row, pid: terminal.pid };
        void this.deps.db.update(commandRuns).set({ pid: terminal.pid }).where(eq(commandRuns.id, id));
      }
    }, 1500).unref?.();
    this.publish(live);
    return this.dto(live.row, null);
  }

  private onOutput(live: LiveRun, data: string): void {
    live.output = tailText(live.output + data, OUTPUT_TAIL);
    this.deps.bus.publish('run.output', { runId: live.id, data }, { channels: [runChannel(live.id)], replay: false });
    let changed = false;
    // Until the server settles (it may announce a first port, then move), the latest address announced wins.
    const settling = live.row.port === null || Date.now() - new Date(live.row.startedAt ?? Date.now()).getTime() < PORT_SETTLE_MS;
    if (live.row.kind !== 'test' && settling) {
      const port = detectPort(live.output.slice(-8000));
      if (port && port !== live.row.port && !this.portTakenByAnotherRun(live.id, port)) {
        live.row = { ...live.row, port };
        changed = true;
      }
    }
    if (live.parser) {
      live.parser.push(data);
      const report = live.parser.report();
      const countsChanged = JSON.stringify(report?.counts ?? null) !== JSON.stringify(live.tests?.counts ?? null);
      const testsChanged = (report?.tests.length ?? 0) !== (live.tests?.tests.length ?? 0);
      if (report && (countsChanged || testsChanged)) {
        live.tests = report;
        changed = true;
      }
    }
    if (changed) this.schedulePublish(live);
  }

  private schedulePublish(live: LiveRun): void {
    if (live.publishTimer) return;
    live.publishTimer = setTimeout(() => {
      live.publishTimer = null;
      this.publish(live);
      void this.persist(live);
    }, 300);
    live.publishTimer.unref?.();
  }

  private publish(live: LiveRun): void {
    this.deps.bus.publish('run.status', { run: this.dto(live.row, live.tests) }, { channels: [GLOBAL, runChannel(live.id)] });
  }

  private async persist(live: LiveRun): Promise<void> {
    try {
      await this.deps.db
        .update(commandRuns)
        .set({ port: live.row.port, summary: live.row.summary, outputTail: live.output })
        .where(eq(commandRuns.id, live.id));
    } catch (error) {
      this.deps.logger.warn({ err: error, runId: live.id }, 'écriture du lancement impossible');
    }
  }

  private async onExit(live: LiveRun, code: number | null): Promise<void> {
    if (live.publishTimer) clearTimeout(live.publishTimer);
    const tests = live.parser ? live.parser.report({ finished: true }) : null;
    live.tests = tests;
    const status = live.stopping ? 'stopped' : code === 0 ? 'succeeded' : 'failed';
    const summary = tests && tests.counts.total > 0 ? formatTestCounts(tests.counts) : status === 'stopped' ? 'Arrêtée' : code === 0 ? 'Terminée' : `code ${code ?? '?'}`;
    const [row] = await this.deps.db
      .update(commandRuns)
      // The per-test report outlives the process (W2 « Résultats des tests » after the end of the run).
      .set({ status, exitCode: code, summary, outputTail: live.output, details: runDetails(live.row, tests), finishedAt: new Date(), port: live.row.port })
      .where(eq(commandRuns.id, live.id))
      .returning();
    this.live.delete(live.id);
    if (row) {
      live.row = row;
      this.deps.bus.publish('run.status', { run: this.dto(row, tests) }, { channels: [GLOBAL, runChannel(live.id)] });
    }
  }

  async get(runId: string): Promise<RunDto> {
    const live = this.live.get(runId);
    if (live) return this.dto(live.row, live.tests);
    const row = await getRunRow(this.deps.db, this.deps.environment.id, runId);
    return this.dto(row, row.details?.report ?? null);
  }

  /**
   * Port of the dev server of a run, for the « Aperçu » relay: the run must be one of THIS server
   * (unknown or foreign id → the same 404 as `get`), of kind `dev`, alive in this runner process
   * (not being stopped) and with a port detected in its output. Nothing else is ever proxied.
   */
  /** A port already announced by another live dev server is never adopted by a dev server (it is that one's). */
  private portTakenByAnotherRun(runId: string, port: number): boolean {
    const self = this.live.get(runId);
    if (self?.row.kind !== 'dev') return false;
    for (const [id, other] of this.live) if (id !== runId && other.row.kind === 'dev' && other.row.port === port && !other.stopping) return true;
    return false;
  }

  async previewTarget(runId: string): Promise<{ port: number; worktreeId: string | null }> {
    const live = this.live.get(runId);
    if (!live) {
      const row = await getRunRow(this.deps.db, this.deps.environment.id, runId);
      if (row.kind !== 'dev') throw new RunnerError('CONFLICT', "Ce lancement n'est pas un serveur de développement.", { reason: 'PREVIEW_NOT_DEV' });
      throw new RunnerError('CONFLICT', 'Le serveur de développement est arrêté.', { reason: 'PREVIEW_NOT_RUNNING' });
    }
    if (live.row.kind !== 'dev') throw new RunnerError('CONFLICT', "Ce lancement n'est pas un serveur de développement.", { reason: 'PREVIEW_NOT_DEV' });
    if (live.stopping) throw new RunnerError('CONFLICT', 'Le serveur de développement est arrêté.', { reason: 'PREVIEW_NOT_RUNNING' });
    if (!live.row.port) {
      throw new RunnerError('CONFLICT', "Le port du serveur de développement n'apparaît pas encore dans sa sortie.", { reason: 'PREVIEW_NO_PORT' });
    }
    return { port: live.row.port, worktreeId: live.row.worktreeId };
  }

  /** Output kept for a new subscriber (live buffer or the stored tail). */
  async outputTail(runId: string): Promise<string> {
    const live = this.live.get(runId);
    if (live) return live.output;
    const [row] = await this.deps.db
      .select({ outputTail: commandRuns.outputTail })
      .from(commandRuns)
      .where(and(eq(commandRuns.id, runId), eq(commandRuns.environmentId, this.deps.environment.id)))
      .limit(1);
    return row?.outputTail ?? '';
  }

  async stop(runId: string): Promise<RunDto> {
    const live = this.live.get(runId);
    if (!live) return this.get(runId);
    live.stopping = true;
    live.terminal.write('\u0003');
    await new Promise((r) => setTimeout(r, 1500));
    if (this.live.has(runId)) killTree(live.terminal);
    const deadline = Date.now() + 8000;
    while (this.live.has(runId) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    return this.get(runId);
  }

  /** Runs left `running` by a previous runner process of THIS server. */
  async markInterrupted(): Promise<number> {
    const rows = await this.deps.db
      .update(commandRuns)
      .set({ status: 'stopped', finishedAt: new Date(), summary: 'Interrompue par un redémarrage du runner' })
      .where(and(eq(commandRuns.environmentId, this.deps.environment.id), inArray(commandRuns.status, ['running'])))
      .returning({ id: commandRuns.id });
    return rows.length;
  }

  async stopAll(): Promise<void> {
    for (const live of this.live.values()) {
      live.stopping = true;
      killTree(live.terminal);
    }
  }
}

/** Dev server name of a run (`details.devServer`; older dev runs: the default name). */
function devServerName(row: RunRow): string | null {
  if (row.kind !== 'dev') return null;
  const name = row.details?.devServer;
  return typeof name === 'string' && name ? name : DEFAULT_DEV_SERVER_NAME;
}

/** Details kept at the end of a run: its dev server name and its test report. */
function runDetails(row: RunRow, tests: TestReport | null): RunRow['details'] {
  const name = row.kind === 'dev' ? row.details?.devServer : undefined;
  if (!name && !tests) return null;
  return { ...(name ? { devServer: name } : {}), ...(tests ? { report: tests } : {}) };
}

function killTree(terminal: Terminal): void {
  const pid = terminal.pid;
  if (pid && process.platform !== 'win32') {
    try {
      // node-pty starts the shell as a session leader: its process group holds every child.
      process.kill(-pid, 'SIGTERM');
    } catch {
      terminal.kill('SIGTERM');
    }
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // gone
      }
    }, 3000).unref?.();
    return;
  }
  if (pid && process.platform === 'win32') {
    void import('node:child_process').then(({ spawn }) => {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
    });
  }
  terminal.kill();
}
