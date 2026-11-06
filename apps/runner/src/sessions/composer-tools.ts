import { lstat, mkdir, open, readdir, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Database } from '@nuera/db';
import { isPathInside } from '@nuera/shared/paths';
import {
  ATTACHMENT_DIR,
  ATTACHMENT_EXCLUDE_LINE,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_FILES_PER_WORKTREE,
  ATTACHMENT_TYPES_TEXT,
  attachmentExtension,
  attachmentKindOf,
  type AttachmentDto,
  type AttachmentKind,
  type AttachmentUploadRequest,
  type PermissionModeValue,
  type SessionSkill,
  type SessionSkillsResponse,
} from '@nuera/shared/runner';
import { getSessionRow } from '../db/lookups';
import type { EnvironmentScope } from '../environment';
import { RunnerError } from '../errors';
import type { Git } from '../git/git';
import type { GitService } from '../git/service';
import { PLATFORM, type PathGuard } from '../safety/paths';

/**
 * Composer tools of a session that touch the disk (the CLI keys live in the session manager):
 * « Joindre » writes one uploaded file in the session's worktree, the palette lists the skills.
 * Uploads are untrusted: the name never becomes a path (sanitised, prefixed by the time), the
 * folder is realpath-confined to the worktree and must be a real directory (a symlink planted by
 * Claude is refused), the file is created exclusively (`wx`), types are checked by their bytes,
 * and the folder is git-ignored through the clone's `info/exclude` — never the project's .gitignore.
 */

// ---------------------------------------------------------------------------------------------
// Pure helpers (tested)
// ---------------------------------------------------------------------------------------------

/** `Capture d'écran 2026-11-06 à 14.25.png` → `capture-d-ecran-2026-11-06-a-14.25.png` (≤ 80 chars, extension kept). */
export function sanitizeAttachmentName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const ext = attachmentExtension(base);
  const stem = ext ? base.slice(0, base.length - ext.length - 1) : base;
  const clean = (value: string) =>
    value
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '');
  const cleanExt = clean(ext);
  const cleanStem =
    clean(stem)
      .slice(0, Math.max(1, 80 - cleanExt.length - 1))
      .replace(/[-.]+$/g, '') || 'fichier';
  return cleanExt ? `${cleanStem}.${cleanExt}` : cleanStem;
}

/** `20261106-142501` in the server's local time (sortable, no separator Claude could misread). */
export function attachmentStamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.length >= offset + signature.length &&
  signature.every((value, i) => bytes[offset + i] === value);

/** Image format by its first bytes (null: not an image Claude Code reads). */
export function sniffImage(bytes: Uint8Array): 'png' | 'jpeg' | 'gif' | 'webp' | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
    return 'webp';
  return null;
}

const IMAGE_EXT_FORMAT: Record<string, string> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  gif: 'gif',
  webp: 'webp',
};
const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * Checks the bytes against the kind the name announces. Returns the stored content type, or throws
 * a French VALIDATION error (« Ce fichier n'est pas une image PNG valide. »).
 */
export function checkAttachmentContent(
  name: string,
  kind: AttachmentKind,
  bytes: Uint8Array,
): string {
  const refuse = (message: string) =>
    new RunnerError('VALIDATION', message, {
      reason: 'ATTACHMENT_REFUSED',
      untouched: "Aucun fichier n'a été écrit.",
    });
  if (bytes.length === 0) throw refuse('Fichier vide : rien à joindre.');
  if (bytes.length > ATTACHMENT_MAX_BYTES)
    throw refuse('Fichier trop volumineux : 20 Mo au maximum.');
  if (kind === 'image') {
    const format = sniffImage(bytes);
    const expected = IMAGE_EXT_FORMAT[attachmentExtension(name)];
    if (!format || format !== expected)
      throw refuse(
        `« ${name} » n'est pas une image ${(expected ?? 'valide').toUpperCase()} lisible.`,
      );
    return CONTENT_TYPES[format]!;
  }
  if (kind === 'pdf') {
    if (!startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]))
      throw refuse(`« ${name} » n'est pas un PDF lisible.`);
    return 'application/pdf';
  }
  if (bytes.includes(0))
    throw refuse(
      `« ${name} » contient des données binaires : seuls le texte et le code sont acceptés.`,
    );
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw refuse(`« ${name} » n'est pas un texte UTF-8.`);
  }
  return 'text/plain; charset=utf-8';
}

/** `name` / `description` of a SKILL.md front matter (simple YAML: `key: value`, quotes, `>`/`|` blocks). */
export function parseSkillFrontmatter(text: string): {
  name: string | null;
  description: string | null;
} {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
  if (!match) return { name: null, description: null };
  const lines = match[1]!.split(/\r?\n/);
  const fields: Record<string, string> = {};
  for (let i = 0; i < lines.length; i += 1) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    let value = kv[2]!.trim();
    if (/^[>|][-+]?$/.test(value)) {
      const block: string[] = [];
      while (
        i + 1 < lines.length &&
        (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1]!.trim() === '')
      ) {
        i += 1;
        block.push(lines[i]!.trim());
      }
      value = block.join(' ').trim();
    }
    value = value.replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
    fields[key] = value;
  }
  return { name: fields.name || null, description: fields.description || null };
}

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/;
const MAX_SKILLS = 100;
const SKILL_READ_BYTES = 16 * 1024;

/**
 * Permission mode shown on the CLI's screen (its footer: « ⏵⏵ accept edits on (shift+tab to
 * cycle) », « ⏸ plan mode on », « ⏵⏵ auto mode on »…). No marker in the last lines = Manual (the
 * real CLI shows none in that mode). Null for an empty screen.
 */
export function detectPermissionMode(screen: string): PermissionModeValue | null {
  const lines = screen
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const footer = lines.slice(-6).join(' ').toLowerCase();
  if (/plan mode on/.test(footer)) return 'plan';
  if (/accept edits on/.test(footer)) return 'acceptEdits';
  if (/bypass permissions on/.test(footer)) return 'bypassPermissions';
  if (/don'?t ask (mode )?on/.test(footer)) return 'dontAsk';
  if (/auto mode on/.test(footer)) return 'auto';
  return 'manual';
}

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

export interface ComposerToolsDeps {
  db: Database;
  environment: EnvironmentScope;
  git: GitService;
  gitCli: Git;
  paths: PathGuard;
  /** NUERA_CLAUDE_CONFIG_DIR, else `~/.claude` of the runner's user (skills of the user). */
  claudeConfigDir?: string | null;
}

export class ComposerTools {
  constructor(private readonly deps: ComposerToolsDeps) {}

  private async sessionCwd(sessionId: string): Promise<string> {
    const row = await getSessionRow(this.deps.db, this.deps.environment.id, sessionId);
    if (row.status === 'archived')
      throw new RunnerError('CONFLICT', 'Session archivée : elle ne reçoit plus de pièce jointe.', {
        reason: 'SESSION_NOT_RESUMABLE',
      });
    if (!row.worktreeId)
      throw new RunnerError('CONFLICT', "La session n'a plus de worktree.", {
        reason: 'WORKTREE_MISSING',
      });
    const { cwd } = await this.deps.git.resolveWorktree(row.worktreeId);
    return cwd;
  }

  /** « Joindre »: one file in `<worktree>/.nuera/pieces-jointes/<horodatage>-<nom>`. */
  async saveAttachment(
    sessionId: string,
    input: AttachmentUploadRequest,
    now = new Date(),
  ): Promise<AttachmentDto> {
    const kind = attachmentKindOf(input.name);
    if (!kind) {
      throw new RunnerError(
        'VALIDATION',
        `Type de fichier refusé : ${ATTACHMENT_TYPES_TEXT} seulement.`,
        { reason: 'ATTACHMENT_REFUSED', untouched: "Aucun fichier n'a été écrit." },
      );
    }
    const bytes = Buffer.from(input.dataBase64, 'base64');
    const contentType = checkAttachmentContent(input.name, kind, bytes);
    const cwd = await this.sessionCwd(sessionId);
    const dir = await this.attachmentDir(cwd);
    const existing = (await readdir(dir)).filter((name) => !name.startsWith('.'));
    if (existing.length >= ATTACHMENT_MAX_FILES_PER_WORKTREE) {
      throw new RunnerError(
        'CONFLICT',
        `Le dossier ${ATTACHMENT_DIR} contient déjà ${existing.length} fichiers : videz-le avant d'en joindre d'autres.`,
        {
          reason: 'ATTACHMENT_LIMIT',
          untouched: "Aucun fichier n'a été écrit.",
        },
      );
    }
    await this.ensureExcluded(cwd);
    const base = `${attachmentStamp(now)}-${sanitizeAttachmentName(input.name)}`;
    const taken = new Set(existing);
    let fileName = base;
    for (let n = 2; taken.has(fileName); n += 1) {
      const ext = path.extname(base);
      fileName = `${base.slice(0, base.length - ext.length)}-${n}${ext}`;
    }
    const target = path.join(dir, fileName);
    // `wx`: created here or refused (never through a symlink, never over an existing file).
    const handle = await open(target, 'wx', 0o644);
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    return {
      path: `${ATTACHMENT_DIR}/${fileName}`,
      name: input.name.slice(0, 255),
      size: bytes.length,
      kind,
      contentType,
    };
  }

  /** The folder, created inside the worktree; every segment must be a real directory there. */
  private async attachmentDir(cwd: string): Promise<string> {
    const root = await this.deps.paths.confineProjectPath(cwd);
    let current = root;
    for (const segment of ATTACHMENT_DIR.split('/')) {
      current = path.join(current, segment);
      try {
        await mkdir(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new RunnerError(
          'VALIDATION',
          `${ATTACHMENT_DIR} n'est pas un dossier du worktree : pièce jointe refusée.`,
          {
            reason: 'PATH_REJECTED',
            untouched: "Aucun fichier n'a été écrit.",
          },
        );
      }
    }
    const real = await realpath(current);
    if (!isPathInside(root, real, PLATFORM, { allowEqual: false })) {
      throw new RunnerError(
        'VALIDATION',
        'Dossier des pièces jointes hors du worktree : pièce jointe refusée.',
        { reason: 'PATH_REJECTED', untouched: "Aucun fichier n'a été écrit." },
      );
    }
    return real;
  }

  /** `/.nuera/` in the clone's `info/exclude` (shared by its worktrees), added once. */
  private async ensureExcluded(cwd: string): Promise<void> {
    const out = await this.deps.gitCli.tryOutput(['rev-parse', '--git-path', 'info/exclude'], {
      cwd,
      timeoutMs: 20_000,
    });
    if (!out)
      throw new RunnerError('UPSTREAM', "Le fichier d'exclusion Git du worktree est introuvable.", {
        reason: 'GIT_FAILED',
        untouched: "Aucun fichier n'a été écrit.",
      });
    const file = path.resolve(cwd, out);
    if (!this.deps.paths.isInsideProjects(file)) {
      throw new RunnerError('VALIDATION', "Fichier d'exclusion Git hors du dossier des projets.", {
        reason: 'PATH_REJECTED',
        untouched: "Aucun fichier n'a été écrit.",
      });
    }
    await mkdir(path.dirname(file), { recursive: true });
    let current = '';
    try {
      current = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (current.split(/\r?\n/).some((line) => line.trim() === ATTACHMENT_EXCLUDE_LINE)) return;
    const handle = await open(file, 'a');
    try {
      const prefix = current && !current.endsWith('\n') ? '\n' : '';
      await handle.writeFile(
        `${prefix}# Nuera Dev : pièces jointes du compositeur\n${ATTACHMENT_EXCLUDE_LINE}\n`,
      );
    } finally {
      await handle.close();
    }
  }

  /** Palette « / »: `.claude/skills/*\/SKILL.md` of the worktree, then `skills/*\/SKILL.md` of the CLI config dir. */
  async listSkills(sessionId: string): Promise<SessionSkillsResponse> {
    const cwd = await this.sessionCwd(sessionId);
    const skills: SessionSkill[] = [];
    let truncated = false;
    const seen = new Set<string>();
    const roots: Array<{ dir: string; source: SessionSkill['source'] }> = [];
    try {
      roots.push({
        dir: await this.deps.paths.resolveInWorktree(cwd, '.claude/skills'),
        source: 'project',
      });
    } catch {
      // no project skill (or a link out of the worktree: ignored)
    }
    const configDir = this.deps.claudeConfigDir?.trim() || path.join(os.homedir(), '.claude');
    try {
      roots.push({ dir: await realpath(path.join(configDir, 'skills')), source: 'user' });
    } catch {
      // no user skill
    }
    for (const root of roots) {
      let names: string[];
      try {
        names = (await readdir(root.dir, { withFileTypes: true }))
          .filter((d) => d.isDirectory() || d.isSymbolicLink())
          .map((d) => d.name)
          .sort();
      } catch {
        continue;
      }
      for (const dirName of names) {
        if (skills.length >= MAX_SKILLS) {
          truncated = true;
          break;
        }
        const skill = await readSkill(root.dir, dirName);
        if (!skill || seen.has(skill.name)) continue;
        seen.add(skill.name);
        skills.push({ ...skill, source: root.source });
      }
    }
    return { skills, truncated };
  }
}

async function readSkill(
  root: string,
  dirName: string,
): Promise<Omit<SessionSkill, 'source'> | null> {
  try {
    const file = await realpath(path.join(root, dirName, 'SKILL.md'));
    // Read only inside its skills folder (a link elsewhere is skipped).
    if (!isPathInside(root, file, PLATFORM, { allowEqual: false })) return null;
    const handle = await open(file, 'r');
    let text = '';
    try {
      const buffer = Buffer.alloc(SKILL_READ_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, SKILL_READ_BYTES, 0);
      text = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
    const meta = parseSkillFrontmatter(text);
    const name = (meta.name ?? dirName).trim();
    if (!SKILL_NAME.test(name)) return null;
    const description = meta.description
      ? meta.description.replace(/\s+/g, ' ').slice(0, 300)
      : null;
    return { name, description };
  } catch {
    return null;
  }
}
