import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { operations, type Database } from '@nuera/db';
import type { OperationDto, OperationSnapshot, OperationStepDto } from '@nuera/shared/runner';
import type { Logger } from 'pino';
import { findOperationRow } from '../db/lookups';
import type { EnvironmentScope } from '../environment';
import { GLOBAL, operationChannel, type EventBus } from '../events/bus';
import { RunnerError, toRunnerError } from '../errors';
import { redactSecrets, tailText } from '../safety/redact';

type OperationKind = OperationDto['kind'];
type OperationRow = typeof operations.$inferSelect;

const LOG_CAP = 64 * 1024;
const DB_FLUSH_MS = 1000;
const SSE_FLUSH_MS = 250;

export interface CreateOperationInput {
  kind: OperationKind;
  projectId?: string | null;
  worktreeId?: string | null;
  sessionId?: string | null;
  title?: string | null;
  steps?: OperationStepDto[];
  actorUserId?: string | null;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function operationRowToDto(row: OperationRow): OperationDto {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    projectId: row.projectId,
    worktreeId: row.worktreeId,
    sessionId: row.sessionId,
    title: row.title,
    progress: row.progress,
    steps: (row.steps ?? []) as OperationStepDto[],
    error: row.error ?? null,
    result: row.result ?? null,
    createdAt: row.createdAt.toISOString(),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
  };
}

/** A running operation: in-memory state, throttled persistence and SSE progress. */
export class OperationHandle {
  readonly id: string;
  private dto: OperationDto;
  private log = '';
  private liveLine: string | null = null;
  private pendingLines: string[] = [];
  private dbTimer: ReturnType<typeof setTimeout> | null = null;
  private sseTimer: ReturnType<typeof setTimeout> | null = null;
  private finished = false;
  /** Writes are chained: a throttled write still in flight never lands after the final one. */
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly service: OperationService,
    dto: OperationDto,
  ) {
    this.id = dto.id;
    this.dto = dto;
  }

  get snapshot(): OperationSnapshot {
    return { ...this.dto, log: this.log, liveLine: this.liveLine };
  }

  get isFinished(): boolean {
    return this.finished;
  }

  step(key: string, patch: Partial<OperationStepDto>): void {
    this.dto = {
      ...this.dto,
      steps: this.dto.steps.map((s) => (s.key === key ? { ...s, ...patch } : s)),
    };
    this.scheduleDb();
    this.flushSse();
  }

  stepState(key: string): OperationStepDto | undefined {
    return this.dto.steps.find((s) => s.key === key);
  }

  progress(value: number | null): void {
    const next = value === null ? null : Math.max(0, Math.min(100, Math.round(value)));
    if (next === this.dto.progress) return;
    this.dto = { ...this.dto, progress: next };
    this.scheduleDb();
    this.scheduleSse();
  }

  /** Journal lines (redacted, capped). */
  appendLog(lines: string[]): void {
    if (lines.length === 0) return;
    const clean = lines.map((l) => redactSecrets(l.replace(/\s+$/, '')));
    this.log = tailText(this.log + clean.join('\n') + '\n', LOG_CAP);
    this.pendingLines.push(...clean);
    this.scheduleDb();
    this.scheduleSse();
  }

  setLiveLine(line: string | null): void {
    const clean = line === null ? null : redactSecrets(line.replace(/\s+$/, ''));
    if (clean === this.liveLine) return;
    this.liveLine = clean;
    this.scheduleSse();
  }

  async succeed(result: Record<string, unknown> | null = null): Promise<void> {
    await this.finish({ status: 'succeeded', result, error: null, progress: 100 });
  }

  async fail(error: unknown): Promise<void> {
    const e = toRunnerError(error);
    await this.finish({
      status: 'failed',
      result: null,
      progress: this.dto.progress,
      error: {
        code: e.code,
        message: e.message,
        ...(e.untouched ? { untouched: e.untouched } : {}),
        ...(e.raw ? { raw: redactSecrets(e.raw).slice(-16_000) } : {}),
        ...(e.reason ? { reason: e.reason } : {}),
        ...(e.data ? { data: e.data } : {}),
      },
    });
  }

  private async finish(patch: Pick<OperationDto, 'status' | 'result' | 'error' | 'progress'>): Promise<void> {
    if (this.finished) return;
    if (this.liveLine) {
      this.appendLog([this.liveLine]);
      this.liveLine = null;
    }
    this.finished = true;
    this.dto = {
      ...this.dto,
      ...patch,
      steps: this.dto.steps.map((s) =>
        s.status === 'running'
          ? { ...s, status: patch.status === 'succeeded' ? 'done' : 'failed', finishedAt: new Date().toISOString() }
          : s.status === 'pending' && patch.status !== 'succeeded'
            ? { ...s, status: 'skipped' }
            : s,
      ),
      finishedAt: new Date().toISOString(),
    };
    if (this.dbTimer) clearTimeout(this.dbTimer);
    if (this.sseTimer) clearTimeout(this.sseTimer);
    this.dbTimer = null;
    this.sseTimer = null;
    await this.write();
    this.flushSse();
    this.service.release(this.id);
  }

  /** Persists the current state after any write still in flight (persist never throws). */
  private write(): Promise<void> {
    this.writes = this.writes.then(() => this.service.persist(this.dto, this.log));
    return this.writes;
  }

  private scheduleDb() {
    if (this.finished || this.dbTimer) return;
    this.dbTimer = setTimeout(() => {
      this.dbTimer = null;
      void this.write();
    }, DB_FLUSH_MS);
    this.dbTimer.unref?.();
  }

  private scheduleSse() {
    if (this.sseTimer) return;
    this.sseTimer = setTimeout(() => {
      this.sseTimer = null;
      this.flushSse();
    }, SSE_FLUSH_MS);
    this.sseTimer.unref?.();
  }

  private flushSse() {
    const lines = this.pendingLines.splice(0);
    this.service.publish(this.dto, { logAppend: lines, liveLine: this.liveLine });
  }
}

export class OperationService {
  private readonly live = new Map<string, OperationHandle>();

  constructor(
    private readonly db: Database,
    private readonly bus: EventBus,
    private readonly logger: Logger,
    /** Server of this runner: operations are recorded, read and reconciled within it only. */
    private readonly environment: EnvironmentScope,
  ) {}

  async create(input: CreateOperationInput): Promise<OperationHandle> {
    const now = new Date();
    const id = randomUUID();
    const [row] = await this.db
      .insert(operations)
      .values({
        id,
        environmentId: this.environment.id,
        kind: input.kind,
        status: 'running',
        projectId: input.projectId ?? null,
        worktreeId: input.worktreeId ?? null,
        sessionId: input.sessionId ?? null,
        title: input.title ?? null,
        progress: null,
        steps: (input.steps ?? []) as never,
        log: '',
        actorUserId: input.actorUserId ?? null,
        startedAt: now,
      })
      .returning();
    if (!row) throw new RunnerError('INTERNAL', 'Opération non enregistrée.');
    const handle = new OperationHandle(this, operationRowToDto(row));
    this.live.set(id, handle);
    this.publish(handle.snapshot, { log: '' });
    return handle;
  }

  /**
   * Runs `work` inside an operation: failures are recorded (code, message, raw, untouched) and
   * rethrown so the HTTP route answers with the same error.
   */
  async run<T>(input: CreateOperationInput, work: (op: OperationHandle) => Promise<T>, toResult?: (value: T) => Record<string, unknown>): Promise<{ operationId: string; value: T }> {
    const op = await this.create(input);
    try {
      const value = await work(op);
      await op.succeed(toResult ? toResult(value) : null);
      return { operationId: op.id, value };
    } catch (error) {
      await op.fail(error);
      throw error;
    }
  }

  async get(id: string): Promise<OperationSnapshot | null> {
    const live = this.live.get(id);
    if (live) return live.snapshot;
    const row = await findOperationRow(this.db, this.environment.id, id);
    if (!row) return null;
    return { ...operationRowToDto(row), log: row.log, liveLine: null };
  }

  /** Operations left `running`/`queued` by a previous runner process of THIS server. */
  async failInterrupted(): Promise<number> {
    const rows = await this.db
      .update(operations)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        error: { code: 'INTERNAL', message: 'Opération interrompue par un redémarrage du runner.' },
      })
      .where(and(eq(operations.environmentId, this.environment.id), inArray(operations.status, ['running', 'queued'])))
      .returning({ id: operations.id });
    return rows.length;
  }

  /** @internal */
  async persist(dto: OperationDto, log: string): Promise<void> {
    try {
      await this.db
        .update(operations)
        .set({
          status: dto.status,
          progress: dto.progress,
          steps: dto.steps as never,
          log,
          error: (dto.error ?? null) as never,
          result: (dto.result ?? null) as never,
          finishedAt: dto.finishedAt ? new Date(dto.finishedAt) : null,
        })
        .where(eq(operations.id, dto.id));
    } catch (error) {
      this.logger.warn({ err: error, operationId: dto.id }, "écriture de l'opération impossible");
    }
  }

  /** @internal */
  publish(dto: OperationDto, extra: { log?: string; logAppend?: string[]; liveLine?: string | null }): void {
    this.bus.publish(
      'operation.progress',
      {
        operation: dto,
        ...(extra.log !== undefined ? { log: extra.log } : {}),
        ...(extra.logAppend && extra.logAppend.length ? { logAppend: extra.logAppend } : {}),
        ...(extra.liveLine !== undefined ? { liveLine: extra.liveLine } : {}),
      },
      { channels: [GLOBAL, operationChannel(dto.id)] },
    );
  }

  /** @internal */
  release(id: string): void {
    // Keep the finished handle a little for late subscribers of the stream, then drop it.
    setTimeout(() => this.live.delete(id), 60_000).unref?.();
  }
}
