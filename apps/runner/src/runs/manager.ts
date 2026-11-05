import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { commandRuns, type Database } from '@nuera/db';
import { formatTestCounts } from '@nuera/shared/events';
import type { RunDto, TestReport } from '@nuera/shared/runner';
import type { Logger } from 'pino';
import { getProject } from '../db/lookups';
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

/** « port 3000 » from a dev server banner (localhost:3000, http://127.0.0.1:5173/, "port 8080"). */
export function detectPort(text: string): number | null {
  const clean = stripAnsi(text);
  const url = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[a-z0-9.-]+\.local):(\d{2,5})\b/i.exec(clean);
  const word = /\bport\s*[:=]?\s*(\d{2,5})\b/i.exec(clean);
  const value = url?.[1] ?? word?.[1];
  if (!value) return null;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : null;
}

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
    private readonly deps: { db: Database; bus: EventBus; git: GitService; terminals: TerminalManager; logger: Logger },
  ) {}

  get liveCount(): number {
    return this.live.size;
  }

  private dto(row: RunRow, tests: TestReport | null): RunDto {
    return {
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
  }): Promise<RunDto> {
    if (this.live.size >= MAX_LIVE_RUNS) throw new RunnerError('CONFLICT', 'Trop de commandes en cours sur le serveur.', { reason: 'RUN_LIMIT' });
    const project = await getProject(this.deps.db, input.projectId);
    const { worktree, cwd } = await this.deps.git.resolveProjectWorktree(project.id, input.worktreeId);
    const configured = (project.commands ?? {}) as Record<string, string | null | undefined>;
    const command = input.command ?? (input.kind !== 'custom' ? configured[input.kind] ?? null : null);
    if (!command) throw new RunnerError('VALIDATION', 'Aucune commande configurée pour cette action.');
    if (input.kind === 'dev') {
      const running = [...this.live.values()].find((r) => r.row.worktreeId === worktree.id && r.row.kind === 'dev');
      if (running) throw new RunnerError('CONFLICT', 'Un serveur de développement tourne déjà dans ce worktree.', { data: { runId: running.id } });
    }
    const id = randomUUID();
    const [row] = await this.deps.db
      .insert(commandRuns)
      .values({ id, projectId: project.id, worktreeId: worktree.id, kind: input.kind, command, status: 'running' })
      .returning();
    const shell = platformShellForPty(command);
    const env = terminalEnv({ ...buildChildEnv(input.env, { policy: 'project', source: {} }), ...(input.kind === 'test' ? { CI: '1' } : {}) });
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
    if (live.row.port === null && live.row.kind !== 'test') {
      const port = detectPort(data) ?? detectPort(live.output.slice(-2000));
      if (port) {
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
      .set({ status, exitCode: code, summary, outputTail: live.output, details: tests ? { report: tests } : null, finishedAt: new Date(), port: live.row.port })
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
    const [row] = await this.deps.db.select().from(commandRuns).where(eq(commandRuns.id, runId)).limit(1);
    if (!row) throw new RunnerError('NOT_FOUND', 'Lancement introuvable.');
    return this.dto(row, row.details?.report ?? null);
  }

  /** Output kept for a new subscriber (live buffer or the stored tail). */
  async outputTail(runId: string): Promise<string> {
    const live = this.live.get(runId);
    if (live) return live.output;
    const [row] = await this.deps.db.select({ outputTail: commandRuns.outputTail }).from(commandRuns).where(eq(commandRuns.id, runId)).limit(1);
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

  /** Runs left `running` by a previous runner process. */
  async markInterrupted(): Promise<number> {
    const rows = await this.deps.db
      .update(commandRuns)
      .set({ status: 'stopped', finishedAt: new Date(), summary: 'Interrompue par un redémarrage du runner' })
      .where(inArray(commandRuns.status, ['running']))
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
