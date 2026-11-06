import { z } from 'zod';
import { ATTACHMENT_KINDS, ATTACHMENT_MAX_BYTES } from './attachments';
import { PermissionModeSchema } from './common';
import { ModelNameSchema, SessionDtoSchema } from './sessions';

/**
 * Composer of the Workspace (« comme un chat Claude Code ») — pieces jointes, model and permission
 * mode chips, skills of the palette. Every effect stays inside the official interactive CLI: files
 * are written in the worktree and referenced with `@<chemin>` in the instruction (the CLI reads
 * them itself), `/model <alias>` is typed into the TUI, the mode is cycled with Maj+Tab.
 */

// ---------------------------------------------------------------------------------------------
// Pieces jointes (constants and types: ./attachments)
// ---------------------------------------------------------------------------------------------

export * from './attachments';

/** Base64 of {@link ATTACHMENT_MAX_BYTES} plus padding. */
const MAX_BASE64 = Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4;

export const AttachmentUploadRequestSchema = z
  .object({
    /** Original name (sanitised by the runner: never used as a path). */
    name: z.string().trim().min(1, 'nom de fichier requis').max(255, 'nom de fichier trop long'),
    /** Type announced by the browser (informative: the runner checks the bytes). */
    contentType: z.string().trim().max(120).default(''),
    dataBase64: z
      .string()
      .min(1, 'fichier vide')
      .max(MAX_BASE64, 'fichier trop volumineux (20 Mo au maximum)')
      .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'contenu illisible'),
  })
  .strict();
export type AttachmentUploadRequest = z.infer<typeof AttachmentUploadRequestSchema>;

export const AttachmentDtoSchema = z.object({
  /** Relative to the worktree (`.nuera/pieces-jointes/20261106-142501-capture.png`), for `@<chemin>`. */
  path: z.string(),
  name: z.string(),
  size: z.number().int().nonnegative(),
  kind: z.enum(ATTACHMENT_KINDS),
  contentType: z.string(),
});
export type AttachmentDto = z.infer<typeof AttachmentDtoSchema>;

// ---------------------------------------------------------------------------------------------
// Slash commands typed by the runner (allowlist) and permission mode
// ---------------------------------------------------------------------------------------------

/**
 * The only slash commands the runner types on its own (chips of the composer). Anything else the
 * owner types goes through the instruction route like any text.
 */
export const SESSION_SLASH_COMMANDS = ['model'] as const;

export const SessionSlashCommandRequestSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('model'), model: ModelNameSchema }).strict(),
]);
export type SessionSlashCommandRequest = z.infer<typeof SessionSlashCommandRequestSchema>;

/** Exact text typed into the TUI for an allowlisted command (no newline, no escape: the schema forbids them). */
export function slashCommandText(command: SessionSlashCommandRequest): string {
  switch (command.command) {
    case 'model':
      return `/model ${command.model}`;
  }
}

export const SessionCommandResultSchema = z.object({
  session: SessionDtoSchema,
  /** `live`: typed into the running CLI (and confirmed on its screen); `next_launch`: stored for the next start or resumption. */
  applied: z.enum(['live', 'next_launch']),
});
export type SessionCommandResult = z.infer<typeof SessionCommandResultSchema>;

/** Modes reachable with Maj+Tab in the interactive CLI (bypass is never in the cycle Nuera launches). */
export const SWITCHABLE_PERMISSION_MODES = ['manual', 'acceptEdits', 'plan', 'auto'] as const;
export const SwitchablePermissionModeSchema = z.enum(SWITCHABLE_PERMISSION_MODES);
export type SwitchablePermissionMode = z.infer<typeof SwitchablePermissionModeSchema>;

export const PermissionModeRequestSchema = z
  .object({ mode: SwitchablePermissionModeSchema })
  .strict();

export const PermissionModeResultSchema = z.object({
  session: SessionDtoSchema,
  applied: z.enum(['live', 'next_launch']),
  /** Maj+Tab presses sent to the CLI. */
  presses: z.number().int().nonnegative(),
  mode: PermissionModeSchema,
});
export type PermissionModeResult = z.infer<typeof PermissionModeResultSchema>;

// ---------------------------------------------------------------------------------------------
// Skills (palette « / »)
// ---------------------------------------------------------------------------------------------

export const SessionSkillSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  /**
   * `project`: `.claude/skills` of the worktree; `user`: `skills` of the CLI config dir of the server;
   * `common`: a skill of the instance written there by Nuera Dev (« commun », marked folder).
   */
  source: z.enum(['project', 'user', 'common']),
});
export type SessionSkill = z.infer<typeof SessionSkillSchema>;

export const SessionSkillsResponseSchema = z.object({
  skills: z.array(SessionSkillSchema),
  truncated: z.boolean(),
});
export type SessionSkillsResponse = z.infer<typeof SessionSkillsResponseSchema>;
