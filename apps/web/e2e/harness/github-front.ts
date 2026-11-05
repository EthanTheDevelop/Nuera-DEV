/**
 * TEST-ONLY — standalone fake GitHub for the local stack, wrapping the unit-test fake
 * (`apps/web/src/server/github/test/fake-github.ts`, started on a random port) behind one fixed port:
 *
 *   /api/v3/*      REST API (GITHUB_API_URL), proxied to the fake with a few additions:
 *                  · a STABLE app key per stack (persisted): JWTs signed with it are re-signed for
 *                    the inner fake, whose key changes at every start;
 *                  · installation tokens and pull requests persisted across restarts;
 *                  · branches, `pushed_at`, `size` (Ko) and PR head SHAs read from the REAL bare repositories;
 *   /settings/apps/new, /organizations/:org/settings/apps/new
 *                  github.com « Create GitHub App » (GITHUB_WEB_URL): confirms at once and redirects
 *                  to the manifest's `redirect_url` with a one-time conversion code;
 *   /apps/:slug/installations/new[/permissions]
 *                  installation pages: one link per test account → the app's `setup_url`;
 *   /__harness/*   health, state, recorded requests and controls (revoked key, suspended
 *                  installation, checks/statuses/reviews of pull requests).
 */
import { createSign, createVerify, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { addInstallation, startFakeGithub, type FakeGithub, type IssuedToken } from '../../src/server/github/test/fake-github';
import { listBareBranches, readBareContents } from './fixture-repos';
import type { FixtureAccount, FixtureRepoState } from './state';

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

export interface FakeGithubConfig {
  /** 0 = random (tests). */
  port: number;
  appId: number;
  slug: string;
  appOwner: { login: string; id: number; type: 'Organization' | 'User' };
  /** Web app origin (default setup URL when no manifest was posted). */
  appUrl: string;
  accounts: FixtureAccount[];
  repos: FixtureRepoState[];
  /** Persistence folder (app key, tokens, pull requests, controls). */
  stateDir: string;
}

export interface FakeGithubFront {
  url: string;
  apiUrl: string;
  inner: FakeGithub;
  close(): Promise<void>;
}

interface PersistedState {
  tokens: Array<IssuedToken & { expiresAt: string }>;
  pulls: FakeGithub['pulls'];
  checkRuns: FakeGithub['checkRuns'];
  statuses: FakeGithub['statuses'];
  reviews: FakeGithub['reviews'];
  rejectJwt: boolean;
  suspended: Record<string, string>;
  manifest: { name: string; redirectUrl: string; setupUrl: string | null; url: string | null } | null;
}

const emptyState = (): PersistedState => ({ tokens: [], pulls: [], checkRuns: [], statuses: [], reviews: [], rejectJwt: false, suspended: {}, manifest: null });

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · faux GitHub</title></head><body style="font-family:system-ui,sans-serif;max-width:640px;margin:10vh auto;padding:0 16px;color:#1f2328"><p style="color:#59636e;font-size:13px">Faux GitHub de la pile de test Nuera Dev</p><h1 style="font-size:22px">${escapeHtml(title)}</h1>${body}</body></html>`;
}

/** Persisted RS256 key of the app (PKCS#1, as GitHub hands out). */
function loadOrCreateAppKey(stateDir: string): string {
  const file = path.join(stateDir, 'app-key.pem');
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

export async function startFakeGithubFront(config: FakeGithubConfig): Promise<FakeGithubFront> {
  mkdirSync(config.stateDir, { recursive: true });
  const stateFile = path.join(config.stateDir, 'fake-state.json');
  const appKey = loadOrCreateAppKey(config.stateDir);
  let persisted: PersistedState = emptyState();
  if (existsSync(stateFile)) {
    try {
      persisted = { ...emptyState(), ...(JSON.parse(readFileSync(stateFile, 'utf8')) as Partial<PersistedState>) };
    } catch {
      persisted = emptyState();
    }
  }

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

  const inner = await startFakeGithub({ appId: config.appId, slug: config.slug, owner: config.appOwner });
  for (const account of config.accounts) {
    const repos = config.repos.filter((repo) => repo.owner === account.login);
    addInstallation(
      inner,
      {
        id: account.installationId,
        account: { login: account.login, id: account.id, type: account.type },
        permissions: { ...FULL_PERMISSIONS },
        repositorySelection: 'selected',
        suspendedAt: persisted.suspended[account.login] ?? null,
        repos: repos.map((repo) => repo.name),
      },
      repos.map((repo) => ({ id: repo.id, name: repo.name, private: repo.private, language: repo.language, defaultBranch: repo.defaultBranch, pushedAt: latestPush(repo) ?? new Date().toISOString() })),
    );
  }
  const now = Date.now();
  inner.tokens.push(...persisted.tokens.filter((token) => Date.parse(token.expiresAt) > now));
  inner.pulls.push(...persisted.pulls);
  inner.checkRuns.push(...persisted.checkRuns);
  inner.statuses.push(...persisted.statuses);
  inner.reviews.push(...persisted.reviews);
  inner.rejectJwt = persisted.rejectJwt;

  const save = () => {
    const tokens = inner.tokens.map((token) => {
      const known = persisted.tokens.find((item) => item.token === token.token);
      return { ...token, expiresAt: known?.expiresAt ?? new Date(Date.now() + 3600_000).toISOString() };
    });
    persisted = {
      ...persisted,
      tokens: tokens.filter((token) => Date.parse(token.expiresAt) > Date.now()),
      pulls: inner.pulls,
      checkRuns: inner.checkRuns,
      statuses: inner.statuses,
      reviews: inner.reviews,
      rejectJwt: inner.rejectJwt,
    };
    writeFileSync(stateFile, `${JSON.stringify(persisted, null, 2)}\n`);
  };

  const repoOf =(owner: string, name: string) => config.repos.find((repo) => repo.owner === owner && repo.name === name) ?? null;
  const refreshPushedAt = (owner: string, name: string) => {
    const repo = repoOf(owner, name);
    const record = inner.repos.find((item) => item.owner === owner && item.name === name);
    if (repo && record) record.pushedAt = latestPush(repo) ?? record.pushedAt;
  };

  /**
   * `GET /repos/{owner}/{repo}/contents/{path}?ref=` (D03 reads the root, package.json, CLAUDE.md):
   * access checked by the inner fake (the token must read this repository's contents, as on
   * GitHub, through its `/branches` route), content read from the REAL bare repository.
   */
  async function serveContents(owner: string, name: string, rel: string, ref: string | null, headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
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
    let authorization = req.headers.authorization ?? null;
    if (authorization && /^bearer\s+[^.\s]+\.[^.\s]+\.[^.\s]+$/i.test(authorization)) {
      authorization = resignJwt(authorization, appKey, inner.pem) ?? authorization;
    }
    let match: RegExpExecArray | null;
    if (method === 'GET' && (match = /^\/repos\/([^/]+)\/([^/]+)$/.exec(apiPath))) refreshPushedAt(match[1]!, match[2]!);
    if (method === 'GET' && apiPath === '/installation/repositories') for (const repo of config.repos) refreshPushedAt(repo.owner, repo.name);

    const headers: Record<string, string> = { accept: String(req.headers.accept ?? 'application/json') };
    if (authorization) headers.authorization = authorization;
    if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type']);
    if (req.headers['x-github-api-version']) headers['x-github-api-version'] = String(req.headers['x-github-api-version']);
    if (method === 'GET' && (match = /^\/repos\/([^/]+)\/([^/]+)\/contents(?:\/(.*))?$/.exec(apiPath))) {
      const served = await serveContents(match[1]!, match[2]!, decodeURIComponent(match[3] ?? ''), url.searchParams.get('ref'), headers);
      res.writeHead(served.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(served.body));
      return;
    }
    const upstream = await fetch(`${inner.url}${apiPath}${url.search}`, { method, headers, body });
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
      // The stable key of this stack, and the name GitHub would keep from the manifest.
      Object.assign(json, { pem: appKey, ...(persisted.manifest ? { name: persisted.manifest.name } : {}) });
      text = JSON.stringify(json);
    }
    if (method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(apiPath) && upstream.status === 201 && json && typeof json === 'object') {
      const issued = json as { token: string; expires_at: string };
      const record = inner.tokens.find((token) => token.token === issued.token);
      if (record) persisted.tokens.push({ ...record, expiresAt: issued.expires_at });
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
      const repo = repoOf(match[1]!, match[2]!);
      const pullJson = json as { number: number; head: { ref: string; sha: string } };
      const sha = repo ? listBareBranches(repo.bare).find((branch) => branch.name === pullJson.head.ref)?.sha : undefined;
      if (sha) {
        pullJson.head.sha = sha;
        const record = inner.pulls.find((pull) => pull.repo === match![2] && pull.number === pullJson.number);
        if (record) record.headSha = sha;
        text = JSON.stringify(pullJson);
      }
      save();
    }
    res.writeHead(upstream.status, { ...outHeaders, 'cache-control': 'no-store' });
    res.end(text);
  }

  function setupUrl(): string {
    return persisted.manifest?.setupUrl ?? `${config.appUrl.replace(/\/+$/, '')}/api/integrations/github/setup`;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    if (url.pathname === '/api/v3' || url.pathname.startsWith('/api/v3/')) return proxyApi(req, res, url);

    // --- Harness endpoints ---------------------------------------------------------------------
    if (url.pathname === '/__harness/health') return send(res, 200, { ok: true, appId: config.appId, slug: config.slug });
    if (url.pathname === '/__harness/state') {
      return send(res, 200, {
        appId: config.appId,
        slug: config.slug,
        manifest: persisted.manifest,
        rejectJwt: inner.rejectJwt,
        installations: inner.installations.map((item) => ({ id: item.id, account: item.account.login, suspendedAt: item.suspendedAt ?? null, repos: item.repos })),
        tokensIssued: inner.tokens.length,
        pulls: inner.pulls,
        checkRuns: inner.checkRuns,
        statuses: inner.statuses,
        reviews: inner.reviews,
        requests: inner.requests.length,
      });
    }
    if (url.pathname === '/__harness/requests') {
      const since = Number(url.searchParams.get('since') ?? 0);
      return send(res, 200, {
        total: inner.requests.length,
        requests: inner.requests.slice(Number.isFinite(since) ? since : 0).map((item) => ({ ...item, authorization: item.authorization ? item.authorization.replace(/\s.+$/, ' ***') : null })),
      });
    }
    if (url.pathname === '/__harness/control' && method === 'POST') {
      const input = JSON.parse((await readBody(req)) || '{}') as {
        rejectJwt?: boolean;
        suspend?: { account: string; suspended: boolean };
        checkRuns?: FakeGithub['checkRuns'];
        statuses?: FakeGithub['statuses'];
        reviews?: FakeGithub['reviews'];
        resetRequests?: boolean;
      };
      if (typeof input.rejectJwt === 'boolean') inner.rejectJwt = input.rejectJwt;
      if (input.suspend) {
        const installation = inner.installations.find((item) => item.account.login === input.suspend!.account);
        if (!installation) return send(res, 404, { message: `Compte inconnu : ${input.suspend.account}` });
        installation.suspendedAt = input.suspend.suspended ? new Date().toISOString() : null;
        if (input.suspend.suspended) persisted.suspended[installation.account.login] = installation.suspendedAt!;
        else delete persisted.suspended[installation.account.login];
      }
      if (input.checkRuns) inner.checkRuns.splice(0, inner.checkRuns.length, ...input.checkRuns);
      if (input.statuses) inner.statuses.splice(0, inner.statuses.length, ...input.statuses);
      if (input.reviews) inner.reviews.splice(0, inner.reviews.length, ...input.reviews);
      if (input.resetRequests) inner.requests.length = 0;
      save();
      return send(res, 200, { ok: true });
    }

    // --- github.com pages ----------------------------------------------------------------------
    let match: RegExpExecArray | null;
    if (method === 'POST' && (url.pathname === '/settings/apps/new' || /^\/organizations\/[^/]+\/settings\/apps\/new$/.test(url.pathname))) {
      const form = new URLSearchParams(await readBody(req));
      let manifest: { name?: string; redirect_url?: string; setup_url?: string; url?: string };
      try {
        manifest = JSON.parse(form.get('manifest') ?? '') as typeof manifest;
      } catch {
        return send(res, 422, page('Manifest invalide', '<p>Le champ <code>manifest</code> est absent ou illisible.</p>'));
      }
      if (!manifest.redirect_url) return send(res, 422, page('Manifest invalide', '<p><code>redirect_url</code> manquant.</p>'));
      persisted.manifest = { name: manifest.name ?? 'Nuera Dev', redirectUrl: manifest.redirect_url, setupUrl: manifest.setup_url ?? null, url: manifest.url ?? null };
      save();
      const code = `code-${randomBytes(12).toString('hex')}`;
      inner.conversionCodes.add(code);
      const target = new URL(manifest.redirect_url);
      target.searchParams.set('code', code);
      const state = url.searchParams.get('state');
      if (state) target.searchParams.set('state', state);
      return redirect(res, target.toString());
    }
    if (method === 'GET' && (match = /^\/apps\/([^/]+)\/installations\/new\/permissions$/.exec(url.pathname))) {
      const targetId = Number(url.searchParams.get('target_id'));
      const account = config.accounts.find((item) => item.id === targetId);
      if (!account) return send(res, 404, page('Compte introuvable', '<p>Aucune installation de test pour ce compte.</p>'));
      const target = new URL(setupUrl());
      target.searchParams.set('installation_id', String(account.installationId));
      target.searchParams.set('setup_action', 'install');
      const state = url.searchParams.get('state');
      if (state) target.searchParams.set('state', state);
      return redirect(res, target.toString());
    }
    if (method === 'GET' && (match = /^\/apps\/([^/]+)\/installations\/new$/.exec(url.pathname))) {
      const state = url.searchParams.get('state');
      const targetId = url.searchParams.get('target_id');
      const base = `/apps/${encodeURIComponent(match[1]!)}/installations/new/permissions`;
      const link = (account: FixtureAccount) => `${base}?target_id=${account.id}${state ? `&state=${encodeURIComponent(state)}` : ''}`;
      if (targetId) {
        const account = config.accounts.find((item) => String(item.id) === targetId || item.login === targetId);
        if (account) return redirect(res, link(account));
      }
      const items = config.accounts
        .map((account) => `<li style="margin:8px 0"><a href="${escapeHtml(link(account))}">Installer sur ${escapeHtml(account.login)}</a> <span style="color:#59636e">(${account.type === 'Organization' ? 'organisation' : 'compte personnel'})</span></li>`)
        .join('');
      return send(res, 200, page(`Installer ${persisted.manifest?.name ?? config.slug}`, `<p>Choisissez le compte où installer l'application.</p><ul>${items}</ul>`));
    }
    if (method === 'GET' && /^\/(organizations\/[^/]+\/)?settings\/installations\/\d+$/.test(url.pathname)) {
      return send(res, 200, page('Installation de l\'application', '<p>Les dépôts accessibles sont fixés par la pile de test.</p>'));
    }
    if (method === 'GET' && (match = /^\/apps\/([^/]+)$/.exec(url.pathname))) {
      return send(res, 200, page(persisted.manifest?.name ?? match[1]!, `<p><a href="/apps/${escapeHtml(match[1]!)}/installations/new">Installer</a></p>`));
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
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    apiUrl: `${url}/api/v3`,
    inner,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await inner.close();
    },
  };
}
