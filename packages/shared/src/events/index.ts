import { z } from 'zod';
import { OperationDtoSchema, OperationSnapshotSchema } from '../runner/operations';
import { ClaudeStatusSchema } from '../runner/claude';
import { RunDtoSchema } from '../runner/runs';
import { SystemMetricsSchema } from '../runner/system';
import {
  CliStatusSchema,
  PermissionRequestDtoSchema,
  SessionEventItemSchema,
  UsageLimitSchema,
} from '../runner/sessions';
import { IsoDateSchema, SessionStatusSchema, UuidSchema } from '../runner/common';

export * from './format';

/**
 * Server-Sent Events emitted by the runner and relayed by the web (`/api/stream/*`), plus the
 * events the web emits itself (`stream.error`, `stream.hello`: seq 0, never an `id:` line).
 *
 * Wire format: every event is a DEFAULT `message` event (no `event:` field) whose `data` is the
 * JSON envelope `{ seq, type, at, data }`; `id:` carries `seq` for `Last-Event-ID` replay.
 * Parse with {@link parseRunnerEvent}. Heartbeats (`type: 'heartbeat'`) are real events (so
 * the browser can detect a silent connection, Figma W7) sent every 15 s without an `id:` line.
 */

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const SSE_RETRY_MS = 3_000;

export const SessionStatusEventSchema = z.object({
  sessionId: UuidSchema,
  projectId: UuidSchema,
  status: SessionStatusSchema,
  /** Nuera's title (« Renommer » updates it in other tabs); absent from older runners. */
  title: z.string().optional(),
  live: z.boolean(),
  currentActivity: z.string().nullable(),
  lastInstruction: z.string().nullable(),
  lastActivityAt: IsoDateSchema.nullable(),
  startedAt: IsoDateSchema.nullable(),
  endedAt: IsoDateSchema.nullable(),
  planDone: z.number().int().nullable(),
  planTotal: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  cliStatus: CliStatusSchema.nullable(),
  pendingPermissionId: UuidSchema.nullable(),
  remoteControlUrl: z.string().nullable(),
  queuedInstructions: z.number().int(),
  /** Usage limit of the subscription and its automatic resumption; absent from older runners. */
  limit: UsageLimitSchema.nullable().optional(),
});
export type SessionStatusEvent = z.infer<typeof SessionStatusEventSchema>;

export const NotificationCreatedSchema = z.object({
  id: z.string().nullable(),
  kind: z.string(),
  severity: z.enum(['info', 'success', 'warning', 'danger']),
  title: z.string(),
  body: z.string().nullable(),
  href: z.string().nullable(),
  projectId: UuidSchema.nullable(),
  sessionId: UuidSchema.nullable(),
  /** Server the notification comes from (null: not tied to a server). Absent from older runners and webs. */
  environmentId: UuidSchema.nullable().optional(),
});
export type NotificationCreated = z.infer<typeof NotificationCreatedSchema>;

/**
 * First event of the global stream, emitted by the web (seq 0, no `id:`): the account the stream
 * was opened for, and its server (null: none assigned). A tab whose page belongs to another account
 * reloads (multi-tab identity guard). Never a proof of life of the runner.
 */
export const StreamHelloSchema = z.object({
  userId: z.string().min(1),
  environmentId: UuidSchema.nullable(),
});
export type StreamHello = z.infer<typeof StreamHelloSchema>;

const envelope = <T extends string, S extends z.ZodType>(type: T, data: S) =>
  z.object({ seq: z.number(), type: z.literal(type), at: IsoDateSchema, data });

export const RunnerEventSchema = z.discriminatedUnion('type', [
  envelope('heartbeat', z.object({})),
  /** Replay impossible (runner restarted or buffer exceeded): reload the resource, then keep listening. */
  envelope('stream.reset', z.object({ reason: z.enum(['replay_unavailable', 'runner_restarted']) })),
  /** Emitted by the web relay when the runner cannot be reached (Figma T5). */
  envelope('stream.error', z.object({ code: z.string(), message: z.string() })),
  /** Emitted by the web when the global stream opens (identity guard), see {@link StreamHelloSchema}. */
  envelope('stream.hello', StreamHelloSchema),

  envelope('session.status', SessionStatusEventSchema),
  envelope('session.event', z.object({ sessionId: UuidSchema, item: SessionEventItemSchema })),
  envelope('session.permission', z.object({ sessionId: UuidSchema, permission: PermissionRequestDtoSchema })),

  /** `log` (full journal) only on the first event of an operation stream; then `logAppend`/`liveLine`. */
  envelope(
    'operation.progress',
    z.object({
      operation: OperationDtoSchema,
      log: z.string().optional(),
      logAppend: z.array(z.string()).optional(),
      liveLine: z.string().nullable().optional(),
    }),
  ),

  envelope('run.status', z.object({ run: RunDtoSchema })),
  /** `replay: true` = buffered output sent to a new subscriber (reset the view first). */
  envelope('run.output', z.object({ runId: UuidSchema, data: z.string(), replay: z.boolean().optional() })),

  /** Serialized screen + scrollback (@xterm/addon-serialize), first event of a terminal stream. */
  envelope('terminal.snapshot', z.object({ terminalId: z.string(), data: z.string(), cols: z.number().int(), rows: z.number().int() })),
  envelope('terminal.data', z.object({ terminalId: z.string(), data: z.string() })),
  envelope('terminal.resize', z.object({ terminalId: z.string(), cols: z.number().int(), rows: z.number().int() })),
  envelope('terminal.exit', z.object({ terminalId: z.string(), exitCode: z.number().int().nullable(), signal: z.number().int().nullable() })),

  envelope('system.metrics', SystemMetricsSchema),
  envelope('claude.status', ClaudeStatusSchema),
  envelope('notification.created', NotificationCreatedSchema),
]);
export type RunnerEvent = z.infer<typeof RunnerEventSchema>;
export type RunnerEventType = RunnerEvent['type'];
export type RunnerEventOf<T extends RunnerEventType> = Extract<RunnerEvent, { type: T }>;
export type RunnerEventData<T extends RunnerEventType> = RunnerEventOf<T>['data'];

/** Event types the web may broadcast through `POST /v1/events/publish`. */
export const WEB_PUBLISHABLE_EVENT_TYPES = ['notification.created'] as const;
export const PublishEventRequestSchema = z.object({
  type: z.enum(WEB_PUBLISHABLE_EVENT_TYPES),
  data: NotificationCreatedSchema,
});

/** First event of an operation stream carries the full snapshot. */
export const OperationStreamSnapshotSchema = OperationSnapshotSchema;

/** Parses the `data` of an SSE message. Returns null for anything that does not match the contract. */
export function parseRunnerEvent(raw: string): RunnerEvent | null {
  try {
    const result = RunnerEventSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Encodes one event for the wire (`id:` only for replayable events, i.e. seq > 0). */
export function encodeSseEvent(event: RunnerEvent, options: { withId?: boolean } = {}): string {
  const withId = options.withId ?? event.seq > 0;
  return `${withId ? `id: ${event.seq}\n` : ''}data: ${JSON.stringify(event)}\n\n`;
}

/** Heartbeat frame (`seq` 0, no `id:` line, so it never moves Last-Event-ID). */
export function encodeHeartbeat(at = new Date()): string {
  return encodeSseEvent({ seq: 0, type: 'heartbeat', at: at.toISOString(), data: {} }, { withId: false });
}

/** `stream.hello` frame of the web (`seq` 0, no `id:` line). */
export function encodeStreamHello(hello: StreamHello, at = new Date()): string {
  return encodeSseEvent({ seq: 0, type: 'stream.hello', at: at.toISOString(), data: hello }, { withId: false });
}
