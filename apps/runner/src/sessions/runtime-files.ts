import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { McpConfigSchema } from '@nuera/shared/runner';
import { z } from 'zod';

/** MCP config as received (input type: `args` may be omitted), validated again here. */
export type McpConfigInput = z.input<typeof McpConfigSchema>;
import { BIN_DIR } from '../config';
import { RunnerError } from '../errors';
import { rejectedEnvNames } from '../safety/env';

/** Hook events wired for every Nuera session (docs/research/claude-code.md §4 / §13.6). */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];
const TOOL_EVENTS = new Set<string>(['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure']);

export const LaunchFileSchema = z.object({
  sessionId: z.string(),
  /** Current Claude conversation id (changes after /clear). */
  claudeSessionId: z.string(),
  permissionWaitSeconds: z.number().int(),
  maxConcurrentSessions: z.number().int().nullable(),
  memoryLimitMb: z.number().int().nullable(),
  env: z.record(z.string(), z.string()),
  denyRules: z.array(z.string()),
  hasMcp: z.boolean(),
  updatedAt: z.string(),
});
export type LaunchFile = z.infer<typeof LaunchFileSchema>;

export interface SessionFiles {
  dir: string;
  settings: string;
  mcp: string | null;
  launch: string;
  tokenFile: string;
}

/** Command line of a bin/ script for the CLI (absolute node + script, forward slashes, quoted). */
export function binCommand(script: string): string {
  const q = (p: string) => `"${p.replace(/\\/g, '/').replace(/"/g, '\\"')}"`;
  return `${q(process.execPath)} ${q(path.join(BIN_DIR, script))}`;
}

export const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
export const newHookToken = () => randomBytes(32).toString('base64url');

export function sessionDir(dataDir: string, sessionId: string): string {
  return path.join(dataDir, 'sessions', sessionId);
}

/** settings.json given with `--settings` (merged over the user's settings by the CLI). */
export function buildSettings(options: { permissionWaitSeconds: number; denyRules: string[] }): Record<string, unknown> {
  const hookCommand = binCommand('nuera-hook.mjs');
  const hooks: Record<string, unknown[]> = {};
  for (const event of HOOK_EVENTS) {
    // Seconds. The hook only forwards the payload (a few ms) but a loaded host can be slow to
    // start node; the CLI caps SessionEnd hooks at 1.5 s anyway.
    const timeout = event === 'PermissionRequest' ? options.permissionWaitSeconds + 30 : event === 'SessionEnd' ? 2 : 30;
    hooks[event] = [
      {
        ...(TOOL_EVENTS.has(event) ? { matcher: '*' } : {}),
        hooks: [{ type: 'command', command: hookCommand, timeout }],
      },
    ];
  }
  return {
    hooks,
    statusLine: { type: 'command', command: binCommand('nuera-statusline.mjs'), padding: 0 },
    disableClaudeAiConnectors: true,
    ...(options.denyRules.length ? { permissions: { deny: options.denyRules } } : {}),
  };
}

/** mcp.json given with `--mcp-config … --strict-mcp-config`; `headersHelper: 'nuera'` → our helper. */
export function buildMcpConfig(config: McpConfigInput): Record<string, unknown> {
  const parsed = McpConfigSchema.parse(config);
  const servers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(parsed.mcpServers)) {
    if (server.type === 'stdio') {
      servers[name] = { type: 'stdio', command: server.command, args: server.args, ...(server.env ? { env: server.env } : {}) };
      continue;
    }
    const { headersHelper, ...rest } = server;
    servers[name] = { ...rest, ...(headersHelper === 'nuera' ? { headersHelper: binCommand('nuera-mcp-headers.mjs') } : {}) };
  }
  return { mcpServers: servers };
}

export function validateSessionEnv(env: Record<string, string>): void {
  const refused = rejectedEnvNames(Object.keys(env));
  if (refused.length) {
    throw new RunnerError('VALIDATION', `Variables refusées pour une session : ${refused.join(', ')}.`);
  }
}

/** Writes (or rewrites) the runtime files of a session. Contains no secret except the 0600 token file. */
export async function writeSessionFiles(
  dataDir: string,
  input: {
    sessionId: string;
    claudeSessionId: string;
    /** `mcpConfig: undefined` keeps the existing mcp.json, `null` removes it. */
    launch: { denyRules: string[]; env: Record<string, string>; mcpConfig?: McpConfigInput | null };
    permissionWaitSeconds: number;
    maxConcurrentSessions: number | null;
    memoryLimitMb: number | null;
    hookToken: string | null;
  },
): Promise<SessionFiles> {
  validateSessionEnv(input.launch.env);
  const dir = sessionDir(dataDir, input.sessionId);
  await mkdir(dir, { recursive: true });
  const mcpPath = path.join(dir, 'mcp.json');
  if (input.launch.mcpConfig) {
    await writeFile(mcpPath, JSON.stringify(buildMcpConfig(input.launch.mcpConfig), null, 2), 'utf8');
  } else if (input.launch.mcpConfig === null) {
    await rm(mcpPath, { force: true });
  }
  const files: SessionFiles = {
    dir,
    settings: path.join(dir, 'settings.json'),
    mcp: existsSync(mcpPath) ? mcpPath : null,
    launch: path.join(dir, 'launch.json'),
    tokenFile: path.join(dir, 'hook-token'),
  };
  await writeFile(files.settings, JSON.stringify(buildSettings({ permissionWaitSeconds: input.permissionWaitSeconds, denyRules: input.launch.denyRules }), null, 2), 'utf8');
  const launch: LaunchFile = {
    sessionId: input.sessionId,
    claudeSessionId: input.claudeSessionId,
    permissionWaitSeconds: input.permissionWaitSeconds,
    maxConcurrentSessions: input.maxConcurrentSessions,
    memoryLimitMb: input.memoryLimitMb,
    env: input.launch.env,
    denyRules: input.launch.denyRules,
    hasMcp: Boolean(files.mcp),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(files.launch, JSON.stringify(launch, null, 2), 'utf8');
  if (input.hookToken) {
    await writeFile(files.tokenFile, input.hookToken, { encoding: 'utf8', mode: 0o600 });
    await chmod(files.tokenFile, 0o600).catch(() => undefined);
  }
  return files;
}

export async function readLaunchFile(dataDir: string, sessionId: string): Promise<LaunchFile | null> {
  const file = path.join(sessionDir(dataDir, sessionId), 'launch.json');
  try {
    return LaunchFileSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    return null;
  }
}

export function readLaunchFileSync(dataDir: string, sessionId: string): LaunchFile | null {
  const file = path.join(sessionDir(dataDir, sessionId), 'launch.json');
  if (!existsSync(file)) return null;
  try {
    return LaunchFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

export async function updateLaunchFile(dataDir: string, sessionId: string, patch: Partial<LaunchFile>): Promise<void> {
  const current = await readLaunchFile(dataDir, sessionId);
  if (!current) return;
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await writeFile(path.join(sessionDir(dataDir, sessionId), 'launch.json'), JSON.stringify(next, null, 2), 'utf8');
}

export async function removeTokenFile(dataDir: string, sessionId: string): Promise<void> {
  await rm(path.join(sessionDir(dataDir, sessionId), 'hook-token'), { force: true });
}
