/**
 * Pieces jointes of the composer — limits and accepted types, shared by the browser (pickers,
 * chips), the web route and the runner (which checks the bytes). No dependency: safe in a client
 * bundle (`@nuera/shared/attachments`).
 */

/** Folder of the worktree that holds the uploaded files (git-ignored through `.git/info/exclude`). */
export const ATTACHMENT_DIR = '.nuera/pieces-jointes';
/** Line added to the clone's `info/exclude` (never to the project's .gitignore). */
export const ATTACHMENT_EXCLUDE_LINE = '/.nuera/';
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
/** Per message (composer); the runner also caps the folder itself. */
export const ATTACHMENT_MAX_PER_MESSAGE = 5;
/** Files kept in the folder of one worktree at most (oldest first are never deleted: the upload is refused). */
export const ATTACHMENT_MAX_FILES_PER_WORKTREE = 200;

export const ATTACHMENT_KINDS = ['image', 'pdf', 'text'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** Images Claude Code reads by path (checked by their first bytes). */
export const ATTACHMENT_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const;
/**
 * Text and code: UTF-8 without NUL byte. Everything else is refused (archives, executables, Office
 * documents, HEIC photos Claude Code cannot read).
 */
export const ATTACHMENT_TEXT_EXTENSIONS = [
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'log',
  'json',
  'jsonc',
  'jsonl',
  'yaml',
  'yml',
  'toml',
  'ini',
  'xml',
  'svg',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'mts',
  'cts',
  'tsx',
  'vue',
  'svelte',
  'astro',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'php',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'sql',
  'graphql',
  'gql',
  'prisma',
  'diff',
  'patch',
  'env.example',
] as const;

/** Lower-case extension of a file name (`archive.tar.gz` → `gz`, `.env.example` → `env.example`). */
export function attachmentExtension(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.env.example')) return 'env.example';
  const dot = lower.lastIndexOf('.');
  return dot > 0 && dot < lower.length - 1 ? lower.slice(dot + 1) : '';
}

/** Kind of an accepted file by its name, null when the type is refused. */
export function attachmentKindOf(name: string): AttachmentKind | null {
  const ext = attachmentExtension(name);
  if ((ATTACHMENT_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if ((ATTACHMENT_TEXT_EXTENSIONS as readonly string[]).includes(ext)) return 'text';
  return null;
}

/** `accept` of the file inputs (the runner checks again, by content). */
export const ATTACHMENT_ACCEPT = [
  ...ATTACHMENT_IMAGE_EXTENSIONS.map((ext) => `.${ext}`),
  '.pdf',
  ...ATTACHMENT_TEXT_EXTENSIONS.filter((ext) => !ext.includes('.')).map((ext) => `.${ext}`),
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
].join(',');

export const ATTACHMENT_TYPES_TEXT = 'images (PNG, JPEG, GIF, WebP), PDF, texte et code';
