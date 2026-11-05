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
  token: string;
  databaseUrl: string;
  /** Public URL of the web app (internal callbacks: /api/internal/*). */
  appUrl: string;
  /** URL the runner uses to reach the web app (defaults to appUrl). */
  webInternalUrl: string;
  projectsRoot: string;
  dataDir: string;
  sessionBackend: SessionBackendSetting;
  /** Official CLI (`claude` on PATH by default). A .mjs/.js path is run with node (tests only). */
  claudeBin: string | null;
  logLevel: string;
  /**
   * Base URL of remotes: `https://github.com/` in production. Tests point it to a local folder
   * of bare repositories (`file:///…/`).
   */
  gitRemoteBase: string;
  /** Periodic jobs (integration check, background fetch, uptime heartbeat). Off in tests. */
  schedulerEnabled: boolean;
  version: string;
}

const EnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  RUNNER_HOST: z.string().default('127.0.0.1'),
  RUNNER_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  RUNNER_HOOK_PORT: z.coerce.number().int().min(0).max(65535).default(4101),
  RUNNER_TOKEN: z.string().min(16, 'RUNNER_TOKEN doit contenir au moins 16 caractères.'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL manquant.'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  NUERA_WEB_INTERNAL_URL: z.string().url().optional(),
  NUERA_PROJECTS_ROOT: z.string().default('./.data/projects'),
  NUERA_DATA_DIR: z.string().default('./.data/runner'),
  NUERA_SESSION_BACKEND: z
    .string()
    .optional()
    .transform((v) => (v === 'tmux' || v === 'pty' ? v : 'auto') as SessionBackendSetting),
  NUERA_CLAUDE_BIN: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
  NUERA_GIT_REMOTE_BASE: z.string().default('https://github.com/'),
  NUERA_SCHEDULER: z.string().optional(),
});

/**
 * Loads the repository-root `.env` (development only), without overriding variables already set
 * in the environment (shell variables take precedence).
 */
export function loadDotEnv(env: NodeJS.ProcessEnv = process.env, file = path.join(REPO_ROOT, '.env')): boolean {
  if (env.NODE_ENV === 'production' || !existsSync(file)) return false;
  const parsed = parseEnv(readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined && typeof value === 'string') env[key] = value;
  }
  return true;
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
  const mode = e.NODE_ENV === 'production' ? 'production' : e.NODE_ENV === 'test' ? 'test' : 'development';
  const appUrl = e.APP_URL.replace(/\/+$/, '');
  const remoteBase = e.NUERA_GIT_REMOTE_BASE.endsWith('/') ? e.NUERA_GIT_REMOTE_BASE : `${e.NUERA_GIT_REMOTE_BASE}/`;
  return {
    env: mode,
    host: e.RUNNER_HOST,
    port: e.RUNNER_PORT,
    hookPort: e.RUNNER_HOOK_PORT,
    token: e.RUNNER_TOKEN,
    databaseUrl: e.DATABASE_URL,
    appUrl,
    webInternalUrl: (e.NUERA_WEB_INTERNAL_URL ?? appUrl).replace(/\/+$/, ''),
    projectsRoot: resolveFromRoot(e.NUERA_PROJECTS_ROOT),
    dataDir: resolveFromRoot(e.NUERA_DATA_DIR),
    sessionBackend: e.NUERA_SESSION_BACKEND,
    claudeBin: e.NUERA_CLAUDE_BIN?.trim() ? e.NUERA_CLAUDE_BIN.trim() : null,
    logLevel: e.LOG_LEVEL,
    gitRemoteBase: remoteBase,
    schedulerEnabled: e.NUERA_SCHEDULER ? e.NUERA_SCHEDULER !== '0' : mode !== 'test',
    version: readVersion(),
  };
}
