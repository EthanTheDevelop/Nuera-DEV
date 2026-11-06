import { z } from 'zod';
import { IsoDateSchema, SessionBackendSchema, UuidSchema } from './common';

/**
 * Version of the runner ⇄ web contract, exposed by `/v1/health` (`contractVersion`). The web politely
 * refuses a route newer than the contract of the runner it talks to (a runner without the field is
 * version 1). Every field added for version 2 is optional, so older runners and webs keep working.
 */
export const RUNNER_CONTRACT_VERSION = 2;

/**
 * Availability key of a server in `uptime_daily`: `runner` for the default server (its history is
 * kept), `runner:<environmentId>` for the others.
 */
export function uptimeServiceKey(environment: { id: string; isDefault: boolean }): string {
  return environment.isDefault ? 'runner' : `runner:${environment.id}`;
}

/** Server (environment) a runner serves, as shown by `/v1/health`. */
export const RunnerEnvironmentRefSchema = z.object({ id: UuidSchema, name: z.string() });
export type RunnerEnvironmentRef = z.infer<typeof RunnerEnvironmentRefSchema>;

/**
 * - `ready`: registered, holds the lease of its server, serves every route;
 * - `starting`: registered, start-up tasks still running;
 * - `unregistered`: its token matches no server (or a retired one): health only, 503 `ENVIRONMENT_UNREGISTERED` elsewhere;
 * - `disabled`: its server is suspended: reading and stopping only (`ENVIRONMENT_DISABLED`).
 */
export const RUNNER_STATES = ['ready', 'starting', 'unregistered', 'disabled'] as const;
export const RunnerStateSchema = z.enum(RUNNER_STATES);
export type RunnerState = z.infer<typeof RunnerStateSchema>;

export const SystemMetricsSchema = z.object({
  sampledAt: IsoDateSchema,
  hostname: z.string(),
  platform: z.string(),
  /** Whole-machine CPU usage over the last sampling window (0–100). */
  cpuPercent: z.number(),
  cpuCount: z.number().int(),
  /** 1, 5 and 15 minute load averages (zeros on Windows). */
  load: z.tuple([z.number(), z.number(), z.number()]),
  memory: z.object({
    usedBytes: z.number(),
    totalBytes: z.number(),
    freeBytes: z.number(),
    /** `cgroup` when the container limit is lower than the host memory. */
    source: z.enum(['cgroup', 'os']),
  }),
  /** File system holding NUERA_PROJECTS_ROOT. */
  disk: z.object({ path: z.string(), usedBytes: z.number(), totalBytes: z.number(), freeBytes: z.number() }).nullable(),
  /** Host uptime and runner process uptime, in seconds. */
  uptimeSec: z.number(),
  runnerUptimeSec: z.number(),
  sessions: z.object({ live: z.number().int(), max: z.number().int() }),
  runs: z.object({ live: z.number().int() }),
  terminals: z.object({ live: z.number().int() }),
});
export type SystemMetrics = z.infer<typeof SystemMetricsSchema>;

export const UptimeQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
  service: z.enum(['runner', 'web', 'claude']).default('runner'),
});

export const UptimeIncidentSchema = z.object({ start: IsoDateSchema, end: IsoDateSchema.nullable(), reason: z.string() });
export const UptimeDaySchema = z.object({
  day: z.string(),
  upMinutes: z.number().int(),
  expectedMinutes: z.number().int(),
  /** 0–100, null when nothing was expected that day (before the first heartbeat). */
  availability: z.number().nullable(),
  incidents: z.array(UptimeIncidentSchema),
});
export const UptimeResponseSchema = z.object({
  service: z.string(),
  days: z.array(UptimeDaySchema),
  /** Weighted availability over the period (« 99,95 % »). */
  availabilityPercent: z.number().nullable(),
  /** Seconds since the runner process started. */
  runningSinceSec: z.number(),
});
export type UptimeResponse = z.infer<typeof UptimeResponseSchema>;

export const ToolAvailabilitySchema = z.object({
  available: z.boolean(),
  version: z.string().nullable(),
  error: z.string().nullable(),
});

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  service: z.literal('runner'),
  version: z.string(),
  startedAt: IsoDateSchema,
  uptimeSec: z.number(),
  backend: SessionBackendSchema,
  git: ToolAvailabilitySchema,
  tmux: ToolAvailabilitySchema,
  claude: ToolAvailabilitySchema,
  database: z.object({ ok: z.boolean(), error: z.string().nullable() }),
  disk: z.object({ path: z.string(), freeBytes: z.number(), totalBytes: z.number() }).nullable(),
  projectsRoot: z.string(),
  dataDir: z.string(),
  /** Server served by this runner; null while unregistered. Absent from runners older than contract 2. */
  environment: RunnerEnvironmentRefSchema.nullable().optional(),
  /** Absent from runners older than contract 2 (= `ready`). */
  state: RunnerStateSchema.optional(),
  /** {@link RUNNER_CONTRACT_VERSION} of the runner; absent = 1. */
  contractVersion: z.number().int().positive().optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
