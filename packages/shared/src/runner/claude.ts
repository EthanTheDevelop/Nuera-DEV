import { z } from 'zod';
import { IsoDateSchema } from './common';

/**
 * Output of `claude auth status --json`, whitelisted. Only fields the CLI prints itself; the
 * runner never reads `~/.claude/.credentials.json` nor account fields of `~/.claude.json`.
 */
export const ClaudeAuthSchema = z.object({
  loggedIn: z.boolean(),
  /** `none` | `claude.ai` | `oauth_token` | `api_key` | `api_key_helper` | `third_party` (CLI 2.1.x). */
  authMethod: z.string().nullable(),
  apiProvider: z.string().nullable(),
  /** Plan when the CLI exposes it (`max`…), otherwise null — never guessed. */
  subscriptionType: z.string().nullable(),
  /** End of the stored claude.ai sign-in (CLI ≥ 2.1.318). */
  loginExpiresAt: IsoDateSchema.nullable(),
  email: z.string().nullable(),
  organization: z.string().nullable(),
});
export type ClaudeAuth = z.infer<typeof ClaudeAuthSchema>;

export const ClaudeAgentSchema = z.object({
  sessionId: z.string().nullable(),
  name: z.string().nullable(),
  kind: z.string().nullable(),
  state: z.string().nullable(),
  status: z.string().nullable(),
  waitingFor: z.string().nullable(),
  cwd: z.string().nullable(),
  pid: z.number().int().nullable(),
  startedAt: IsoDateSchema.nullable(),
});

export const ClaudeStatusSchema = z.object({
  checkedAt: IsoDateSchema,
  installed: z.boolean(),
  version: z.string().nullable(),
  /** null when `auth status` could not be run. */
  auth: ClaudeAuthSchema.nullable(),
  /** `connected` = claude.ai login (subscription) · `wrong_method` = API key/token (billing risk, no Remote Control). */
  state: z.enum(['connected', 'disconnected', 'wrong_method', 'not_installed', 'error']),
  agents: z.array(ClaudeAgentSchema).nullable(),
  error: z.string().nullable(),
});
export type ClaudeStatus = z.infer<typeof ClaudeStatusSchema>;

export const ClaudeStatusQuerySchema = z.object({
  refresh: z
    .union([z.boolean(), z.enum(['1', '0', 'true', 'false'])])
    .optional()
    .transform((v) => v === true || v === '1' || v === 'true'),
});

export const MCP_CLI_STATES = ['connected', 'needs_auth', 'failed', 'pending', 'rejected', 'disabled', 'blocked', 'not_configured', 'unknown'] as const;
export const McpCliStatusSchema = z.object({
  name: z.string(),
  state: z.enum(MCP_CLI_STATES),
  /** `Status:` line as printed by the CLI. */
  statusLine: z.string().nullable(),
  /** Redacted `claude mcp get` output (shown « à un clic »). */
  raw: z.string(),
  checkedAt: IsoDateSchema,
});
export type McpCliStatus = z.infer<typeof McpCliStatusSchema>;
export const McpNameParamsSchema = z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) });

/**
 * `claude mcp add-json --scope user <name> <json>` / `claude mcp remove --scope user <name>`.
 * The JSON must not contain secrets (use `headersHelper: 'nuera'` for authenticated servers).
 */
export const McpSyncRequestSchema = z.object({
  upsert: z
    .array(z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), config: z.record(z.string(), z.unknown()) }))
    .max(50)
    .default([]),
  remove: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)).max(50).default([]),
});
export const McpSyncResultSchema = z.object({
  results: z.array(
    z.object({ name: z.string(), action: z.enum(['upsert', 'remove']), ok: z.boolean(), raw: z.string() }),
  ),
});
