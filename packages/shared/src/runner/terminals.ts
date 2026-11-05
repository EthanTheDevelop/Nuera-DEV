import { z } from 'zod';
import { IsoDateSchema, UuidSchema } from './common';

/**
 * Terminal kinds:
 * - `shell`: bash/zsh (Linux) or PowerShell (Windows) in a worktree.
 * - `claude-login`: `claude auth login` — output NEVER logged nor persisted, scrollback dropped on close.
 * - `mcp-login`: `claude mcp login <name> --no-browser` (same privacy rules as claude-login).
 * - `claude-status`: interactive `claude` in a scratch folder; the owner types `/status` (or `/usage`).
 * - `session`: the PTY attached to a Claude session (created by the session manager, not by this route).
 */
export const TERMINAL_KINDS = ['shell', 'claude-login', 'mcp-login', 'claude-status', 'session'] as const;
export const TerminalKindSchema = z.enum(TERMINAL_KINDS);
export type TerminalKind = z.infer<typeof TerminalKindSchema>;

export const TerminalSizeSchema = z.object({
  cols: z.number().int().min(10).max(500),
  rows: z.number().int().min(4).max(300),
});

export const CreateTerminalRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('shell'), worktreeId: UuidSchema, cols: z.number().int().min(10).max(500).default(120), rows: z.number().int().min(4).max(300).default(32) }),
  z.object({ kind: z.literal('claude-login'), cols: z.number().int().min(10).max(500).default(120), rows: z.number().int().min(4).max(300).default(32) }),
  z.object({
    kind: z.literal('mcp-login'),
    serverName: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    cols: z.number().int().min(10).max(500).default(120),
    rows: z.number().int().min(4).max(300).default(32),
  }),
  z.object({ kind: z.literal('claude-status'), cols: z.number().int().min(10).max(500).default(120), rows: z.number().int().min(4).max(300).default(32) }),
]);
export type CreateTerminalRequest = z.input<typeof CreateTerminalRequestSchema>;

export const TerminalDtoSchema = z.object({
  id: z.string(),
  kind: TerminalKindSchema,
  title: z.string(),
  cwd: z.string().nullable(),
  worktreeId: UuidSchema.nullable(),
  sessionId: UuidSchema.nullable(),
  cols: z.number().int(),
  rows: z.number().int(),
  alive: z.boolean(),
  exitCode: z.number().int().nullable(),
  /** Output is never persisted for login terminals. */
  private: z.boolean(),
  subscribers: z.number().int(),
  createdAt: IsoDateSchema,
  lastActivityAt: IsoDateSchema,
});
export type TerminalDto = z.infer<typeof TerminalDtoSchema>;

export const TerminalParamsSchema = z.object({ terminalId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) });
export const TerminalsListResponseSchema = z.object({ terminals: z.array(TerminalDtoSchema) });

export const TerminalInputRequestSchema = z.object({
  /** Raw keystrokes (xterm `onData`), batched by the browser (~10 ms). */
  data: z.string().min(1).max(64 * 1024),
});
export const TerminalResizeRequestSchema = TerminalSizeSchema.extend({
  /** Browser tab identifier: the last client that resizes wins. */
  clientId: z.string().max(64).optional(),
});
