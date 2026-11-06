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
});
export type RunDto = z.infer<typeof RunDtoSchema>;

export const RunParamsSchema = z.object({ runId: UuidSchema });
