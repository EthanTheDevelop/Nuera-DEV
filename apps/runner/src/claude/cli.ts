import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { ClaudeAuth, ClaudeStatus, McpCliStatus } from '@nuera/shared/runner';
import type { Logger } from 'pino';
import { RunnerError } from '../errors';
import { buildChildEnv, withTrustedEnv } from '../safety/env';
import { execCommand, type ExecResult } from '../safety/exec';
import { redactSecrets } from '../safety/redact';
import { binCommand } from '../sessions/runtime-files';
import { resolveClaudeCommand } from './bin';
import type { ClaudeAccount } from './accounts';
import { claudeEnv } from './env';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length <= 300 ? v : null);

const STATUS_TTL_MS = 60_000;
const MCP_TTL_MS = 60_000;

/** Whitelisted fields of `claude auth status --json` (undocumented extra keys are optional). */
export function parseAuthStatus(stdout: string, exitCode: number | null): ClaudeAuth | null {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isObj(json)) return null;
  const org = isObj(json.organization) ? str(json.organization.name) : str(json.organization) ?? str(json.orgName) ?? str(json.organizationName);
  const expires = str(json.loginExpiresAt);
  return {
    loggedIn: typeof json.loggedIn === 'boolean' ? json.loggedIn : exitCode === 0,
    authMethod: str(json.authMethod),
    apiProvider: str(json.apiProvider),
    subscriptionType: str(json.subscriptionType) ?? str(json.subscription) ?? str(json.plan),
    loginExpiresAt: expires && !Number.isNaN(Date.parse(expires)) ? new Date(expires).toISOString() : null,
    email: str(json.email) ?? str(json.emailAddress),
    organization: org,
  };
}

/** `Status:` line of `claude mcp get <name>` → state (docs/research/integrations.md §5.6). */
export function parseMcpGet(output: string): { state: McpCliStatus['state']; statusLine: string | null } {
  if (/no mcp server found|not found|n'existe pas/i.test(output) && !/Status:/i.test(output)) return { state: 'not_configured', statusLine: null };
  const m = /^\s*Status:\s*(.+)$/im.exec(output);
  if (!m) return { state: 'unknown', statusLine: null };
  const line = m[1]!.trim();
  if (/connected/i.test(line) && !/failed|not/i.test(line)) return { state: 'connected', statusLine: line };
  if (/needs authentication|needs auth/i.test(line)) return { state: 'needs_auth', statusLine: line };
  if (/failed to connect/i.test(line)) return { state: 'failed', statusLine: line };
  if (/pending approval/i.test(line)) return { state: 'pending', statusLine: line };
  if (/rejected/i.test(line)) return { state: 'rejected', statusLine: line };
  if (/disabled/i.test(line)) return { state: 'disabled', statusLine: line };
  if (/blocked/i.test(line)) return { state: 'blocked', statusLine: line };
  return { state: 'unknown', statusLine: line };
}

function parseAgents(stdout: string): ClaudeStatus['agents'] {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(json)) return null;
  return json.filter(isObj).slice(0, 100).map((a) => ({
    sessionId: str(a.sessionId),
    name: str(a.name),
    kind: str(a.kind),
    state: str(a.state),
    status: str(a.status),
    waitingFor: str(a.waitingFor),
    cwd: str(a.cwd),
    pid: typeof a.pid === 'number' ? a.pid : null,
    startedAt: typeof a.startedAt === 'number' ? new Date(a.startedAt).toISOString() : null,
  }));
}

/**
 * Read-only use of the official CLI: `--version`, `auth status --json`, `agents --json`,
 * `mcp get`, plus user-scope MCP registration. Credential files are never read. Every call that
 * touches a login runs with the CLAUDE_CONFIG_DIR of ONE account ({@link ClaudeAccount}, lot P1):
 * statuses and MCP states are cached per account, never shared between two.
 */
export class ClaudeCli {
  private readonly cache = new Map<string, { at: number; status: ClaudeStatus }>();
  private readonly inflight = new Map<string, Promise<ClaudeStatus>>();
  private readonly mcpCache = new Map<string, { at: number; value: McpCliStatus }>();
  private readonly cwd: string;

  constructor(
    private readonly claudeBin: string | null,
    dataDir: string,
    private readonly logger: Logger,
  ) {
    this.cwd = path.join(dataDir, 'scratch', 'cli');
    mkdirSync(this.cwd, { recursive: true });
  }

  /** `account` null: a call that reads no login (`--version`). */
  private async exec(account: ClaudeAccount | null, args: string[], timeoutMs = 20_000): Promise<ExecResult | null> {
    const cmd = resolveClaudeCommand(this.claudeBin);
    if (!cmd) return null;
    return execCommand(cmd.file, [...cmd.prefix, ...args], {
      cwd: this.cwd,
      env: withTrustedEnv(buildChildEnv(), { ...(account ? claudeEnv(account.configDir) : {}), CI: '1', NO_COLOR: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }),
      timeoutMs,
      maxOutputBytes: 1024 * 1024,
    });
  }

  /** Forgets the cached status of one account (or of all). */
  invalidate(account?: ClaudeAccount): void {
    if (account) this.cache.delete(account.key);
    else this.cache.clear();
  }

  async version(): Promise<string | null> {
    const result = await this.exec(null, ['--version'], 15_000);
    if (!result || result.exitCode !== 0) return null;
    const m = /(\d+\.\d+\.\d+[^\s]*)/.exec(result.stdout);
    return m?.[1] ?? (result.stdout.trim() || null);
  }

  async status(account: ClaudeAccount, options: { refresh?: boolean } = {}): Promise<ClaudeStatus> {
    const cached = this.cache.get(account.key);
    if (!options.refresh && cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.status;
    const running = this.inflight.get(account.key);
    if (running) return running;
    const promise = this.compute(account).finally(() => {
      this.inflight.delete(account.key);
    });
    this.inflight.set(account.key, promise);
    return promise;
  }

  cached(account: ClaudeAccount): ClaudeStatus | null {
    return this.cache.get(account.key)?.status ?? null;
  }

  /** `claude auth logout` with the account's folder (an account leaving the server). */
  async signOut(account: ClaudeAccount): Promise<boolean> {
    const result = await this.exec(account, ['auth', 'logout'], 30_000);
    this.invalidate(account);
    return Boolean(result && result.exitCode === 0);
  }

  private async compute(account: ClaudeAccount): Promise<ClaudeStatus> {
    const checkedAt = new Date().toISOString();
    const spaceId = account.spaceId;
    const remember = (status: ClaudeStatus) => {
      this.cache.set(account.key, { at: Date.now(), status });
      return status;
    };
    if (!resolveClaudeCommand(this.claudeBin)) {
      return remember({ checkedAt, installed: false, version: null, auth: null, state: 'not_installed', agents: null, error: 'Le CLI Claude Code est introuvable sur le serveur.', spaceId });
    }
    try {
      const version = await this.version();
      const authResult = await this.exec(account, ['auth', 'status', '--json'], 25_000);
      const auth = authResult ? parseAuthStatus(authResult.stdout, authResult.exitCode) : null;
      const agentsResult = await this.exec(account, ['agents', '--json'], 20_000);
      const agents = agentsResult && agentsResult.exitCode === 0 ? parseAgents(agentsResult.stdout) : null;
      let state: ClaudeStatus['state'] = 'error';
      if (auth) state = !auth.loggedIn || auth.authMethod === 'none' ? 'disconnected' : auth.authMethod && auth.authMethod !== 'claude.ai' ? 'wrong_method' : 'connected';
      return remember({
        checkedAt,
        installed: true,
        version,
        auth,
        state,
        agents,
        error: auth ? null : "La commande `claude auth status --json` n'a pas répondu.",
        spaceId,
      });
    } catch (error) {
      this.logger.warn({ err: error, spaceId }, 'statut du CLI Claude indisponible');
      return remember({ checkedAt, installed: true, version: null, auth: null, state: 'error', agents: null, error: 'Statut du CLI indisponible.', spaceId });
    }
  }

  async mcpGet(account: ClaudeAccount, name: string, options: { refresh?: boolean } = {}): Promise<McpCliStatus> {
    const key = `${account.key}|${name}`;
    const cached = this.mcpCache.get(key);
    if (!options.refresh && cached && Date.now() - cached.at < MCP_TTL_MS) return cached.value;
    const result = await this.exec(account, ['mcp', 'get', name], 40_000);
    if (!result) throw new RunnerError('CONFLICT', 'Le CLI Claude Code est introuvable sur le serveur.', { reason: 'CLAUDE_NOT_INSTALLED' });
    const raw = redactSecrets(`${result.stdout}\n${result.stderr}`.trim()).slice(0, 8000);
    const parsed = parseMcpGet(raw);
    const value: McpCliStatus = { name, state: result.timedOut ? 'failed' : parsed.state, statusLine: parsed.statusLine, raw, checkedAt: new Date().toISOString() };
    this.mcpCache.set(key, { at: Date.now(), value });
    return value;
  }

  /** `claude mcp add-json --scope user` / `claude mcp remove --scope user`. Refuses configs holding secrets. */
  async mcpSync(account: ClaudeAccount, input: { upsert: Array<{ name: string; config: Record<string, unknown> }>; remove: string[] }) {
    // Everything is validated before the first CLI call: a refused config never leaves a half-applied sync.
    const upserts = input.upsert.map((item) => ({ name: item.name, config: userScopeMcpConfig(item.name, item.config) }));
    const results: Array<{ name: string; action: 'upsert' | 'remove'; ok: boolean; raw: string }> = [];
    for (const name of input.remove) {
      const r = await this.exec(account, ['mcp', 'remove', '--scope', 'user', name], 30_000);
      results.push({ name, action: 'remove', ok: Boolean(r && r.exitCode === 0), raw: redactSecrets(`${r?.stdout ?? ''}${r?.stderr ?? ''}`).slice(0, 2000) });
      this.mcpCache.delete(`${account.key}|${name}`);
    }
    for (const item of upserts) {
      await this.exec(account, ['mcp', 'remove', '--scope', 'user', item.name], 30_000);
      const r = await this.exec(account, ['mcp', 'add-json', '--scope', 'user', item.name, JSON.stringify(item.config)], 30_000);
      results.push({ name: item.name, action: 'upsert', ok: Boolean(r && r.exitCode === 0), raw: redactSecrets(`${r?.stdout ?? ''}${r?.stderr ?? ''}`).slice(0, 2000) });
      this.mcpCache.delete(`${account.key}|${item.name}`);
    }
    return { results };
  }
}

/**
 * User-scope MCP entry (`claude mcp add-json`): the JSON travels in argv and lands in
 * `~/.claude.json`, so it must hold no secret — no secret header, env variable or URL credential;
 * authenticated servers use `headersHelper: 'nuera'` (replaced by bin/nuera-mcp-headers.mjs).
 */
export function userScopeMcpConfig(name: string, input: Record<string, unknown>): Record<string, unknown> {
  const config = { ...input };
  const headers = isObj(config.headers) ? config.headers : null;
  if (headers && Object.keys(headers).some((h) => /authorization|token|secret|key|cookie/i.test(h))) {
    throw new RunnerError('VALIDATION', `La configuration MCP « ${name} » contient un en-tête secret : utilisez headersHelper « nuera ».`);
  }
  const env = isObj(config.env) ? config.env : null;
  if (env && Object.keys(env).some((k) => /token|secret|password|passwd|api[-_]?key|private[-_]?key|credential|cookie|auth/i.test(k))) {
    throw new RunnerError('VALIDATION', `La configuration MCP « ${name} » contient une variable secrète : elle ne peut pas être enregistrée.`);
  }
  if (typeof config.url === 'string' && /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(config.url)) {
    throw new RunnerError('VALIDATION', `L'URL du serveur MCP « ${name} » contient des identifiants.`);
  }
  if (config.headersHelper === 'nuera') config.headersHelper = binCommand('nuera-mcp-headers.mjs');
  else if (config.headersHelper !== undefined) throw new RunnerError('VALIDATION', 'headersHelper non autorisé.');
  return config;
}
