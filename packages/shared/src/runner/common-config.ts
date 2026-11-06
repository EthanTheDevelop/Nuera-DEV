import { z } from 'zod';
import { IsoDateSchema } from './common';

/**
 * « Configuration Claude commune » (lot K1): what the web serves to the runner of a server
 * (`POST /api/internal/claude-config`, token of the server) and what the runner reports after
 * writing it in the Claude Code configuration folder of the server.
 *
 * - rules « Par défaut » → `<CLAUDE_CONFIG_DIR>/rules/nuera-commun.md` (user-level memory: loaded by
 *   the CLI before the project's CLAUDE.md, which may refine them);
 * - rules « Imposé » → a file given to every session with `--append-system-prompt-file` (system
 *   prompt: a project CLAUDE.md cannot take precedence);
 * - skills → `<CLAUDE_CONFIG_DIR>/skills/<name>/`, each folder marked by {@link COMMON_SKILL_MARKER}
 *   (only marked folders are ever replaced or removed by the runner).
 *
 * Permissions, environment and MCP servers travel with the launch options of each session.
 */

/** File written in every skill folder managed by Nuera Dev (never part of a skill). */
export const COMMON_SKILL_MARKER = '.nuera-commun.json';
/** Default rules, inside `<CLAUDE_CONFIG_DIR>/rules/`. */
export const COMMON_RULES_FILE = 'nuera-commun.md';

/** Skill name = folder name = `/name` in the CLI. */
export const COMMON_SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const COMMON_SKILL_LIMITS = {
  /** Files of one skill (SKILL.md included). */
  maxFiles: 100,
  /** One file, in bytes (UTF-8). */
  maxFileBytes: 512 * 1024,
  /** One skill, every file together. */
  maxSkillBytes: 2 * 1024 * 1024,
  /** Every skill of the instance together (what one runner may receive). */
  maxTotalBytes: 16 * 1024 * 1024,
  /** Folder depth inside the skill (`references/x.md` = 2). */
  maxDepth: 6,
  /** Path length. */
  maxPathLength: 200,
} as const;

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

/**
 * Relative POSIX path of a file inside a skill folder: segments of letters, digits, `._-`, no
 * hidden file (`.x`), no `.`/`..`, no backslash, no absolute path, bounded depth and length.
 */
export function isSafeSkillPath(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > COMMON_SKILL_LIMITS.maxPathLength) return false;
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/')) return false;
  const segments = value.split('/');
  if (segments.length > COMMON_SKILL_LIMITS.maxDepth) return false;
  return segments.every((segment) => SEGMENT.test(segment) && segment !== '.' && segment !== '..' && !segment.endsWith('.'));
}

export const CommonSkillFileSchema = z.object({
  path: z.string().refine(isSafeSkillPath, 'chemin de fichier invalide'),
  content: z.string().max(COMMON_SKILL_LIMITS.maxFileBytes),
  /** Written with the execute bit (scripts of a skill whose scripts an administrator allowed). */
  executable: z.boolean(),
});
export type CommonSkillFile = z.infer<typeof CommonSkillFileSchema>;

export const CommonSkillSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().regex(COMMON_SKILL_NAME),
  description: z.string().max(1024),
  version: z.number().int().positive(),
  /** sha256 hex of the files (what the runner compares with the marker of the folder). */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  locked: z.boolean(),
  /** null: unchanged since the runner's copy (`have` of the request), keep the folder as it is. */
  files: z.array(CommonSkillFileSchema).max(COMMON_SKILL_LIMITS.maxFiles).nullable(),
});
export type CommonSkill = z.infer<typeof CommonSkillSchema>;

export const CommonRuleRefSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().max(200),
  version: z.number().int().positive(),
  locked: z.boolean(),
});

export const CommonConfigPayloadSchema = z.object({
  /** sha256 hex of rules + skills (the launch options of a session carry the same value). */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Global revision of the instance configuration (« révision N »). */
  revision: z.number().int().nonnegative(),
  generatedAt: IsoDateSchema,
  rules: z.object({
    /** Markdown of the « Par défaut » rules, null when none applies. */
    defaultMarkdown: z.string().max(1024 * 1024).nullable(),
    /** Markdown of the « Imposé » rules, null when none applies. */
    lockedMarkdown: z.string().max(1024 * 1024).nullable(),
    items: z.array(CommonRuleRefSchema).max(500),
  }),
  skills: z.array(CommonSkillSchema).max(200),
});
export type CommonConfigPayload = z.infer<typeof CommonConfigPayloadSchema>;

/** Runner → web: the skills it already holds (their files are then omitted). */
export const CommonConfigRequestSchema = z.object({
  /**
   * Account (personal space) of the server whose configuration is asked (contract 3: one Claude config
   * folder per account). Omitted: the server's first account. The web checks it works on the server.
   */
  spaceId: z.uuid().optional(),
  have: z
    .array(z.object({ name: z.string().regex(COMMON_SKILL_NAME), hash: z.string().regex(/^[0-9a-f]{64}$/) }))
    .max(200)
    .default([]),
});
export type CommonConfigRequest = z.input<typeof CommonConfigRequestSchema>;

export const CommonConfigStatusSchema = z.object({
  /** Hash of the configuration written on the server (null: never synchronised). */
  hash: z.string().nullable(),
  revision: z.number().int().nullable(),
  appliedAt: IsoDateSchema.nullable(),
  /** Last attempt (successful or not). */
  checkedAt: IsoDateSchema.nullable(),
  skills: z.array(z.object({ name: z.string(), version: z.number().int(), hash: z.string() })),
  /** Skills NOT written: a folder of the same name that Nuera Dev does not manage, a refused path… */
  conflicts: z.array(z.object({ name: z.string(), reason: z.string() })),
  rules: z.object({ defaultFile: z.boolean(), lockedFile: z.boolean(), count: z.number().int().nonnegative() }),
  /** French message of the last failure (web unreachable, folder not writable…), null otherwise. */
  error: z.string().nullable(),
});
export type CommonConfigStatus = z.infer<typeof CommonConfigStatusSchema>;

export const CommonConfigSyncRequestSchema = z.object({
  reason: z.enum(['changed', 'manual', 'launch', 'start']).default('changed'),
  /** One account of the server only (contract 3); omitted: every account of the server. */
  spaceId: z.uuid().optional(),
});

/** Launch options of a session: which common configuration it must start with. */
export const CommonConfigLaunchSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  revision: z.number().int().nonnegative(),
});
export type CommonConfigLaunch = z.infer<typeof CommonConfigLaunchSchema>;
