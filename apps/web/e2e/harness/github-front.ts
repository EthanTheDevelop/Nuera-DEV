/**
 * TEST-ONLY — standalone fake GitHub for the local stack, wrapping the unit-test fake
 * (`apps/web/src/server/github/test/fake-github.ts`, one instance per GitHub App, each on a random
 * port) behind one fixed port:
 *
 *   /api/v3/*      REST API (GITHUB_API_URL), routed to the app of the caller — the `iss` of an app JWT,
 *                  the app that issued an installation token, the app a manifest code was bound to —
 *                  with a few additions:
 *                  · a STABLE key per app and per stack (persisted): JWTs signed with it are re-signed
 *                    for the inner fake, whose key changes at every start;
 *                  · installation tokens and pull requests persisted across restarts;
 *                  · pull request numbers per repository, shared by every app (as on GitHub);
 *                  · branches, `pushed_at`, `size` (Ko) and PR head SHAs read from the REAL bare repositories;
 *   /settings/apps/new, /organizations/:org/settings/apps/new
 *                  github.com « Create GitHub App » (GITHUB_WEB_URL): binds the next unused declared app
 *                  whose owner matches (organization route: that organization; personal route: a user
 *                  account), refuses a name already used by another app (GitHub App names are global,
 *                  34 characters at most), then redirects to the manifest's `redirect_url` with a
 *                  one-time conversion code;
 *   /apps/:slug/installations/new[/permissions]
 *                  installation pages of that app: one link per account it can be installed on → the
 *                  app's `setup_url` (a private app can only be installed on its owner);
 *   /__harness/*   health, state (per app), recorded requests and controls (revoked key, suspended
 *                  installation, checks/statuses/reviews of pull requests, next app to bind, release).
 */
import { createSign, createVerify, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { addInstallation, startFakeGithub, type FakeGithub, type IssuedToken } from '../../src/server/github/test/fake-github';
import { listBareBranches, readBareContents } from './fixture-repos';
import type { FixtureRepoState } from './state';

/** Size of a bare repository on disk, in kilobytes like GitHub's `size` (D03 « 84 Mo »). */
export function bareSizeKb(bare: string): number {
  let bytes = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) bytes += statSync(full).size;
    }
  };
  try {
    walk(bare);
  } catch {
    return 0;
  }
  return Math.max(1, Math.ceil(bytes / 1024));
}

export const FULL_PERMISSIONS = { contents: 'write', pull_requests: 'write', metadata: 'read', checks: 'read', statuses: 'read', issues: 'read' };

/** GitHub limit on an App name. */
export const GITHUB_APP_NAME_MAX = 34;

export interface FakeGithubAccount {
  login: string;
  id: number;
  type: 'Organization' | 'User';
}

export interface FakeGithubAppConfig {
  key: string;
  appId: number;
  slug: string;
  owner: FakeGithubAccount;
  installations: Array<{ account: string; installationId: number }>;
}

export interface FakeGithubConfig {
  /** 0 = random (tests). */
  port: number;
  apps: FakeGithubAppConfig[];
  /** Web app origin (default setup URL when no manifest was posted). */
  appUrl: string;
  accounts: FakeGithubAccount[];
  repos: FixtureRepoState[];
  /** Persistence folder (app keys, tokens, pull requests, controls). */
  stateDir: string;
}

export interface FakeGithubFront {
  url: string;
  apiUrl: string;
  /** Inner fake of each app (`a`, `a2`, `b`…). */
  inners: Record<string, FakeGithub>;
  close(): Promise<void>;
}

interface PersistedManifest {
  name: string;
  redirectUrl: string;
  setupUrl: string | null;
  url: string | null;
  public: boolean;
  boundAt: string;
}

interface PersistedApp {
  tokens: Array<IssuedToken & { expiresAt: string }>;
  pulls: FakeGithub['pulls'];
  checkRuns: FakeGithub['checkRuns'];
  statuses: FakeGithub['statuses'];
  reviews: FakeGithub['reviews'];
  rejectJwt: boolean;
  suspended: Record<string, string>;
  manifest: PersistedManifest | null;
}

interface PersistedState {
  version: 2;
  apps: Record<string, PersistedApp>;
  /** App bound by the next « Create GitHub App » (control `bindNext`), whatever its owner. */
  bindNext: string | null;
  /** Every pull request, with its app (written for readers of fake-state.json). */
  pulls: Array<FakeGithub['pulls'][number] & { app: string; appId: number }>;
}

const emptyApp = (): PersistedApp => ({ tokens: [], pulls: [], checkRuns: [], statuses: [], reviews: [], rejectJwt: false, suspended: {}, manifest: null });

/** Reads fake-state.json; a version-1 file (single app) becomes the state of app `a`. */
function loadPersisted(file: string): PersistedState {
  const empty: PersistedState = { version: 2, apps: {}, bindNext: null, pulls: [] };
  if (!existsSync(file)) return empty;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<PersistedState> & Partial<PersistedApp> & { manifest?: (Omit<PersistedManifest, 'public' | 'boundAt'> & Partial<PersistedManifest>) | null };
    if (raw.version === 2 && raw.apps) return { ...empty, ...raw, apps: raw.apps, bindNext: raw.bindNext ?? null } as PersistedState;
    const legacy: PersistedApp = {
      ...emptyApp(),
      tokens: raw.tokens ?? [],
      pulls: (raw.pulls as FakeGithub['pulls'] | undefined) ?? [],
      checkRuns: raw.checkRuns ?? [],
      statuses: raw.statuses ?? [],
      reviews: raw.reviews ?? [],
      rejectJwt: raw.rejectJwt ?? false,
      suspended: raw.suspended ?? {},
      manifest: raw.manifest ? { ...raw.manifest, public: raw.manifest.public ?? true, boundAt: raw.manifest.boundAt ?? new Date(0).toISOString() } : null,
    };
    return { ...empty, apps: { a: legacy } };
  } catch {
    return empty;
  }
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · faux GitHub</title></head><body style="font-family:system-ui,sans-serif;max-width:640px;margin:10vh auto;padding:0 16px;color:#1f2328"><p style="color:#59636e;font-size:13px">Faux GitHub de la pile de test Nuera Dev</p><h1 style="font-size:22px">${escapeHtml(title)}</h1>${body}</body></html>`;
}

/** Persisted RS256 key of an app (PKCS#1, as GitHub hands out). App `a` keeps the v1 file name. */
function loadOrCreateAppKey(stateDir: string, key: string): string {
  const file = path.join(stateDir, key === 'a' ? 'app-key.pem' : `app-key-${key}.pem`);
  if (existsSync(file)) return readFileSync(file, 'utf8');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(file, pem, { mode: 0o600 });
  return pem;
}

/** `Bearer h.p.s` signed with `fromPem` → same JWT signed with `toPem`; null when the signature is wrong. */
export function resignJwt(authorization: string, fromPem: string, toPem: string): string | null {
  const match = /^bearer\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/i.exec(authorization.trim());
  if (!match) return null;
  const [, header, payload, signature] = match;
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${header}.${payload}`);
  if (!verifier.verify(createPublicKey(fromPem), Buffer.from(signature!, 'base64url'))) return null;
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `Bearer ${header}.${payload}.${signer.sign(toPem).toString('base64url')}`;
}

/** `iss` of an app JWT (`Bearer h.p.s`), null when the header is not a JWT. Exported for tests. */
export function jwtIssuer(authorization: string | null): string | null {
  const match = /^bearer\s+[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/i.exec((authorization ?? '').trim());
  if (!match) return null;
  try {
    const payload = JSON.parse(Buffer.from(match[1]!, 'base64url').toString('utf8')) as { iss?: unknown };
    return payload.iss === undefined || payload.iss === null ? null : String(payload.iss);
  } catch {
    return null;
  }
}

/**
 * App a « Create GitHub App » form binds: the forced one (`bindNext`) when unbound, else the first
 * unbound app whose owner matches the route (organization login, or any user account for the
 * personal route). Exported for tests.
 */
export function pickAppToBind(apps: readonly FakeGithubAppConfig[], bound: (key: string) => boolean, route: { organization: string | null }, bindNext: string | null): FakeGithubAppConfig | null {
  if (bindNext) {
    const forced = apps.find((app) => app.key === bindNext);
    if (forced && !bound(forced.key)) return forced;
  }
  return (
    apps.find((app) => !bound(app.key) && (route.organization ? app.owner.type === 'Organization' && app.owner.login.toLowerCase() === route.organization.toLowerCase() : app.owner.type === 'User')) ?? null
  );
}

/** Next pull request number of a repository (numbers are per repository, shared by every app). Exported for tests. */
export function nextPullNumber(existing: readonly number[]): number {
  return Math.max(56, ...existing) + 1;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(text);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

interface AppRuntime {
  config: FakeGithubAppConfig;
  inner: FakeGithub;
  key: string;
  pem: string;
}

interface RecordedFrontRequest {
  app: string | null;
  method: string;
  path: string;
  status: number;
  authorization: string | null;
}

export async function startFakeGithubFront(config: FakeGithubConfig): Promise<FakeGithubFront> {
  if (config.apps.length === 0) throw new Error('Faux GitHub : aucune application déclarée.');
  mkdirSync(config.stateDir, { recursive: true });
  const stateFile = path.join(config.stateDir, 'fake-state.json');
  let persisted = loadPersisted(stateFile);
  for (const app of config.apps) persisted.apps[app.key] = { ...emptyApp(), ...persisted.apps[app.key] };

  const pushCache = new Map<string, { at: number; value: string | null }>();
  function latestPush(repo: FixtureRepoState): string | null {
    const cached = pushCache.get(repo.fullName);
    if (cached && Date.now() - cached.at < 30_000) return cached.value;
    let value: string | null = null;
    try {
      value = listBareBranches(repo.bare)[0]?.date ?? null;
      if (value) value = new Date(value).toISOString();
    } catch {
      value = null;
    }
    pushCache.set(repo.fullName, { at: Date.now(), value });
    return value;
  }

  const runtimes: AppRuntime[] = [];
  for (const app of config.apps) {
    const inner = await startFakeGithub({ appId: app.appId, slug: app.slug, owner: app.owner });
    const saved = persisted.apps[app.key]!;
    for (const installation of app.installations) {
      const account = config.accounts.find((item) => item.login === installation.account);
      if (!account) throw new Error(`Faux GitHub : compte inconnu « ${installation.account} » (application ${app.key}).`);
      const repos = config.repos.filter((repo) => repo.owner === account.login);
      addInstallation(
        inner,
        {
          id: installation.installationId,
          account: { login: account.login, id: account.id, type: account.type },
          permissions: { ...FULL_PERMISSIONS },
          repositorySelection: 'selected',
          suspendedAt: saved.suspended[account.login] ?? null,
          repos: repos.map((repo) => repo.name),
        },
        repos.map((repo) => ({ id: repo.id, name: repo.name, private: repo.private, language: repo.language, defaultBranch: repo.defaultBranch, pushedAt: latestPush(repo) ?? new Date().toISOString() })),
      );
    }
    const now = Date.now();
    inner.tokens.push(...saved.tokens.filter((token) => Date.parse(token.expiresAt) > now));
    inner.pulls.push(...saved.pulls);
    inner.checkRuns.push(...saved.checkRuns);
    inner.statuses.push(...saved.statuses);
    inner.reviews.push(...saved.reviews);
    inner.rejectJwt = saved.rejectJwt;
    runtimes.push({ config: app, inner, key: app.key, pem: loadOrCreateAppKey(config.stateDir, app.key) });
  }
  const byKey = (key: string | null | undefined) => runtimes.find((item) => item.key === key) ?? null;
  const defaultApp = runtimes[0]!;
  const conversionOwners = new Map<string, string>();
  const requests: RecordedFrontRequest[] = [];

  const save = () => {
    const apps: Record<string, PersistedApp> = {};
    for (const runtime of runtimes) {
      const previous = persisted.apps[runtime.key] ?? emptyApp();
      const tokens = runtime.inner.tokens.map((token) => {
        const known = previous.tokens.find((item) => item.token === token.token);
        return { ...token, expiresAt: known?.expiresAt ?? new Date(Date.now() + 3600_000).toISOString() };
      });
      apps[runtime.key] = {
        ...previous,
        tokens: tokens.filter((token) => Date.parse(token.expiresAt) > Date.now()),
        pulls: runtime.inner.pulls,
        checkRuns: runtime.inner.checkRuns,
        statuses: runtime.inner.statuses,
        reviews: runtime.inner.reviews,
        rejectJwt: runtime.inner.rejectJwt,
      };
    }
    persisted = { ...persisted, version: 2, apps, pulls: allPulls() };
    writeFileSync(stateFile, `${JSON.stringify(persisted, null, 2)}\n`);
  };

  function allPulls(): PersistedState['pulls'] {
    return runtimes.flatMap((runtime) => runtime.inner.pulls.map((pull) => ({ ...pull, app: runtime.key, appId: runtime.config.appId })));
  }

  const repoOf = (owner: string, name: string) => config.repos.find((repo) => repo.owner === owner && repo.name === name) ?? null;
  const refreshPushedAt = (inner: FakeGithub, owner: string, name: string) => {
    const repo = repoOf(owner, name);
    const record = inner.repos.find((item) => item.owner === owner && item.name === name);
    if (repo && record) record.pushedAt = latestPush(repo) ?? record.pushedAt;
  };

  /** App of an API call: JWT issuer, installation token, conversion code; else the first app. */
  function routeOf(authorization: string | null, apiPath: string): AppRuntime {
    const issuer = jwtIssuer(authorization);
    if (issuer) return runtimes.find((item) => String(item.config.appId) === issuer) ?? defaultApp;
    const token = /^(?:token|bearer)\s+(\S+)$/i.exec((authorization ?? '').trim())?.[1];
    if (token) {
      const owner = runtimes.find((item) => item.inner.tokens.some((issued) => issued.token === token));
      if (owner) return owner;
    }
    const conversion = /^\/app-manifests\/([^/]+)\/conversions$/.exec(apiPath);
    if (conversion) return byKey(conversionOwners.get(decodeURIComponent(conversion[1]!))) ?? defaultApp;
    return defaultApp;
  }

  /**
   * `GET /repos/{owner}/{repo}/contents/{path}?ref=` (D03 reads the root, package.json, CLAUDE.md):
   * access checked by the inner fake (the token must read this repository's contents, as on
   * GitHub, through its `/branches` route), content read from the REAL bare repository.
   */
  async function serveContents(inner: FakeGithub, owner: string, name: string, rel: string, ref: string | null, headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
    const repo = repoOf(owner, name);
    const probe = await fetch(`${inner.url}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches`, { headers });
    if (probe.status !== 200) return { status: probe.status, body: await probe.json().catch(() => ({ message: 'Not Found' })) };
    const found = repo ? readBareContents(repo.bare, rel, ref || repo.defaultBranch) : null;
    if (!found) return { status: 404, body: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest/repos/contents#get-repository-content' } };
    const api = `https://api.github.com/repos/${owner}/${name}/contents`;
    if (found.type === 'dir') {
      return {
        status: 200,
        body: found.entries.map((entry) => ({ type: entry.type, name: entry.name, path: entry.path, sha: entry.sha, size: entry.size, url: `${api}/${entry.path}` })),
      };
    }
    return {
      status: 200,
      body: { type: 'file', encoding: 'base64', name: found.name, path: found.path, sha: found.sha, size: found.size, content: found.content.toString('base64'), url: `${api}/${found.path}` },
    };
  }

  async function proxyApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const apiPath = url.pathname.slice('/api/v3'.length) || '/';
    const method = req.method ?? 'GET';
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
    const runtime = routeOf(req.headers.authorization ?? null, apiPath);
    const { inner } = runtime;
    let authorization = req.headers.authorization ?? null;
    if (authorization && jwtIssuer(authorization)) authorization = resignJwt(authorization, runtime.pem, inner.pem) ?? authorization;
    const record = (status: number) => requests.push({ app: runtime.key, method, path: apiPath, status, authorization: req.headers.authorization ? req.headers.authorization.replace(/\s.+$/, ' ***') : null });

    let match: RegExpExecArray | null;
    if (method === 'GET' && (match = /^\/repos\/([^/]+)\/([^/]+)$/.exec(apiPath))) refreshPushedAt(inner, match[1]!, match[2]!);
    if (method === 'GET' && apiPath === '/installation/repositories') for (const repo of config.repos) refreshPushedAt(inner, repo.owner, repo.name);

    const headers: Record<string, string> = { accept: String(req.headers.accept ?? 'application/json') };
    if (authorization) headers.authorization = authorization;
    if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type']);
    if (req.headers['x-github-api-version']) headers['x-github-api-version'] = String(req.headers['x-github-api-version']);
    if (method === 'GET' && (match = /^\/repos\/([^/]+)\/([^/]+)\/contents(?:\/(.*))?$/.exec(apiPath))) {
      const served = await serveContents(inner, match[1]!, match[2]!, decodeURIComponent(match[3] ?? ''), url.searchParams.get('ref'), headers);
      record(served.status);
      res.writeHead(served.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(served.body));
      return;
    }
    // A pull request already open for this head (through any app) is refused, as on GitHub.
    if (method === 'POST' && (match = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(apiPath))) {
      const [, owner, name] = match;
      let head: string | null = null;
      try {
        head = (JSON.parse(body ?? '{}') as { head?: string }).head ?? null;
      } catch {
        head = null;
      }
      if (head && allPulls().some((pull) => pull.owner === owner && pull.repo === name && pull.head === head)) {
        record(422);
        return send(res, 422, { message: 'Validation Failed', errors: [{ message: `A pull request already exists for ${owner}:${head}.` }] });
      }
    }
    const upstream = await fetch(`${inner.url}${apiPath}${url.search}`, { method, headers, body });
    record(upstream.status);
    let text = await upstream.text();
    const outHeaders: Record<string, string> = {};
    for (const name of ['content-type', 'x-github-request-id', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'github-authentication-token-expiration', 'link']) {
      const value = upstream.headers.get(name);
      if (value) outHeaders[name] = value;
    }
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (method === 'POST' && /^\/app-manifests\/[^/]+\/conversions$/.test(apiPath) && upstream.status === 201 && json && typeof json === 'object') {
      // The stable key of this app, and the name GitHub keeps from the manifest.
      const manifest = persisted.apps[runtime.key]?.manifest;
      Object.assign(json, { pem: runtime.pem, ...(manifest ? { name: manifest.name } : {}) });
      text = JSON.stringify(json);
    }
    if (method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(apiPath) && upstream.status === 201 && json && typeof json === 'object') {
      const issued = json as { token: string; expires_at: string };
      const token = inner.tokens.find((item) => item.token === issued.token);
      if (token) persisted.apps[runtime.key]!.tokens.push({ ...token, expiresAt: issued.expires_at });
      save();
    }
    if (method === 'GET' && (match = /^\/repos\/([^/]+)\/([^/]+)\/branches$/.exec(apiPath)) && upstream.status === 200) {
      const repo = repoOf(match[1]!, match[2]!);
      if (repo) {
        const branches = listBareBranches(repo.bare);
        json = branches.map((branch) => ({
          name: branch.name,
          commit: { sha: branch.sha, url: `https://api.github.com/repos/${repo.fullName}/commits/${branch.sha}` },
          protected: branch.name === repo.defaultBranch,
        }));
        text = JSON.stringify(json);
      }
    }
    // Repository size (Ko), read from the bare repository: D03 shows it next to the visibility.
    if (method === 'GET' && (match = /^\/repos\/([^/]+)\/([^/]+)$/.exec(apiPath)) && upstream.status === 200 && json && typeof json === 'object') {
      const repo = repoOf(match[1]!, match[2]!);
      if (repo) {
        (json as { size?: number }).size = bareSizeKb(repo.bare);
        text = JSON.stringify(json);
      }
    }
    if (method === 'GET' && apiPath === '/installation/repositories' && upstream.status === 200 && json && typeof json === 'object') {
      const list = (json as { repositories?: Array<{ name: string; owner?: { login?: string }; size?: number }> }).repositories ?? [];
      for (const item of list) {
        const repo = item.owner?.login ? repoOf(item.owner.login, item.name) : null;
        if (repo) item.size = bareSizeKb(repo.bare);
      }
      text = JSON.stringify(json);
    }
    if (method === 'POST' && (match = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(apiPath)) && upstream.status === 201 && json && typeof json === 'object') {
      const [, owner, name] = match;
      const repo = repoOf(owner!, name!);
      const pullJson = json as { number: number; html_url?: string; head: { ref: string; sha: string } };
      // The inner fake numbers its pulls on its own: the record it just pushed is renumbered per repository.
      const last = inner.pulls[inner.pulls.length - 1];
      const created = last && last.owner === owner && last.repo === name && last.head === pullJson.head.ref ? last : undefined;
      if (created) {
        const number = nextPullNumber(runtimes.flatMap((item) => item.inner.pulls.filter((pull) => pull !== created && pull.owner === owner && pull.repo === name).map((pull) => pull.number)));
        created.number = number;
        pullJson.number = number;
        pullJson.html_url = `https://github.com/${owner}/${name}/pull/${number}`;
      }
      const sha = repo ? listBareBranches(repo.bare).find((branch) => branch.name === pullJson.head.ref)?.sha : undefined;
      if (sha) {
        pullJson.head.sha = sha;
        if (created) created.headSha = sha;
      }
      text = JSON.stringify(pullJson);
      save();
    }
    res.writeHead(upstream.status, { ...outHeaders, 'cache-control': 'no-store' });
    res.end(text);
  }

  function setupUrl(runtime: AppRuntime): string {
    return persisted.apps[runtime.key]?.manifest?.setupUrl ?? `${config.appUrl.replace(/\/+$/, '')}/api/integrations/github/setup`;
  }

  const bound = (key: string) => Boolean(persisted.apps[key]?.manifest);

  function appState(runtime: AppRuntime) {
    return {
      key: runtime.key,
      appId: runtime.config.appId,
      slug: runtime.config.slug,
      owner: runtime.config.owner.login,
      bound: bound(runtime.key),
      manifest: persisted.apps[runtime.key]?.manifest ?? null,
      rejectJwt: runtime.inner.rejectJwt,
      installations: runtime.inner.installations.map((item) => ({ id: item.id, account: item.account.login, suspendedAt: item.suspendedAt ?? null, repos: item.repos })),
      tokensIssued: runtime.inner.tokens.length,
      pulls: runtime.inner.pulls,
    };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    if (url.pathname === '/api/v3' || url.pathname.startsWith('/api/v3/')) return proxyApi(req, res, url);

    // --- Harness endpoints ---------------------------------------------------------------------
    if (url.pathname === '/__harness/health') return send(res, 200, { ok: true, apps: runtimes.map((item) => ({ key: item.key, appId: item.config.appId, slug: item.config.slug })) });
    if (url.pathname === '/__harness/state') {
      const a = appState(defaultApp);
      return send(res, 200, {
        // Projection of app `a` (version-1 readers).
        appId: a.appId,
        slug: a.slug,
        manifest: a.manifest,
        rejectJwt: a.rejectJwt,
        installations: a.installations,
        tokensIssued: runtimes.reduce((total, item) => total + item.inner.tokens.length, 0),
        apps: runtimes.map(appState),
        bindNext: persisted.bindNext,
        pulls: allPulls(),
        checkRuns: defaultApp.inner.checkRuns,
        statuses: defaultApp.inner.statuses,
        reviews: defaultApp.inner.reviews,
        requests: requests.length,
      });
    }
    if (url.pathname === '/__harness/requests') {
      const since = Number(url.searchParams.get('since') ?? 0);
      return send(res, 200, { total: requests.length, requests: requests.slice(Number.isFinite(since) ? since : 0) });
    }
    if (url.pathname === '/__harness/control' && method === 'POST') {
      const input = JSON.parse((await readBody(req)) || '{}') as {
        /** App of `rejectJwt` / `suspend` (default `a`). */
        app?: string;
        rejectJwt?: boolean;
        suspend?: { account: string; suspended: boolean };
        checkRuns?: FakeGithub['checkRuns'];
        statuses?: FakeGithub['statuses'];
        reviews?: FakeGithub['reviews'];
        resetRequests?: boolean;
        /** The next « Create GitHub App » binds this app (null: by owner). */
        bindNext?: string | null;
        /** Forgets the binding of this app (as if it had been deleted on GitHub). */
        release?: string;
      };
      const target = input.app ? byKey(input.app) : defaultApp;
      if (!target) return send(res, 404, { message: `Application inconnue : ${input.app}` });
      if (typeof input.rejectJwt === 'boolean') target.inner.rejectJwt = input.rejectJwt;
      if (input.suspend) {
        const installation = target.inner.installations.find((item) => item.account.login === input.suspend!.account);
        if (!installation) return send(res, 404, { message: `Compte inconnu pour l'application ${target.key} : ${input.suspend.account}` });
        installation.suspendedAt = input.suspend.suspended ? new Date().toISOString() : null;
        const saved = persisted.apps[target.key]!;
        if (input.suspend.suspended) saved.suspended[installation.account.login] = installation.suspendedAt!;
        else delete saved.suspended[installation.account.login];
      }
      // Checks of pull requests concern every app (they belong to the commit, not to the caller).
      for (const runtime of runtimes) {
        if (input.checkRuns) runtime.inner.checkRuns.splice(0, runtime.inner.checkRuns.length, ...input.checkRuns);
        if (input.statuses) runtime.inner.statuses.splice(0, runtime.inner.statuses.length, ...input.statuses);
        if (input.reviews) runtime.inner.reviews.splice(0, runtime.inner.reviews.length, ...input.reviews);
        if (input.resetRequests) runtime.inner.requests.length = 0;
      }
      if (input.resetRequests) requests.length = 0;
      if (input.bindNext !== undefined) {
        if (input.bindNext !== null && !byKey(input.bindNext)) return send(res, 404, { message: `Application inconnue : ${input.bindNext}` });
        persisted.bindNext = input.bindNext;
      }
      if (input.release) {
        if (!byKey(input.release)) return send(res, 404, { message: `Application inconnue : ${input.release}` });
        persisted.apps[input.release]!.manifest = null;
      }
      save();
      return send(res, 200, { ok: true });
    }

    // --- github.com pages ----------------------------------------------------------------------
    let match: RegExpExecArray | null;
    if (method === 'POST' && (url.pathname === '/settings/apps/new' || (match = /^\/organizations\/([^/]+)\/settings\/apps\/new$/.exec(url.pathname)))) {
      const organization = url.pathname === '/settings/apps/new' ? null : decodeURIComponent(/^\/organizations\/([^/]+)\//.exec(url.pathname)![1]!);
      const form = new URLSearchParams(await readBody(req));
      let manifest: { name?: string; redirect_url?: string; setup_url?: string; url?: string; public?: boolean };
      try {
        manifest = JSON.parse(form.get('manifest') ?? '') as typeof manifest;
      } catch {
        return send(res, 422, page('Manifest invalide', '<p>Le champ <code>manifest</code> est absent ou illisible.</p>'));
      }
      if (!manifest.redirect_url) return send(res, 422, page('Manifest invalide', '<p><code>redirect_url</code> manquant.</p>'));
      const name = (manifest.name ?? 'Nuera Dev').trim();
      if (name.length > GITHUB_APP_NAME_MAX) {
        return send(res, 422, page('Nom trop long', `<p>Le nom « ${escapeHtml(name)} » dépasse ${GITHUB_APP_NAME_MAX} caractères (limite de GitHub).</p>`));
      }
      const taken = runtimes.find((item) => persisted.apps[item.key]?.manifest?.name.toLowerCase() === name.toLowerCase());
      if (taken) return send(res, 422, page('Nom déjà utilisé', `<p>Le nom « ${escapeHtml(name)} » est déjà utilisé par une autre application GitHub.</p>`));
      const picked = pickAppToBind(
        runtimes.map((item) => item.config),
        bound,
        { organization },
        persisted.bindNext,
      );
      if (!picked) {
        return send(res, 422, page('Aucune application disponible', `<p>Aucune application GitHub de test disponible pour ${escapeHtml(organization ?? 'un compte personnel')}.</p>`));
      }
      const runtime = byKey(picked.key)!;
      persisted.apps[picked.key]!.manifest = {
        name,
        redirectUrl: manifest.redirect_url,
        setupUrl: manifest.setup_url ?? null,
        url: manifest.url ?? null,
        public: manifest.public !== false,
        boundAt: new Date().toISOString(),
      };
      persisted.bindNext = null;
      save();
      const code = `code-${randomBytes(12).toString('hex')}`;
      runtime.inner.conversionCodes.add(code);
      conversionOwners.set(code, picked.key);
      const target = new URL(manifest.redirect_url);
      target.searchParams.set('code', code);
      const state = url.searchParams.get('state');
      if (state) target.searchParams.set('state', state);
      return redirect(res, target.toString());
    }
    if (method === 'GET' && (match = /^\/apps\/([^/]+)\/installations\/new\/permissions$/.exec(url.pathname))) {
      const runtime = runtimes.find((item) => item.config.slug === decodeURIComponent(match![1]!));
      if (!runtime) return send(res, 404, page('Application introuvable', '<p>Aucune application de test pour ce lien.</p>'));
      const targetId = Number(url.searchParams.get('target_id'));
      const account = config.accounts.find((item) => item.id === targetId);
      const installation = account ? runtime.config.installations.find((item) => item.account === account.login) : undefined;
      if (!account || !installation) return send(res, 404, page('Compte introuvable', '<p>Aucune installation de test de cette application pour ce compte.</p>'));
      const manifest = persisted.apps[runtime.key]?.manifest;
      if (manifest && !manifest.public && account.login !== runtime.config.owner.login) {
        return send(res, 403, page('Application privée', `<p>Cette application privée ne peut être installée que sur ${escapeHtml(runtime.config.owner.login)}.</p>`));
      }
      const target = new URL(setupUrl(runtime));
      target.searchParams.set('installation_id', String(installation.installationId));
      target.searchParams.set('setup_action', 'install');
      const state = url.searchParams.get('state');
      if (state) target.searchParams.set('state', state);
      return redirect(res, target.toString());
    }
    if (method === 'GET' && (match = /^\/apps\/([^/]+)\/installations\/new$/.exec(url.pathname))) {
      const runtime = runtimes.find((item) => item.config.slug === decodeURIComponent(match![1]!));
      if (!runtime) return send(res, 404, page('Application introuvable', '<p>Aucune application de test pour ce lien.</p>'));
      const state = url.searchParams.get('state');
      const targetId = url.searchParams.get('target_id');
      const base = `/apps/${encodeURIComponent(runtime.config.slug)}/installations/new/permissions`;
      const installable = config.accounts.filter((account) => runtime.config.installations.some((item) => item.account === account.login));
      const link = (account: { id: number }) => `${base}?target_id=${account.id}${state ? `&state=${encodeURIComponent(state)}` : ''}`;
      if (targetId) {
        const account = installable.find((item) => String(item.id) === targetId || item.login === targetId);
        if (account) return redirect(res, link(account));
      }
      const items = installable
        .map((account) => `<li style="margin:8px 0"><a href="${escapeHtml(link(account))}">Installer sur ${escapeHtml(account.login)}</a> <span style="color:#59636e">(${account.type === 'Organization' ? 'organisation' : 'compte personnel'})</span></li>`)
        .join('');
      return send(res, 200, page(`Installer ${persisted.apps[runtime.key]?.manifest?.name ?? runtime.config.slug}`, `<p>Choisissez le compte où installer l'application.</p><ul>${items}</ul>`));
    }
    if (method === 'GET' && /^\/(organizations\/[^/]+\/)?settings\/installations\/\d+$/.test(url.pathname)) {
      return send(res, 200, page('Installation de l\'application', '<p>Les dépôts accessibles sont fixés par la pile de test.</p>'));
    }
    if (method === 'GET' && (match = /^\/apps\/([^/]+)$/.exec(url.pathname))) {
      const runtime = runtimes.find((item) => item.config.slug === decodeURIComponent(match![1]!));
      return send(res, 200, page(runtime ? (persisted.apps[runtime.key]?.manifest?.name ?? runtime.config.slug) : match[1]!, `<p><a href="/apps/${escapeHtml(match[1]!)}/installations/new">Installer</a></p>`));
    }
    return send(res, 404, page('Page introuvable', `<p>${escapeHtml(method)} ${escapeHtml(url.pathname)}</p>`));
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) send(res, 500, { message: error instanceof Error ? error.message : 'erreur' });
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', () => resolve());
  });
  save();
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    apiUrl: `${url}/api/v3`,
    inners: Object.fromEntries(runtimes.map((item) => [item.key, item.inner])),
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const runtime of runtimes) await runtime.inner.close();
    },
  };
}
