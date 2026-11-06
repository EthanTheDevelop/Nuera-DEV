import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GitIdentity } from '@nuera/shared/runner';
import { RunnerError } from '../errors';
import { buildChildEnv, withTrustedEnv } from '../safety/env';
import { execCommand, type ExecResult } from '../safety/exec';
import { redactSecrets } from '../safety/redact';

export interface GitRunOptions {
  cwd: string;
  /** Token header for the remote host (`http.<base>.extraheader`), network commands only. */
  extraHeader?: string;
  /** Network command: system/global config ignored, protocols restricted. */
  network?: boolean;
  timeoutMs?: number;
  /** Return the result instead of throwing on a non-zero exit. */
  allowFailure?: boolean;
  input?: string;
  /** `C` (default) for parsable messages; `inherit` for user-facing journals (clone). */
  locale?: 'C' | 'inherit';
  identity?: GitIdentity;
  /** Run the repository's own hooks (default false: core.hooksPath → empty folder). */
  runHooks?: boolean;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}

export class GitCommandError extends RunnerError {
  readonly result: ExecResult;
  readonly args: readonly string[];
  constructor(message: string, args: readonly string[], result: ExecResult, options: { reason?: string; code?: 'UPSTREAM' | 'CONFLICT' | 'VALIDATION' | 'NOT_FOUND' | 'INTERNAL' } = {}) {
    super(options.code ?? 'UPSTREAM', message, {
      reason: options.reason ?? (result.timedOut ? 'TIMEOUT' : 'GIT_FAILED'),
      raw: redactSecrets(`$ git ${args.join(' ')}\n${result.stderr || result.stdout}`.trim()).slice(-16_000),
    });
    this.result = result;
    this.args = args;
  }
}

/** Git authentication failure as printed by git (any locale: HTTP status codes are stable). */
export function isAuthFailure(output: string): boolean {
  return /\b(401|403)\b|Authentication failed|could not read Username|terminal prompts disabled|Invalid username or password|Permission to .* denied/i.test(output);
}

/** `http.*` settings a repository may keep: they cannot redirect traffic nor weaken TLS. */
const SAFE_REPO_HTTP_KEYS = new Set([
  'http.postbuffer',
  'http.lowspeedlimit',
  'http.lowspeedtime',
  'http.maxrequests',
  'http.minsessions',
  'http.version',
  'http.useragent',
  // Overridden by our own `http.sslVerify=true` (same key, command scope wins).
  'http.sslverify',
]);

function isUnsafeNetworkKey(key: string): boolean {
  // URL rewriting (`url.<base>.insteadOf` / `pushInsteadOf`) and extra transports (`ext::`, `fd::`…).
  if (key.startsWith('url.') || key.startsWith('protocol.')) return true;
  // `http.<url>.*` outranks our env overrides (the most specific URL match wins over GIT_CONFIG_*),
  // and proxies / CA files / resolve overrides can route the token through a third party.
  if (key.startsWith('http.')) return !SAFE_REPO_HTTP_KEYS.has(key);
  // A `[remote "<url>"]` section applies to pushes/fetches addressed to that explicit URL.
  if (key.startsWith('remote.')) return key.slice('remote.'.length, key.lastIndexOf('.')).includes(':');
  return false;
}

/**
 * Keys of `git config --list --show-scope -z` (records `scope\0key\nvalue\0`) that a repository —
 * whose `.git/config` Claude can edit — sets to redirect or weaken a network command. Only the
 * runner's own `command` scope may touch those.
 */
export function unsafeNetworkConfigKeys(output: string): string[] {
  const fields = output.split('\0');
  const unsafe = new Set<string>();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope = fields[i];
    if (!scope || scope === 'command') continue;
    const key = (fields[i + 1] ?? '').split('\n')[0]!.trim().toLowerCase();
    if (key && isUnsafeNetworkKey(key)) unsafe.add(key);
  }
  return [...unsafe];
}

/**
 * Every git command started by the runner goes through here:
 * - argument array, never a shell; `GIT_TERMINAL_PROMPT=0`, askpass that always refuses;
 * - runtime config via `GIT_CONFIG_COUNT/KEY/VALUE` (higher precedence than the repo's
 *   `.git/config`, which Claude can edit): credential helpers reset, repo hooks disabled,
 *   fsmonitor off, TLS verification forced;
 * - network commands first check the repository's own config ({@link unsafeNetworkConfigKeys}):
 *   env overrides only win over keys of the SAME name, so URL rewriting, extra protocols,
 *   URL-specific `http.<url>.*` settings and `[remote "<url>"]` sections are refused outright;
 * - the token (when any) only as `http.<remote base>.extraheader` in the env of that one process —
 *   never in a URL, argv, `.git/config` or a credential store.
 */
export class Git {
  readonly remoteBase: string;
  private readonly hooksDir: string;
  private readonly askpass: string;
  private readonly emptyConfig: string;

  constructor(dataDir: string, remoteBase: string) {
    this.remoteBase = remoteBase;
    const gitDir = path.join(dataDir, 'git');
    this.hooksDir = path.join(gitDir, 'empty-hooks');
    this.askpass = path.join(gitDir, 'askpass-deny.sh');
    this.emptyConfig = path.join(gitDir, 'empty.gitconfig');
    mkdirSync(this.hooksDir, { recursive: true });
    writeFileSync(this.askpass, '#!/bin/sh\n# Nuera Dev: git never asks for credentials.\nexit 1\n', 'utf8');
    try {
      chmodSync(this.askpass, 0o755);
    } catch {
      // Windows: no exec bit, Git for Windows runs it through sh.
    }
    writeFileSync(this.emptyConfig, '', 'utf8');
  }

  /** `https://github.com/owner/repo.git` (or the test base). */
  remoteUrl(fullName: string): string {
    return `${this.remoteBase}${fullName}.git`;
  }

  private get remoteIsHttp(): boolean {
    return /^https?:\/\//i.test(this.remoteBase);
  }

  buildEnv(options: Omit<GitRunOptions, 'cwd'>): Record<string, string> {
    const config: Array<[string, string]> = [
      ['credential.helper', ''],
      // Byte fidelity with the repository on every platform (Git for Windows defaults to `true`):
      // no CRLF conversion on checkout or commit, whatever the global config says. `core.eol` is
      // left alone (it only matters with `text` attributes, which the repository decides).
      ['core.autocrlf', 'false'],
      ['core.fsmonitor', 'false'],
      ['core.quotePath', 'false'],
      ['color.ui', 'false'],
      ['advice.detachedHead', 'false'],
      ['maintenance.auto', 'false'],
      ['http.sslVerify', 'true'],
    ];
    if (!options.runHooks) config.push(['core.hooksPath', this.hooksDir]);
    if (options.network) {
      // `protocol.<name>.allow` outranks `protocol.allow`: every built-in transport is pinned here
      // (same keys as a repository could set, so ours win), only https (file:// in tests) stays open.
      config.push(
        ['protocol.allow', 'never'],
        ['protocol.https.allow', 'always'],
        ['protocol.http.allow', /^http:\/\//i.test(this.remoteBase) ? 'always' : 'never'],
        ['protocol.file.allow', this.remoteIsHttp ? 'never' : 'always'],
        ['protocol.ext.allow', 'never'],
        ['protocol.fd.allow', 'never'],
        ['protocol.git.allow', 'never'],
        ['protocol.ssh.allow', 'never'],
        ['fetch.recurseSubmodules', 'false'],
        ['submodule.recurse', 'false'],
      );
      if (this.remoteIsHttp) {
        const key = `http.${this.remoteBase}.extraheader`;
        config.push([key, '']);
        if (options.extraHeader) config.push([key, options.extraHeader]);
      }
    }
    const trusted: Record<string, string> = {
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: this.askpass,
      SSH_ASKPASS: this.askpass,
      GIT_PAGER: 'cat',
      PAGER: 'cat',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_CONFIG_COUNT: String(config.length),
    };
    config.forEach(([key, value], index) => {
      trusted[`GIT_CONFIG_KEY_${index}`] = key;
      trusted[`GIT_CONFIG_VALUE_${index}`] = value;
    });
    if (options.network) {
      trusted.GIT_CONFIG_NOSYSTEM = '1';
      trusted.GIT_CONFIG_GLOBAL = this.emptyConfig;
    }
    if ((options.locale ?? 'C') === 'C') {
      trusted.LC_ALL = 'C';
      trusted.LANG = 'C';
      trusted.LANGUAGE = 'C';
    }
    if (options.identity) {
      trusted.GIT_AUTHOR_NAME = options.identity.name;
      trusted.GIT_AUTHOR_EMAIL = options.identity.email;
      trusted.GIT_COMMITTER_NAME = options.identity.name;
      trusted.GIT_COMMITTER_EMAIL = options.identity.email;
    }
    return withTrustedEnv(buildChildEnv(), trusted);
  }

  /**
   * Refuses a network command when the repository's own config (local, worktree, includes) could
   * redirect it or weaken TLS — see {@link unsafeNetworkConfigKeys}. Runs without any token.
   */
  async assertSafeNetworkConfig(cwd: string): Promise<void> {
    const result = await execCommand('git', ['config', '--list', '--show-scope', '-z'], {
      cwd,
      env: this.buildEnv({ network: true }),
      timeoutMs: 30_000,
      maxOutputBytes: 4 * 1024 * 1024,
    });
    if (result.spawnError) {
      throw new RunnerError('INTERNAL', 'git est introuvable sur le serveur.', { reason: 'GIT_FAILED', detail: result.spawnError.code });
    }
    if (result.exitCode !== 0 || result.truncated) {
      throw new RunnerError('CONFLICT', 'La configuration Git du dépôt est illisible : opération réseau refusée.', {
        reason: 'GIT_CONFIG_UNSAFE',
        raw: redactSecrets(`$ git config --list --show-scope\n${result.stderr}`.trim()).slice(-4000),
        untouched: "Rien n'a été envoyé ni récupéré.",
      });
    }
    const unsafe = unsafeNetworkConfigKeys(result.stdout);
    if (unsafe.length > 0) {
      throw new RunnerError('CONFLICT', `La configuration Git du dépôt modifie les échanges réseau (${unsafe.slice(0, 3).join(', ')}) : opération refusée.`, {
        reason: 'GIT_CONFIG_UNSAFE',
        detail: 'Retirez ces réglages de .git/config (ou config.worktree) puis relancez.',
        data: { keys: unsafe.slice(0, 50) },
        untouched: "Rien n'a été envoyé ni récupéré.",
      });
    }
  }

  async run(args: readonly string[], options: GitRunOptions): Promise<ExecResult> {
    if (options.network) await this.assertSafeNetworkConfig(options.cwd);
    const result = await execCommand('git', args, {
      cwd: options.cwd,
      env: this.buildEnv(options),
      timeoutMs: options.timeoutMs ?? 60_000,
      input: options.input,
      onStderr: options.onStderr,
      onStdout: options.onStdout,
      signal: options.signal,
      maxOutputBytes: options.maxOutputBytes,
    });
    if (result.spawnError) {
      throw new RunnerError('INTERNAL', 'git est introuvable sur le serveur.', { reason: 'GIT_FAILED', detail: result.spawnError.code });
    }
    if (!options.allowFailure && result.exitCode !== 0) {
      const output = `${result.stderr}\n${result.stdout}`;
      if (result.timedOut) throw new GitCommandError('La commande git a dépassé le délai.', args, result, { reason: 'TIMEOUT' });
      if (options.network && isAuthFailure(output)) {
        throw new GitCommandError("GitHub a refusé l'accès au dépôt.", args, result, { reason: 'GIT_AUTH_FAILED' });
      }
      throw new GitCommandError(firstErrorLine(output) ?? `git ${args[0] ?? ''} a échoué.`, args, result);
    }
    return result;
  }

  /** stdout of a command that must succeed, trimmed. */
  async output(args: readonly string[], options: GitRunOptions): Promise<string> {
    return (await this.run(args, options)).stdout.trim();
  }

  /** stdout or null when the command fails (rev-parse of a missing ref…). */
  async tryOutput(args: readonly string[], options: GitRunOptions): Promise<string | null> {
    const result = await this.run(args, { ...options, allowFailure: true });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }
}

/** First meaningful `fatal:`/`error:` line of git output, for the French message prefix. */
export function firstErrorLine(output: string): string | null {
  const line = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^(fatal|error|erreur):/i.test(l));
  if (!line) return null;
  return `git : ${redactSecrets(line.replace(/^(fatal|error|erreur):\s*/i, ''))}`.slice(0, 300);
}
