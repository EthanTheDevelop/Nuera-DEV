import { COMMON_SKILL_LIMITS, COMMON_SKILL_MARKER, COMMON_SKILL_NAME, isSafeSkillPath } from '@nuera/shared/runner';
import { AppError } from '@/server/errors';
import { skillContentHash } from './model';
import { readZip, type ZipEntry } from './zip';

/**
 * Files of a common skill (lot K1): what « Importer un skill (.zip) » and the editor accept.
 *
 * - one folder with `SKILL.md` (front matter `name`, `description`) and text files only (UTF-8, no
 *   NUL byte); a single top folder of the archive (`nuera-infra/SKILL.md`) is stripped;
 * - no hidden file, no `..`, no absolute path, no link (zip reader), bounded counts and sizes;
 * - scripts (`.sh`, `.ps1`, `.py`…, or a `#!` first line) are refused unless an administrator ticks
 *   « Autoriser les scripts »; then the Unix ones are written executable. Binaries never pass.
 */

export interface SkillFile {
  path: string;
  content: string;
  executable: boolean;
}

export interface ValidatedSkill {
  name: string;
  description: string;
  files: SkillFile[];
  /** Paths recognised as scripts (shown with the warning). */
  scripts: string[];
  hash: string;
  totalBytes: number;
}

/** Upload limit of a .zip (compressed). */
export const SKILL_ZIP_MAX_BYTES = 4 * 1024 * 1024;

const SCRIPT_EXTENSIONS = new Set(['sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'psd1', 'py', 'rb', 'pl', 'php', 'js', 'mjs', 'cjs', 'ts', 'bat', 'cmd', 'vbs', 'lua']);
/** Scripts made executable when allowed (the CLI runs them through Bash on the server). */
const EXECUTABLE_EXTENSIONS = new Set(['sh', 'bash', 'zsh', 'py', 'rb', 'pl']);
/** Archive noise skipped silently. */
const IGNORED = [/^__MACOSX\//, /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/, /(^|\/)desktop\.ini$/i];

const refuse = (message: string, detail?: string) => new AppError('VALIDATION', message, detail ? { detail } : {});

const extensionOf = (file: string) => (/\.([A-Za-z0-9]+)$/.exec(file)?.[1] ?? '').toLowerCase();

export function isScript(file: Pick<SkillFile, 'path' | 'content'>): boolean {
  return SCRIPT_EXTENSIONS.has(extensionOf(file.path)) || file.content.startsWith('#!');
}

function decodeText(path: string, bytes: Buffer): string {
  if (bytes.includes(0)) throw refuse(`Fichier binaire refusé : ${path}.`, 'Un skill ne contient que des fichiers texte (Markdown, scripts, configuration).');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    throw refuse(`Fichier non UTF-8 refusé : ${path}.`);
  }
}

/** `name` / `description` of the SKILL.md front matter (`key: value`, quotes, `>`/`|` blocks). */
export function parseFrontmatter(text: string): { name: string | null; description: string | null; hasFrontmatter: boolean } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
  if (!match) return { name: null, description: null, hasFrontmatter: false };
  const lines = match[1]!.split(/\r?\n/);
  const fields: Record<string, string> = {};
  for (let i = 0; i < lines.length; i += 1) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (/^[>|][-+]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1]!.trim() === '')) {
        i += 1;
        block.push(lines[i]!.trim());
      }
      value = block.join(' ').trim();
    }
    fields[kv[1]!.toLowerCase()] = value.replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
  }
  return { name: fields.name || null, description: fields.description || null, hasFrontmatter: true };
}

/**
 * Validates the files of a skill (paths relative to the skill folder). `expectedName`: the name the
 * administrator gave (editor, replacement of an existing skill); the front matter must agree.
 */
export function validateSkillFiles(
  input: Array<{ path: string; content: string }>,
  options: { allowScripts: boolean; expectedName?: string | null },
): ValidatedSkill {
  if (input.length === 0) throw refuse('Skill vide : SKILL.md manquant.');
  if (input.length > COMMON_SKILL_LIMITS.maxFiles) throw refuse(`${COMMON_SKILL_LIMITS.maxFiles} fichiers au plus par skill.`);
  const seen = new Set<string>();
  const files: SkillFile[] = [];
  const scripts: string[] = [];
  let totalBytes = 0;
  for (const entry of input) {
    const path = entry.path.trim();
    if (!isSafeSkillPath(path) || path === COMMON_SKILL_MARKER) {
      throw refuse(`Chemin refusé : ${path || '(vide)'}.`, 'Lettres, chiffres, « . », « _ » et « - » seulement, sans fichier caché ni « .. ».');
    }
    const key = path.toLowerCase();
    if (seen.has(key)) throw refuse(`Fichier en double : ${path}.`);
    for (const other of seen) if (other.startsWith(`${key}/`) || key.startsWith(`${other}/`)) throw refuse(`Chemin en conflit : ${path}.`);
    seen.add(key);
    if (entry.content.includes('\0')) throw refuse(`Fichier binaire refusé : ${path}.`);
    const bytes = Buffer.byteLength(entry.content, 'utf8');
    if (bytes > COMMON_SKILL_LIMITS.maxFileBytes) throw refuse(`Fichier trop volumineux : ${path} (512 Kio au plus).`);
    totalBytes += bytes;
    const script = path !== 'SKILL.md' && isScript({ path, content: entry.content });
    if (script) scripts.push(path);
    files.push({ path, content: entry.content, executable: script && options.allowScripts && (EXECUTABLE_EXTENSIONS.has(extensionOf(path)) || entry.content.startsWith('#!')) });
  }
  if (totalBytes > COMMON_SKILL_LIMITS.maxSkillBytes) throw refuse('Skill trop volumineux (2 Mio au plus, tous fichiers compris).');
  scripts.sort();
  const skillMd = files.find((file) => file.path === 'SKILL.md');
  if (!skillMd) throw refuse('SKILL.md manquant à la racine du skill.');
  if (scripts.length > 0 && !options.allowScripts) {
    throw refuse(
      `Ce skill contient ${scripts.length > 1 ? `${scripts.length} scripts` : 'un script'} : ${scripts.slice(0, 5).join(', ')}${scripts.length > 5 ? '…' : ''}.`,
      "Cochez « Autoriser les scripts » pour l'importer : Claude pourra les exécuter sur chaque serveur, après votre autorisation.",
    );
  }
  const meta = parseFrontmatter(skillMd.content);
  if (!meta.hasFrontmatter) throw refuse('SKILL.md doit commencer par un en-tête --- name: … description: … ---.');
  const name = (meta.name ?? options.expectedName ?? '').trim();
  if (!COMMON_SKILL_NAME.test(name)) throw refuse(`Nom de skill invalide : « ${name || '(absent)'} ».`, 'Minuscules, chiffres et tirets, 64 caractères au plus (champ name de SKILL.md).');
  if (options.expectedName && name !== options.expectedName) throw refuse(`Le champ name de SKILL.md (« ${name} ») ne correspond pas au skill « ${options.expectedName} ».`);
  const description = (meta.description ?? '').replace(/\s+/g, ' ').trim();
  if (!description) throw refuse('SKILL.md : champ description requis (il dit à Claude quand utiliser le skill).');
  if (description.length > 1024) throw refuse('SKILL.md : description de 1 024 caractères au plus.');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { name, description, files, scripts, hash: skillContentHash(files), totalBytes };
}

/** Entries of an archive → files of the skill folder (single top folder stripped, noise skipped). */
export function skillFilesFromZip(entries: ZipEntry[]): Array<{ path: string; content: string }> {
  const kept = entries.filter((entry) => !IGNORED.some((pattern) => pattern.test(entry.name)));
  if (kept.length === 0) throw refuse('Archive vide.');
  let prefix = '';
  if (!kept.some((entry) => entry.name === 'SKILL.md')) {
    const tops = new Set(kept.map((entry) => entry.name.split('/')[0]));
    const [top] = [...tops];
    if (tops.size === 1 && top && kept.every((entry) => entry.name.startsWith(`${top}/`)) && kept.some((entry) => entry.name === `${top}/SKILL.md`)) {
      prefix = `${top}/`;
    } else {
      throw refuse("SKILL.md introuvable : l'archive doit contenir SKILL.md à sa racine ou dans un seul dossier.");
    }
  }
  return kept.map((entry) => {
    const path = entry.name.slice(prefix.length);
    return { path, content: decodeText(path, entry.data) };
  });
}

/** « Importer un skill (.zip) »: archive → validated skill. */
export function skillFromZip(buffer: Buffer, options: { allowScripts: boolean; expectedName?: string | null }): ValidatedSkill {
  if (buffer.length > SKILL_ZIP_MAX_BYTES) throw refuse('Archive trop volumineuse (4 Mio au plus).');
  const entries = readZip(buffer, {
    maxEntries: COMMON_SKILL_LIMITS.maxFiles + 50,
    maxEntryBytes: COMMON_SKILL_LIMITS.maxFileBytes,
    maxTotalBytes: COMMON_SKILL_LIMITS.maxSkillBytes,
  });
  return validateSkillFiles(skillFilesFromZip(entries), options);
}
