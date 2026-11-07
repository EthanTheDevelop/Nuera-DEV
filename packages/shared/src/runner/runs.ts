import { z } from 'zod';
import { CommandKindSchema, CommandRunStatusSchema, GitIdentitySchema, IsoDateSchema, UuidSchema } from './common';
import { TestCountsSchema } from './sessions';

export const TestCaseSchema = z.object({
  name: z.string(),
  status: z.enum(['passed', 'failed', 'running', 'skipped']),
  durationMs: z.number().nullable(),
  /** `file:line` when the reporter prints it. */
  location: z.string().nullable(),
});
export type TestCase = z.infer<typeof TestCaseSchema>;

export const TestFailureSchema = z.object({
  name: z.string(),
  location: z.string().nullable(),
  /** First lines of the failure (exact output, never rephrased). */
  excerpt: z.string(),
});

export const TestReportSchema = z.object({
  counts: TestCountsSchema,
  tests: z.array(TestCaseSchema),
  failures: z.array(TestFailureSchema),
});
export type TestReport = z.infer<typeof TestReportSchema>;

// --- Dev servers (« Lancement ») ------------------------------------------------------------------

/** Name of a dev server of a project (« client », « admin »): short, lower-case, no spaces. */
export const DEV_SERVER_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,23}$/;
export const DevServerNameSchema = z
  .string()
  .trim()
  .regex(DEV_SERVER_NAME_RE, 'nom de serveur invalide (minuscules, chiffres, . _ -, 24 caractères au maximum)');
/** Name of the project's default dev server (`projects.commands.dev`) when it has none (`devName`). */
export const DEFAULT_DEV_SERVER_NAME = 'dev';
/** Dev servers a project may declare (the default one included). */
export const MAX_DEV_SERVERS = 6;

/** The dev-server part of `projects.commands` (backward compatible: `dev` alone = one server). */
export interface DevServerCommands {
  /** Default dev server (the historic single « Lancement » command). */
  dev?: string | null;
  /** Its name (default {@link DEFAULT_DEV_SERVER_NAME}). */
  devName?: string | null;
  /** Further named dev servers of the same worktree (« admin » `pnpm --filter admin dev`). */
  devServers?: ReadonlyArray<{ name?: unknown; command?: unknown }> | null;
}

export interface DevServerEntry {
  name: string;
  command: string;
  /** The default one (`commands.dev`). */
  isDefault: boolean;
}

/**
 * Dev servers of a project, default first: `commands.dev` (named `devName`, else « dev »), then
 * `commands.devServers` in their order. Empty commands, invalid or repeated names are skipped
 * (a stored value is never trusted blindly), at most {@link MAX_DEV_SERVERS}.
 */
export function devServerEntries(commands: DevServerCommands | null | undefined): DevServerEntry[] {
  const entries: DevServerEntry[] = [];
  const seen = new Set<string>();
  const add = (name: unknown, command: unknown, isDefault: boolean) => {
    if (typeof command !== 'string' || !command.trim() || entries.length >= MAX_DEV_SERVERS) return;
    const value = typeof name === 'string' ? name.trim() : '';
    if (!DEV_SERVER_NAME_RE.test(value) || seen.has(value)) return;
    seen.add(value);
    entries.push({ name: value, command: command.trim(), isDefault });
  };
  if (commands) {
    add(commands.devName || DEFAULT_DEV_SERVER_NAME, commands.dev, true);
    for (const extra of commands.devServers ?? []) add(extra?.name, extra?.command, false);
  }
  return entries;
}

export const CreateRunRequestSchema = z.object({
  projectId: UuidSchema,
  /** Default: the project's primary worktree. */
  worktreeId: UuidSchema.optional(),
  kind: CommandKindSchema,
  /**
   * The project's own command (« npm run test -- crm »), executed through the platform shell
   * (`/bin/sh -c` on Linux, `cmd.exe /d /s /c` on Windows). Default: `projects.commands[kind]`.
   */
  command: z.string().trim().min(1).max(4000).optional(),
  /** Project variables (decrypted by the web). Protected names are refused. */
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string().max(32_768)).default({}),
  cols: z.number().int().min(20).max(500).default(120),
  rows: z.number().int().min(5).max(300).default(30),
  /** Account starting the command (`command_runs.actor_user_id`). */
  actorUserId: z.string().nullish(),
  /** Author and committer of commits made by the command (GIT_AUTHOR_* / GIT_COMMITTER_*, injected by the runner). */
  gitIdentity: GitIdentitySchema.nullish(),
  /**
   * Dev server (`kind: 'dev'`): its name among the project's (`devServerEntries`). Several dev
   * servers may run in one worktree, never two of the same name. Default: the project's default one.
   */
  name: DevServerNameSchema.optional(),
});
export type CreateRunRequest = z.input<typeof CreateRunRequestSchema>;

export const RunDtoSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  worktreeId: UuidSchema.nullable(),
  kind: CommandKindSchema,
  command: z.string(),
  status: CommandRunStatusSchema,
  exitCode: z.number().int().nullable(),
  pid: z.number().int().nullable(),
  /** Port detected in the output (« port 3000 »). */
  port: z.number().int().nullable(),
  /** « 10 / 10 réussis » */
  summary: z.string().nullable(),
  tests: TestReportSchema.nullable(),
  startedAt: IsoDateSchema,
  finishedAt: IsoDateSchema.nullable(),
  /** Still attached to a live process in this runner. */
  live: z.boolean(),
  /** Dev server name (« client »); null for other commands and runs of older runners. */
  name: z.string().nullish(),
});
export type RunDto = z.infer<typeof RunDtoSchema>;

export const RunParamsSchema = z.object({ runId: UuidSchema });
