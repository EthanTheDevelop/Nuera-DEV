import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { z } from 'zod';

/** apps/runner (works from src/ with tsx and from dist/ once bundled). */
export const RUNNER_PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(RUNNER_PACKAGE_DIR, '..', '..');
export const BIN_DIR = path.join(RUNNER_PACKAGE_DIR, 'bin');

export type SessionBackendSetting = 'tmux' | 'pty' | 'auto';

export interface RunnerConfig {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  /** Hook / status-line listener, always bound to 127.0.0.1. */
  hookPort: number;
  /** Token of this runner's server: `sha256(token)` is how it finds its row in `environments`. */
  token: string;
  /** RUNNER_DATABASE_URL (restricted role of the server) or DATABASE_URL. */
  databaseUrl: string;
  /** Pool size of the main database client (NUERA_DB_POOL_MAX, default 5). */
  dbPoolMax: number;
  /**
   * NUERA_ENVIRONMENT_ID: optional assertion only. The server is found by its token; a different id
   * is a fatal configuration error.
   */
  environmentId: string | null;
  /**
   * NUERA_CLAUDE_CONFIG_DIR (dev, tests, several runners on one machine): CLAUDE_CONFIG_DIR given to
   * every `claude` process of this runner and root of the transcripts it accepts. Null: the process
   * environment (production: HOME of the container).
   */
  claudeConfigDir: string | null;
  /** Public URL of the web app (internal callbacks: /api/internal/*). */
  appUrl: string;
  /** URL the runner uses to reach the web app (defaults to appUrl). */
  webInternalUrl: string;
  projectsRoot: string;
  dataDir: string;
  sessionBackend: SessionBackendSetting;
  /**
   * tmux socket (`tmux -L <name>`) of the Claude sessions (NUERA_TMUX_SOCKET). Unset: `nuera` for
   * the default server, `nuera-<first 8 hex of the server id>` for the others (sessions/backend.ts).
   */
  tmuxSocket?: string;
  /** Official CLI (`claude` on PATH by default). A .mjs/.js path is run with node (tests only). */
  claudeBin: string | null;
  logLevel: string;
  /**
   * Base URL of remotes: `https://github.com/` in production. Tests point it to a local folder
   * of bare repositories (`file:///…/`).
   */
  gitRemoteBase: string;
  /** Periodic jobs (server heartbeat, background fetch, uptime). Off in tests. */
  schedulerEnabled: boolean;
  /**
   * Automatic resumption after the usage limit: delay after the reset time the CLI gave
   * (NUERA_AUTO_RESUME_MARGIN_SECONDS, 120) and, reset unknown, interval of the retries
   * (NUERA_AUTO_RESUME_RETRY_SECONDS, 1800) during 6 h. Shortened by the tests only.
   */
  autoResume?: { marginMs: number; retryMs: number };
  version: string;
}

const EnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  RUNNER_HOST: z.string().default('127.0.0.1'),
  RUNNER_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  RUNNER_HOOK_PORT: z.coerce.number().int().min(0).max(65535).default(4101),
  RUNNER_TOKEN: z.string().min(16, 'RUNNER_TOKEN doit contenir au moins 16 caractères.'),
  DATABASE_URL: z.string().optional(),
  RUNNER_DATABASE_URL: z.string().optional(),
  // Compose passes `${VAR:-}`: an empty value means « not set ».
  NUERA_DB_POOL_MAX: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(2).max(15).default(5)),
  NUERA_ENVIRONMENT_ID: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v), 'NUERA_ENVIRONMENT_ID doit être un identifiant de serveur (UUID).'),
  NUERA_CLAUDE_CONFIG_DIR: z.string().optional(),
  APP_URL: z.string().url().default('http://localhost:3000'),
  NUERA_WEB_INTERNAL_URL: z.string().url().optional(),
  NUERA_PROJECTS_ROOT: z.string().default('./.data/projects'),
  NUERA_DATA_DIR: z.string().default('./.data/runner'),
  NUERA_SESSION_BACKEND: z
    .string()
    .optional()
    .transform((v) => (v === 'tmux' || v === 'pty' ? v : 'auto') as SessionBackendSetting),
  NUERA_CLAUDE_BIN: z.string().optional(),
  NUERA_TMUX_SOCKET: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, 'NUERA_TMUX_SOCKET : lettres, chiffres, « - » et « _ » seulement.')
    .optional(),
  LOG_LEVEL: z.string().default('info'),
  NUERA_GIT_REMOTE_BASE: z.string().default('https://github.com/'),
  NUERA_SCHEDULER: z.string().optional(),
  NUERA_AUTO_RESUME_MARGIN_SECONDS: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(0).max(3600).default(120)),
  NUERA_AUTO_RESUME_RETRY_SECONDS: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(1).max(6 * 3600).default(1800)),
});

/**
 * Loads the repository-root `.env` (development only), without overriding variables already set
 * in the environment (shell variables take precedence). With NUERA_ENV_FILE (a second runner on
 * the same machine, e.g. `.env.runner-b`), that file is read first: its values win over the root
 * `.env` (token, ports, folders and Claude config dir of that runner).
 */
export function loadDotEnv(env: NodeJS.ProcessEnv = process.env, file = path.join(REPO_ROOT, '.env')): boolean {
  if (env.NODE_ENV === 'production') return false;
  const files = [...(env.NUERA_ENV_FILE?.trim() ? [resolveFromRoot(env.NUERA_ENV_FILE.trim())] : []), file];
  let loaded = false;
  for (const candidate of files) {
    if (!existsSync(candidate)) continue;
    const parsed = parseEnv(readFileSync(candidate, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (env[key] === undefined && typeof value === 'string') env[key] = value;
    }
    loaded = true;
  }
  return loaded;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(RUNNER_PACKAGE_DIR, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Relative paths in the configuration are relative to the repository root, not to the cwd. */
function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(REPO_ROOT, p);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuration du runner invalide : ${issues}`);
  }
  const e = parsed.data;
  // The restricted role of the server (MULTICOMPTE §11) wins over the full DSN.
  const databaseUrl = e.RUNNER_DATABASE_URL?.trim() || e.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('Configuration du runner invalide : RUNNER_DATABASE_URL ou DATABASE_URL manquant.');
  const mode = e.NODE_ENV === 'production' ? 'production' : e.NODE_ENV === 'test' ? 'test' : 'development';
  const appUrl = e.APP_URL.replace(/\/+$/, '');
  const remoteBase = e.NUERA_GIT_REMOTE_BASE.endsWith('/') ? e.NUERA_GIT_REMOTE_BASE : `${e.NUERA_GIT_REMOTE_BASE}/`;
  return {
    env: mode,
    host: e.RUNNER_HOST,
    port: e.RUNNER_PORT,
    hookPort: e.RUNNER_HOOK_PORT,
    token: e.RUNNER_TOKEN,
    databaseUrl,
    dbPoolMax: e.NUERA_DB_POOL_MAX,
    environmentId: e.NUERA_ENVIRONMENT_ID?.toLowerCase() || null,
    claudeConfigDir: e.NUERA_CLAUDE_CONFIG_DIR?.trim() ? resolveFromRoot(e.NUERA_CLAUDE_CONFIG_DIR.trim()) : null,
    appUrl,
    webInternalUrl: (e.NUERA_WEB_INTERNAL_URL ?? appUrl).replace(/\/+$/, ''),
    projectsRoot: resolveFromRoot(e.NUERA_PROJECTS_ROOT),
    dataDir: resolveFromRoot(e.NUERA_DATA_DIR),
    sessionBackend: e.NUERA_SESSION_BACKEND,
    tmuxSocket: e.NUERA_TMUX_SOCKET,
    claudeBin: e.NUERA_CLAUDE_BIN?.trim() ? e.NUERA_CLAUDE_BIN.trim() : null,
    logLevel: e.LOG_LEVEL,
    gitRemoteBase: remoteBase,
    schedulerEnabled: e.NUERA_SCHEDULER ? e.NUERA_SCHEDULER !== '0' : mode !== 'test',
    autoResume: { marginMs: e.NUERA_AUTO_RESUME_MARGIN_SECONDS * 1000, retryMs: e.NUERA_AUTO_RESUME_RETRY_SECONDS * 1000 },
    version: readVersion(),
  };
}
