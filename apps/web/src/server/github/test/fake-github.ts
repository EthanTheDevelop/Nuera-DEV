/**
 * Local fake of the GitHub REST API (tests only): manifest conversion, app JWT verification
 * (RS256 with the generated key), installations, down-scoped installation tokens, repositories,
 * pull requests, checks and statuses. Every request is recorded for assertions.
 */
import { createPublicKey, createVerify, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRepo {
  id: number;
  name: string;
  owner: string;
  ownerType?: 'Organization' | 'User';
  private?: boolean;
  language?: string | null;
  pushedAt?: string;
  defaultBranch?: string;
}

export interface FakeInstallation {
  id: number;
  account: { login: string; id: number; type: 'Organization' | 'User' };
  permissions: Record<string, string>;
  repositorySelection?: 'all' | 'selected';
  suspendedAt?: string | null;
  repos: string[]; // repository names of this account
}

export interface IssuedToken {
  token: string;
  installationId: number;
  repositories: string[] | null;
  permissions: Record<string, string> | null;
}

export interface RecordedRequest {
  method: string;
  path: string;
  apiVersion: string | null;
  authorization: string | null;
  body: unknown;
}

export interface FakeGithub {
  url: string;
  appId: number;
  slug: string;
  pem: string;
  requests: RecordedRequest[];
  tokens: IssuedToken[];
  installations: FakeInstallation[];
  repos: FakeRepo[];
  pulls: Array<{ owner: string; repo: string; number: number; title: string; head: string; base: string; draft: boolean; headSha: string }>;
  checkRuns: Array<{ name: string; status: string; conclusion: string | null }>;
  statuses: Array<{ context: string; state: string }>;
  reviews: Array<{ user: string; state: string; submittedAt: string }>;
  /** Simulates a revoked private key: every JWT is refused. */
  rejectJwt: boolean;
  /** Fallback PAT accepted by GET /user, with its expiry header. */
  pat: { token: string; login: string; expiration: string | null } | null;
  conversionCodes: Set<string>;
  close(): Promise<void>;
}

const now = () => new Date().toISOString();

function base64urlJson(part: string): unknown {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

export async function startFakeGithub(options: { appId?: number; slug?: string; owner?: { login: string; id: number; type: 'Organization' | 'User' } } = {}): Promise<FakeGithub> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  // GitHub hands out PKCS#1 keys.
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const verifyKey: KeyObject = createPublicKey(publicKey.export({ type: 'spki', format: 'pem' }));
  const appId = options.appId ?? 4242;
  const slug = options.slug ?? 'nuera-dev-test';
  const owner = options.owner ?? { login: 'nuera-studio', id: 1001, type: 'Organization' as const };

  const state: Omit<FakeGithub, 'url' | 'close'> = {
    appId,
    slug,
    pem,
    requests: [],
    tokens: [],
    installations: [],
    repos: [],
    pulls: [],
    checkRuns: [],
    statuses: [],
    reviews: [],
    rejectJwt: false,
    pat: null,
    conversionCodes: new Set(['valid-code']),
  };

  function verifyJwt(header: string | null): boolean {
    if (state.rejectJwt) return false;
    const match = /^bearer\s+(.+)$/i.exec(header ?? '');
    if (!match) return false;
    const [h, p, s] = match[1]!.split('.');
    if (!h || !p || !s) return false;
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${h}.${p}`);
    if (!verifier.verify(verifyKey, Buffer.from(s, 'base64url'))) return false;
    const payload = base64urlJson(p) as { iss?: unknown; exp?: number; iat?: number };
    const nowSec = Math.floor(Date.now() / 1000);
    return String(payload.iss) === String(appId) && typeof payload.exp === 'number' && payload.exp > nowSec && payload.exp - (payload.iat ?? 0) <= 660;
  }

  function tokenOf(header: string | null): IssuedToken | null {
    const match = /^(?:token|bearer)\s+(.+)$/i.exec(header ?? '');
    return match ? (state.tokens.find((item) => item.token === match[1]) ?? null) : null;
  }

  const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': randomBytes(4).toString('hex'), ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  const installationJson = (item: FakeInstallation) => ({
    id: item.id,
    account: item.account,
    repository_selection: item.repositorySelection ?? 'selected',
    permissions: item.permissions,
    suspended_at: item.suspendedAt ?? null,
    suspended_by: item.suspendedAt ? { login: 'someone' } : null,
    html_url: `https://github.com/organizations/${item.account.login}/settings/installations/${item.id}`,
    app_id: appId,
  });

  const repoJson = (repo: FakeRepo) => ({
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, type: repo.ownerType ?? 'Organization' },
    private: repo.private ?? true,
    description: null,
    language: repo.language ?? 'TypeScript',
    pushed_at: repo.pushedAt ?? now(),
    updated_at: repo.pushedAt ?? now(),
    default_branch: repo.defaultBranch ?? 'main',
    archived: false,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
  });

  function hasPermission(token: IssuedToken, installation: FakeInstallation, permission: string, level: 'read' | 'write'): boolean {
    const granted = (token.permissions ?? installation.permissions)[permission];
    if (!granted) return false;
    return level === 'read' ? true : granted === 'write' || granted === 'admin';
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown = undefined;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const authorization = req.headers.authorization ?? null;
    state.requests.push({
      method: req.method ?? 'GET',
      path: url.pathname,
      apiVersion: (req.headers['x-github-api-version'] as string | undefined) ?? null,
      authorization,
      body,
    });
    const path = url.pathname;
    const method = req.method ?? 'GET';
    let match: RegExpExecArray | null;

    // --- Manifest conversion (no auth) -------------------------------------------------------
    if (method === 'POST' && (match = /^\/app-manifests\/([^/]+)\/conversions$/.exec(path))) {
      const code = decodeURIComponent(match[1]!);
      if (!state.conversionCodes.has(code)) return send(res, 404, { message: 'Not Found' });
      state.conversionCodes.delete(code);
      return send(res, 201, {
        id: appId,
        slug,
        node_id: 'A_kgDO',
        client_id: 'Iv23liFakeClientId',
        client_secret: 'fake-client-secret-0123456789abcdef',
        webhook_secret: 'fake-webhook-secret-0123456789',
        pem,
        name: 'Nuera Dev · localhost:3104',
        html_url: `https://github.com/apps/${slug}`,
        owner,
        permissions: { contents: 'write', pull_requests: 'write', metadata: 'read', checks: 'read', statuses: 'read', issues: 'read' },
        events: [],
      });
    }

    // --- App (JWT) -----------------------------------------------------------------------------
    if (path === '/app' || path.startsWith('/app/') || /^\/repos\/[^/]+\/[^/]+\/installation$/.test(path)) {
      if (!verifyJwt(authorization)) return send(res, 401, { message: 'A JSON web token could not be decoded' });
      if (method === 'GET' && path === '/app') return send(res, 200, { id: appId, slug, name: 'Nuera Dev', owner });
      if (method === 'GET' && path === '/app/installations') return send(res, 200, state.installations.map(installationJson));
      if (method === 'GET' && (match = /^\/app\/installations\/(\d+)$/.exec(path))) {
        const item = state.installations.find((inst) => inst.id === Number(match![1]));
        return item ? send(res, 200, installationJson(item)) : send(res, 404, { message: 'Not Found' });
      }
      if (method === 'GET' && (match = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(path))) {
        const item = state.installations.find((inst) => inst.account.login === match![1] && inst.repos.includes(match![2]!));
        return item ? send(res, 200, installationJson(item)) : send(res, 404, { message: 'Not Found' });
      }
      if (method === 'POST' && (match = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path))) {
        const item = state.installations.find((inst) => inst.id === Number(match![1]));
        if (!item) return send(res, 404, { message: 'Not Found' });
        if (item.suspendedAt) return send(res, 403, { message: 'This installation has been suspended' });
        const requested = (body ?? {}) as { repositories?: string[]; permissions?: Record<string, string> };
        if (requested.repositories?.some((name) => !item.repos.includes(name))) {
          return send(res, 422, { message: 'There is at least one repository that does not exist or is not accessible to the parent installation.' });
        }
        for (const [perm, level] of Object.entries(requested.permissions ?? {})) {
          const granted = item.permissions[perm];
          if (!granted || (level === 'write' && granted !== 'write')) {
            return send(res, 422, { message: `The permissions requested are not granted to this installation.` });
          }
        }
        const token = `ghs_${randomBytes(24).toString('hex')}.${randomBytes(8).toString('hex')}`;
        state.tokens.push({ token, installationId: item.id, repositories: requested.repositories ?? null, permissions: requested.permissions ?? null });
        return send(res, 201, {
          token,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          permissions: requested.permissions ?? item.permissions,
          repository_selection: requested.repositories ? 'selected' : (item.repositorySelection ?? 'selected'),
          ...(requested.repositories
            ? { repositories: requested.repositories.map((name) => repoJson(state.repos.find((repo) => repo.name === name && repo.owner === item.account.login)!)) }
            : {}),
        });
      }
      return send(res, 404, { message: 'Not Found' });
    }

    // --- PAT fallback --------------------------------------------------------------------------
    if (method === 'GET' && path === '/user') {
      if (state.pat && authorization === `token ${state.pat.token}`) {
        return send(res, 200, { login: state.pat.login, id: 77, type: 'User' }, state.pat.expiration ? { 'github-authentication-token-expiration': state.pat.expiration } : {});
      }
      return send(res, 401, { message: 'Bad credentials' });
    }

    // --- Installation token routes -----------------------------------------------------------
    const token = tokenOf(authorization);
    if (!token) return send(res, 401, { message: 'Bad credentials' });
    const installation = state.installations.find((inst) => inst.id === token.installationId)!;
    const visible = (repoName: string) => installation.repos.includes(repoName) && (!token.repositories || token.repositories.includes(repoName));

    if (method === 'GET' && path === '/installation/repositories') {
      const list = state.repos.filter((repo) => repo.owner === installation.account.login && visible(repo.name));
      const perPage = Number(url.searchParams.get('per_page') ?? 30);
      const page = Number(url.searchParams.get('page') ?? 1);
      return send(
        res,
        200,
        { total_count: list.length, repository_selection: 'selected', repositories: list.slice((page - 1) * perPage, page * perPage).map(repoJson) },
        { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4990' },
      );
    }
    if ((match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path))) {
      const [, ownerLogin, repoName, rest = ''] = match;
      if (ownerLogin !== installation.account.login || !visible(repoName!)) return send(res, 404, { message: 'Not Found' });
      const repo = state.repos.find((item) => item.owner === ownerLogin && item.name === repoName)!;
      if (method === 'GET' && rest === '') return send(res, 200, repoJson(repo));
      if (method === 'GET' && rest === '/branches') {
        if (!hasPermission(token, installation, 'contents', 'read')) return send(res, 403, { message: 'Resource not accessible by integration' });
        return send(res, 200, [{ name: repo.defaultBranch ?? 'main', commit: { sha: 'a'.repeat(40) }, protected: true }]);
      }
      if (method === 'POST' && rest === '/pulls') {
        if (!hasPermission(token, installation, 'pull_requests', 'write')) return send(res, 403, { message: 'Resource not accessible by integration' });
        const input = body as { title: string; head: string; base: string; draft?: boolean };
        if (state.pulls.some((pull) => pull.repo === repoName && pull.head === input.head)) {
          return send(res, 422, { message: 'Validation Failed', errors: [{ message: `A pull request already exists for ${ownerLogin}:${input.head}.` }] });
        }
        const pull = { owner: ownerLogin!, repo: repoName!, number: 57 + state.pulls.length, title: input.title, head: input.head, base: input.base, draft: Boolean(input.draft), headSha: 'b'.repeat(40) };
        state.pulls.push(pull);
        return send(res, 201, pullJson(pull));
      }
      if (method === 'GET' && (match = /^\/pulls\/(\d+)$/.exec(rest))) {
        const pull = state.pulls.find((item) => item.repo === repoName && item.number === Number(match![1]));
        return pull ? send(res, 200, pullJson(pull)) : send(res, 404, { message: 'Not Found' });
      }
      if (method === 'GET' && /^\/pulls\/\d+\/reviews$/.test(rest)) {
        return send(res, 200, state.reviews.map((review, index) => ({ id: index + 1, user: { login: review.user }, state: review.state, submitted_at: review.submittedAt, commit_id: 'b'.repeat(40) })));
      }
      if (method === 'GET' && /^\/commits\/[^/]+\/check-runs$/.test(rest)) {
        if (!hasPermission(token, installation, 'checks', 'read')) return send(res, 403, { message: 'Resource not accessible by integration' });
        return send(res, 200, {
          total_count: state.checkRuns.length,
          check_runs: state.checkRuns.map((run, index) => ({ id: index + 1, name: run.name, status: run.status, conclusion: run.conclusion, html_url: `https://github.com/run/${index}`, details_url: null })),
        });
      }
      if (method === 'GET' && /^\/commits\/[^/]+\/status$/.test(rest)) {
        const combined = state.statuses.some((item) => item.state === 'failure') ? 'failure' : state.statuses.some((item) => item.state === 'pending') || state.statuses.length === 0 ? 'pending' : 'success';
        return send(res, 200, { state: combined, sha: 'b'.repeat(40), total_count: state.statuses.length, statuses: state.statuses.map((item) => ({ ...item, description: null, target_url: null, updated_at: now() })) });
      }
    }
    return send(res, 404, { message: 'Not Found' });
  }

  function pullJson(pull: FakeGithub['pulls'][number]) {
    return {
      number: pull.number,
      title: pull.title,
      html_url: `https://github.com/${pull.owner}/${pull.repo}/pull/${pull.number}`,
      state: 'open',
      draft: pull.draft,
      merged: false,
      merged_at: null,
      mergeable: null,
      mergeable_state: 'unknown',
      created_at: now(),
      head: { ref: pull.head, sha: pull.headSha },
      base: { ref: pull.base },
      requested_reviewers: [],
      user: { login: `${slug}[bot]` },
    };
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: error instanceof Error ? error.message : 'error' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const fake = state as FakeGithub;
  fake.url = `http://127.0.0.1:${port}`;
  fake.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return fake;
}

/** Adds an installation (and its repositories) to the fake. */
export function addInstallation(fake: FakeGithub, installation: FakeInstallation, repos: Array<Omit<FakeRepo, 'owner'>>): void {
  fake.installations.push(installation);
  for (const repo of repos) fake.repos.push({ ...repo, owner: installation.account.login, ownerType: installation.account.type });
}
