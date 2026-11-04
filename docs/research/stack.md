# Nuera Dev — stack research: pinned versions, current APIs, Windows probes

Research note written 2026-11-04 for the implementation of Nuera Dev (`apps/web` = `@nuera/web`, `apps/runner` = `@nuera/runner`, see root `package.json`). It pins the exact stack, summarises the current APIs and their traps, and records what was actually run on the Windows 11 development machine.

**How to read the tags**

| Tag | Meaning |
|---|---|
| **[V]** | Verified: run on this machine during this session, or read from the npm registry (2026-11-04). |
| **[D]** | Taken from the official documentation or release notes (URL in §13). |
| **[I]** | Inference or recommendation: reasoning, not something that was observed. |

Everything under §10 ("Probe results") was executed in `C:/Users/33767/AppData/Local/Temp/nuera-stack-probe` (outside the repo). Probe scripts stay there; nothing in the repo depends on them.

---

## 0. Decisions on one screen

| Area | Decision | Why (short) |
|---|---|---|
| Runtime | Node **24** (24.21.0 here) — keep `engines: >=22.12`, but develop and deploy on 24 | Next 16 needs ≥ 20.9 [D]; Vitest 5 and the `auth` CLI need ≥ 22.12; jsdom 30 needs ≥ 22.22.2 or ≥ 24.15 [V]. |
| Package manager | pnpm **9.15.4** as pinned in `packageManager` | Works. **But** `onlyBuiltDependencies` in `pnpm-workspace.yaml` is ignored before pnpm 10.5 — see §2.3. |
| Web framework | Next.js **16.4.5** + React **19.3.1**, App Router, Turbopack, `proxy.ts` | 16.4.5 = Active LTS with the 2026-11-03 security fixes [D]. |
| TypeScript | **6.0.3** — not 7.0.2 | `typescript@latest` is now 7.0.2 (Go port, no JS API); `typescript-eslint` (used by `eslint-config-next`) supports `>=4.8.4 <6.1.0` [V][D]. |
| CSS | Tailwind **4.3.4** CSS-first (`@theme inline`, `@custom-variant`) via `@tailwindcss/postcss` | Figma tokens become CSS variables; one `[data-tone=dark]` scope for terminals/sidebar. |
| Auth | Better Auth **1.7.17** + `@better-auth/passkey` **1.7.17**; CLI = package **`auth`** 1.7.17 | `@better-auth/cli` is deprecated on npm [V]; passkey moved to its own package [V][D]. |
| Database | PostgreSQL 18 · Drizzle ORM **0.45.4** + drizzle-kit **0.31.11** · driver **postgres.js 3.4.9** | Drizzle 1.0 is still `rc`; postgres.js 4.0.0 is 6 days old and changes parameter/Date semantics — see §7.4 and §10.4. |
| Local DB | `embedded-postgres` **18.6.0-beta.19** (dev and tests only) | No Docker/WSL/Postgres on this machine; real Postgres on VPS-3. |
| Runner | Fastify **5.12.8** + `@fastify/websocket` **11.3.7**; `@lydell/node-pty` **1.2.0-beta.18**; browser `@xterm/xterm` **6.0.0** | PTY needs a bidirectional socket → WebSocket on a separate Node process; Next route handlers cannot upgrade to WebSocket [I]. |
| Live updates to pages | SSE from Next route handlers (status, notifications), WebSocket only for terminal I/O | SSE works with plain Web streams [D][V-partial]. |
| Git | Spawn the `git` binary directly (`execFile`/`spawn`, args array) — no `simple-git` | Need raw `--progress` streams, porcelain v2 parsing, explicit env (credentials). [I] |
| GitHub | `octokit` **5.0.5** (details in `docs/research/integrations.md`) | |
| Tests | Vitest **5.1.0** (+ Vite 8.3.5), Playwright **1.64.1** | |
| Lint / format | ESLint **10.14.0** + `eslint-config-next` **16.4.5**; Prettier **3.9.10** | ESLint 9 is EOL since 2026-08-06 [D]; peer warnings from 3 React/import plugins are expected [D][V]. |

---

## 1. This machine (facts used by the probes)

| Item | Value | Tag |
|---|---|---|
| OS | Windows 11 Pro 10.0.26200 (French UI: `Microsoft Windows [version 10.0.26200.9711]`) | [V] |
| CPU / RAM | AMD Ryzen 5 5600X (12 threads) · 31.9 GB | [V] |
| Node / npm / pnpm | v24.21.0 (ABI 137, N-API 10) · npm 10.8.3 · pnpm 9.15.4 (latest pnpm is 12.16.1) | [V] |
| git | `git version 2.43.0.windows.1` (`C:\Program Files\Git\mingw64\bin\git.exe`) | [V] |
| Python | 3.12.3 | [V] |
| C++ toolchain | Visual Studio Community 2022 17.9 **with** the VC.Tools.x86.x64 workload — so a node-gyp fallback *could* compile here; "no build tools" was checked through install logs, not by removing VS | [V] |
| Not present | Docker, a WSL distro (only the `wsl.exe` stub), PostgreSQL, tmux, `psql` | [V] |
| Shell quirk | Git Bash (MSYS) rewrites arguments that look like POSIX paths: `cmd.exe /c echo hi` reached node as `cmd.exe C:/ echo hi`. Use `MSYS_NO_PATHCONV=1` or PowerShell for such commands | [V] |
| Install speed | Very slow during this session: `npm install node-pty@1.1.0` took 11 min for 2 packages (0.1 s CPU); a `pnpm add` of embedded-postgres + postgres.js + drizzle-orm + better-auth never finished in 2.5 h (stuck on the two file-heavy packages, `@embedded-postgres/windows-x64` — 40.6 MB tgz, 1502 entries — and `drizzle-orm`). Meanwhile `curl`/`fetch` to the registry answered in 0.07–0.5 s and DNS returned IPv4 only, so the bottleneck is local file writes (probably real-time AV scanning of `%TEMP%`, plus other agents installing in parallel). Expect a long first `pnpm install` on this PC; a Defender exclusion for the repo, the pnpm store and `%LOCALAPPDATA%\pnpm` would likely help | [V] / cause [I] |

---

## 2. Version table (exact pins)

Queried with `npm view <pkg> --json` on 2026-11-04 [V]. "Published" is the registry date of that exact version.

### 2.1 Web app (`@nuera/web`)

| Package | Pin | Published | Notes |
|---|---|---|---|
| `next` | **16.4.5** | 2026-11-03 | `latest`; 16.4.5 = "Active LTS" patch of the November 2026 security release [D]. Peer: React `^18.2 \|\| ^19`, `@playwright/test ^1.51.1` (optional) [V]. |
| `react`, `react-dom` | **19.3.1** | 2026-10-14 | Next 16.4 "ships with React 19.3" [D]. |
| `@types/react`, `@types/react-dom` | **19.3.0** | 2026-09-09 | |
| `typescript` | **6.0.3** | — | `latest` is **7.0.2** (Go port). Pin 6.0.3, see §4.9. |
| `@types/node` | **24.19.2** | — | Match the runtime major (24). `latest` is 26.6.6 (Node 26 types). |
| `tailwindcss`, `@tailwindcss/postcss` | **4.3.4** | 2026-11-02 | `postcss` **8.5.32**. |
| `better-auth` | **1.7.17** | 2026-11-04 | Depends on `@better-auth/drizzle-adapter@1.7.17` itself (re-exported as `better-auth/adapters/drizzle`) [V]. Peer `drizzle-orm ^0.45.2 \|\| >=1.0.0-rc.1 <2`, `next ^14 \|\| ^15 \|\| ^16` [V]. `beta` tag = 1.8.0-beta.5. |
| `@better-auth/passkey` | **1.7.17** | 2026-11-04 | Separate package (server `@better-auth/passkey`, client `@better-auth/passkey/client`) [D]. |
| `auth` (dev) | **1.7.17** | 2026-11-04 | The Better Auth CLI (`bin: auth`, `better-auth`), engines Node ≥ 22.12 [V]. Replaces `@better-auth/cli` (last 1.4.21, flagged deprecated on npm) [V]. |
| `drizzle-orm` | **0.45.4** | 2026-10-08 | `latest`. `rc` tag = 1.0.0-rc.5 (docs already default to `@rc`) [V][D]. |
| `postgres` (postgres.js) | **3.4.9** | — | `latest` is **4.0.0** (2026-10-29, ESM-only rewrite). See §7.4. |
| `zod` | **4.6.7** | 2026-10-12 | Better Auth itself depends on zod `^4.5.4` [V]. |
| `radix-ui` | **1.8.1** | 2026-10-12 | Unified package (`import { Dialog } from "radix-ui"`); individual `@radix-ui/react-dialog` is 1.3.1. |
| `sonner` | **2.0.8** | 2026-08-09 | Toasts (T3 rule: 6 s, pause on hover). |
| `lucide-react` | **1.68.0** | 2026-11-04 | Optional: the design ships its own 25 Nuera OS icons + section-04 icons; prefer one local `currentColor` SVG set [I]. |
| `shiki` | **4.6.0** | 2026-11-02 | Diff / file preview highlighting (server-side). |
| `diff` | **9.0.0** | 2026-04-13 | Ships its own types — **do not** add `@types/diff` (deprecated stub) [V]. |
| `@xterm/xterm` | **6.0.0** | 2025-12-22 | Addons: `@xterm/addon-fit` **0.11.0**, `@xterm/addon-web-links` **0.12.0**, `@xterm/addon-unicode11` **0.9.0**, optional `@xterm/addon-webgl` **0.19.0**, `@xterm/addon-serialize` **0.14.0**. `beta` = 6.1.0-beta.x. |
| `octokit` | **5.0.5** | 2025-10-31 | Or `@octokit/rest` 22.0.1 + `@octokit/auth-app` 8.3.1 (`@octokit/app` 16.1.4). See `integrations.md`. |
| `@tanstack/react-query` | **5.105.3** | 2026-11-02 | Optional (client polling / mutations). RSC + Server Actions + SSE may be enough [I]. |
| `server-only` | 0.0.1 | 2022 | Guard for modules that must never reach the client bundle. |
| `clsx` / `tailwind-merge` / `class-variance-authority` | 2.1.1 / 3.7.0 / 0.7.1 | | Optional UI helpers. |
| `babel-plugin-react-compiler` | 1.0.0 | | Only if `reactCompiler: true` (off by default) [D]. |
| `@next/env` (dev) | **16.4.5** | | Load `.env*` exactly like Next in scripts (`drizzle.config.ts`, seeds) [D]. |
| `eslint` (dev) | **10.14.0** | 2026-10-30 | ESLint 9 line (9.39.5) is EOL since 2026-08-06 [D]. |
| `eslint-config-next` (dev) | **16.4.5** | | Supports ESLint 9 and 10; bundles `typescript-eslint ^8.56` (peer TS `<6.1.0`) [D][V]. |

### 2.2 Runner (`@nuera/runner`) and shared DB code

| Package | Pin | Notes |
|---|---|---|
| `fastify` | **5.12.8** | `next` tag = 6.0.0-alpha.6. |
| `@fastify/websocket` | **11.3.7** | Published 2026-11-04. |
| `@fastify/cors` | 11.4.0 | Only if the runner is called cross-origin (avoid: same-origin via reverse proxy) [I]. |
| `@lydell/node-pty` | **1.2.0-beta.18** | `latest` *and* `beta` = 1.2.0-beta.18; repackages `node-pty@1.2.0-beta.18` with per-platform optional deps (linux-x64/arm64, darwin, win32) and **never** calls node-gyp [V]. |
| `node-pty` (Microsoft) | not used | `latest` 1.1.0 has prebuilds for win32/darwin only → compiles with node-gyp on Linux; 1.2.0-beta.18 adds linux prebuilds [V]. |
| `pino` / `pino-pretty` (dev) | **10.4.0** / **13.2.0** | Fastify's logger. |
| `tsx` (dev) | **4.23.15** | Dev runner (`tsx watch`). |
| `embedded-postgres` (dev) | **18.6.0-beta.19** | Every release of this package carries a `-beta.N` suffix; `latest` points to it [V]. Pulls `@embedded-postgres/<platform>` (windows-x64: 109 MB unpacked) + `pg@^8.23.1` [V]. |
| `drizzle-kit` (dev) | **0.31.11** | |
| `pidusage` | 4.1.0 | Optional: per-process CPU/RAM of `claude` processes. Server totals need no dependency (`node:os` + `fs.statfs`, verified on Windows) [V]. `systeminformation` 5.33.19 is the heavier alternative. |

Considered and **not** pinned: `hono` 4.13.16 + `@hono/node-server` 2.1.6 (`@hono/node-ws@1.3.1` still peers `@hono/node-server ^1.19.11`, i.e. not the current 2.x) [V]; `ws` 8.22.1 directly (Fastify plugin wraps it); `simple-git` 4.0.2 [I]; `dotenv` 18.0.9 (Node 24 has `--env-file-if-exists` / `process.loadEnvFile()`; Next has `@next/env`) [I]; `concurrently` 10.0.6 (root scripts already use `pnpm --parallel`); `nanoid` 6.0.2 (`crypto.randomUUID()` suffices; engines Node `^22 || ^24 || >=26`) [V]; `cron-parser` 5.10.3 (no scheduling in scope).

### 2.3 Tooling (root)

| Package | Pin | Notes |
|---|---|---|
| `prettier` | **3.9.10** | `prettier-plugin-tailwindcss` **0.8.1** (Node ≥ 20.19). |
| `vitest` | **5.1.0** | engines Node `^22.12 \|\| ^24 \|\| >=26`; peer `vite ^6.4 \|\| ^7 \|\| ^8` → `vite` **8.3.5**; `@vitest/coverage-v8` 5.1.0. |
| `@vitejs/plugin-react` | 6.2.1 | Only for component tests (peer `vite ^8`). |
| `jsdom` | 30.1.3 | engines Node `^22.22.2 \|\| ^24.15.0 \|\| >=26` — fine on 24.21. |
| `@testing-library/react` / `dom` | 16.3.3 / 10.4.2 | |
| `@playwright/test` | **1.64.1** | |
| `eslint-config-prettier` | 10.1.8 | `eslint-config-prettier/flat` [D]. |

**pnpm build-script approvals (important).** pnpm 9 runs every dependency's lifecycle scripts by default; pnpm 10.0 stopped doing so and requires an allow-list [D]; settings in `pnpm-workspace.yaml` other than `packages` are only read **since pnpm 10.5.0** [D]; pnpm 11 replaced `onlyBuiltDependencies` with an `allowBuilds` map [D]. Consequences for this repo [I]:

- With the pinned pnpm 9.15.4 the current `onlyBuiltDependencies` block in `pnpm-workspace.yaml` is **inert** (scripts run anyway). Harmless today, misleading tomorrow.
- The list names the wrong packages for embedded-postgres: the `postinstall` lives in the **platform** packages (`@embedded-postgres/windows-x64`, `@embedded-postgres/linux-x64`: `node scripts/hydrate-symlinks.js`), not in `embedded-postgres` (which has no install script) [V]. `@lydell/node-pty` and its platform packages have **no** install script at all [V] — listing it is unnecessary.
- Suggested `pnpm-workspace.yaml` (pnpm ≥ 10.5 honours it; pnpm 9 ignores it):

  ```yaml
  packages:
    - apps/*
    - packages/*
  onlyBuiltDependencies:        # pnpm 10.x
    - "@embedded-postgres/linux-x64"
    - "@embedded-postgres/windows-x64"
    - esbuild
    - sharp
  ```
  When moving to pnpm ≥ 11, translate it to `allowBuilds: { "@embedded-postgres/linux-x64": true, ... }` [D].
- Add `save-exact=true` to the repo `.npmrc` so `pnpm add x@1.2.3` writes `1.2.3`, not `^1.2.3` [I].
- ESLint 10: `eslint-plugin-react` 7.37.5, `eslint-plugin-import` 2.32.0 and `eslint-plugin-jsx-a11y` 6.10.2 do not list ESLint 10 in their peers yet [V] — Next documents this ("peer dependency warnings, or fail when strict peer dependencies are enabled") [D]. pnpm 9 defaults to non-strict peers, so they are warnings; silence with `pnpm.peerDependencyRules.allowedVersions: { "eslint": "10" }` in the root `package.json` [I].

---

## 3. Install commands

Assumed layout [I]: `apps/web` (Next), `apps/runner` (Fastify + PTY + git + process supervision), `packages/db` (`@nuera/db`: Drizzle schema, client, migrations, embedded-Postgres bootstrap) consumed by both apps. Run from the repo root:

```bash
# Web app
pnpm --filter @nuera/web add next@16.4.5 react@19.3.1 react-dom@19.3.1 \
  better-auth@1.7.17 @better-auth/passkey@1.7.17 zod@4.6.7 \
  radix-ui@1.8.1 sonner@2.0.8 shiki@4.6.0 diff@9.0.0 octokit@5.0.5 server-only@0.0.1 \
  @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0 @xterm/addon-web-links@0.12.0 @xterm/addon-unicode11@0.9.0
pnpm --filter @nuera/web add -D typescript@6.0.3 @types/node@24.19.2 @types/react@19.3.0 @types/react-dom@19.3.0 \
  tailwindcss@4.3.4 @tailwindcss/postcss@4.3.4 postcss@8.5.32 \
  eslint@10.14.0 eslint-config-next@16.4.5 auth@1.7.17 @next/env@16.4.5

# Shared DB package
pnpm --filter @nuera/db add drizzle-orm@0.45.4 postgres@3.4.9
pnpm --filter @nuera/db add -D drizzle-kit@0.31.11 embedded-postgres@18.6.0-beta.19 tsx@4.23.15 @next/env@16.4.5 typescript@6.0.3 @types/node@24.19.2

# Runner
pnpm --filter @nuera/runner add fastify@5.12.8 @fastify/websocket@11.3.7 @lydell/node-pty@1.2.0-beta.18 pino@10.4.0 zod@4.6.7
pnpm --filter @nuera/runner add -D tsx@4.23.15 typescript@6.0.3 @types/node@24.19.2 pino-pretty@13.2.0

# Root tooling
pnpm add -Dw prettier@3.9.10 prettier-plugin-tailwindcss@0.8.1 vitest@5.1.0 vite@8.3.5 @vitest/coverage-v8@5.1.0 @playwright/test@1.64.1 eslint-config-prettier@10.1.8
pnpm exec playwright install chromium
```

Workspace packages reference each other with `"@nuera/db": "workspace:*"`.

---

## 4. Next.js 16.4 — what matters for Nuera Dev

### 4.1 `proxy.ts` replaces `middleware.ts` [D]

- File `proxy.ts` at the project root (or `src/`), export `proxy` (named) or a default function; optional `export const config = { matcher }`. `middleware.ts` still works but is deprecated (kept for Edge use cases). Codemod: `npx @next/codemod@canary middleware-to-proxy .`
- **Proxy runs on the Node.js runtime by default and `runtime` cannot be set** in a proxy file (throws).
- Without a matcher it runs on every request, including `_next/static`, `_next/image` and `public/` — always add a negative matcher.
- Server Functions are POSTs to the route that uses them; a matcher that skips a path also skips its actions. The docs: "Always verify authentication and authorization inside each Server Function rather than relying on Proxy alone."
- For Nuera Dev [I]: `proxy.ts` does an **optimistic** cookie check (`getSessionCookie` from `better-auth/cookies`) and redirects to `/connexion`; every page, route handler and server action still calls `auth.api.getSession()` (§6.4).

### 4.2 Request APIs are async-only [D]

Sync access was removed in 16: `await params`, `await searchParams`, `await cookies()`, `await headers()`, `await draftMode()`. Generated global helpers `PageProps<'/projets/[projectId]'>`, `LayoutProps<…>`, `RouteContext<…>` (created by `next dev`, `next build` or `next typegen`).

### 4.3 Route handlers, streaming and SSE [D]

- Route handlers are **not cached by default**; only `GET` can opt into caching (`export const dynamic = 'force-static'`).
- With `cacheComponents: true`, a `GET` handler is **prerendered at build time** unless it touches runtime data (request properties, `headers()`, `cookies()`, `connection()`, DB/network, non-deterministic calls). An SSE handler always reads the request, but add `await connection()` anyway so the intent is explicit.
- Streaming = return `new Response(ReadableStream)`. Segment config allowed in route files: `dynamic`, `revalidate`, `runtime`, `maxDuration`…

SSE handler (pattern verified with Node 24's own `Request`/`Response`/`ReadableStream`, see §10.6; not run inside a Next server in this session):

```ts
// apps/web/app/api/evenements/route.ts — Server-Sent Events for status tiles, sessions, notifications
import { connection } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { subscribe } from '@/lib/events'; // returns () => void (unsubscribe)

export const runtime = 'nodejs';

export async function GET(request: Request) {
  await connection(); // never prerender (matters only with cacheComponents)
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response('Unauthorized', { status: 401 });

  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown, id?: string) =>
        controller.enqueue(encoder.encode(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      controller.enqueue(encoder.encode('retry: 3000\n\n')); // client reconnect delay
      const unsubscribe = subscribe((e) => send(e.type, e.payload, e.id));
      const ping = setInterval(() => controller.enqueue(encoder.encode(': ping\n\n')), 15_000); // keep proxies from timing out
      cleanup = () => { clearInterval(ping); unsubscribe(); };
      request.signal.addEventListener('abort', () => { cleanup(); try { controller.close(); } catch {} }, { once: true });
    },
    cancel() { cleanup(); },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform', // no-transform: compression middlewares skip the response
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx-style proxies: do not buffer
    },
  });
}
```

Client: `new EventSource('/api/evenements')` (cookies are sent same-origin). On reconnect the browser sends `Last-Event-ID` — read it from `request.headers` to replay missed events [I].

Pitfalls: `next start` gzips responses by default (`compress`, gzip) [D]. The `compression` middleware "will never compress responses that include a `Cache-Control` header with the `no-transform` directive" and "does not work out of the box with server-sent events" [D]; that Next's built-in gzip is this middleware was not checked in this session [I] — `no-transform` is cheap insurance either way, and `compress: false` + compression at the reverse proxy is the fallback. Behind Traefik/Caddy/nginx (Coolify), disable response buffering for this path. One `EventSource` per tab; browsers allow only 6 HTTP/1.1 connections per origin, so serve the app over HTTP/2 [I]. Clean up in **both** `request.signal`'s `abort` and the stream's `cancel()`: which one fires on a client disconnect depends on the server wiring (§10.6).

### 4.4 Server Actions [D]

- CSRF: Next compares `Origin` with `x-forwarded-host`/`host`; behind a reverse proxy that forwards the public host nothing is needed, otherwise list hosts in `experimental.serverActions.allowedOrigins` (still under `experimental` in 16.4). A request with **no** `Origin` header is let through with a warning.
- `experimental.serverActions.bodySizeLimit` default **1 MB**.
- New cache APIs (Server Actions only): `updateTag(tag)` (read-your-writes), `refresh()` (re-render uncached data). `revalidateTag(tag, profile)` now wants a `cacheLife` profile as second argument.
- Re-check the session inside every action (§4.1).

### 4.5 `output: 'standalone'` [D]

- Produces `.next/standalone/server.js` (+ traced `node_modules`); copy `public/` and `.next/static/` yourself: `cp -r public .next/standalone/ && cp -r .next/static .next/standalone/.next/`. `PORT` / `HOSTNAME` env vars control the listener.
- Monorepo: set `outputFileTracingRoot: path.join(__dirname, '../../')` so `packages/*` code is traced.
- **Windows**: creating directory symlinks may need admin rights or Developer Mode; when standalone falls back to junctions the output is not relocatable. With pnpm's symlinked `node_modules` this hits standalone builds on Windows → build production images on Linux (VPS / CI) [D][I].
- Native modules: keep server-only native deps out of the web bundle — `@lydell/node-pty` belongs to the runner, not to `apps/web` [I]. If one must be imported by Next, list it in `serverExternalPackages`.

### 4.6 `instrumentation.ts` [D]

`register()` runs **once per server instance** and must finish before requests are served; guard Node-only imports with `process.env.NEXT_RUNTIME === 'nodejs'`. Useful for: running Drizzle migrations at boot, starting the event bus subscriber. `onRequestError(err, request, context)` reports server errors (`context.routeType`: `render | route | action | proxy`).

```ts
// apps/web/instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { runMigrations } = await import('@nuera/db/migrate');
    await runMigrations(); // idempotent; uses its own max:1 connection
  }
}
```

### 4.7 Environment variables [D]

- Load order: `process.env` → `.env.$(NODE_ENV).local` → `.env.local` (skipped when `NODE_ENV=test`) → `.env.$(NODE_ENV)` → `.env`. `$VAR` expansion is supported.
- `NEXT_PUBLIC_*` values are **inlined at build time**; everything else is server-only and read at request time during dynamic rendering.
- With a `src/` folder, `.env*` stay at the app root. In the monorepo they live in `apps/web/` (Next loads from the app directory) [I].
- Scripts outside Next (`drizzle.config.ts`, seeds, tests): `import { loadEnvConfig } from '@next/env'; loadEnvConfig(process.cwd())`.
- `experimental.typedEnv: true` generates env-var types in `.next/types` (optional).
- `serverRuntimeConfig` / `publicRuntimeConfig` were removed in 16.

### 4.8 Turbopack, typed routes, lint, other 16.x changes [D]

- Turbopack is the default for `next dev` and `next build`; `--webpack` opts out. Filesystem cache for dev is on by default since 16.1; 16.4 adds `experimental.turbopackGc` etc. (all optional).
- `typedRoutes: true` is **top-level** (stable) and types `<Link href>` plus `router.push/replace/prefetch`; non-literal strings need `as Route`. Include `.next/types/**/*.ts` in `tsconfig.json` `include`.
- `next lint` is removed — run `eslint .` with a flat config (`eslint-config-next/core-web-vitals` + `eslint-config-next/typescript`).
- Parallel-route slots **require** `default.tsx` (builds fail otherwise) — relevant for the `@modal` / `@drawer` slots of the proposed route map.
- `create-next-app` 16.4 enables **Cache Components** (`cacheComponents: true` + `partialPrefetching: true`) by default and recommends it. Four of the seven 2026-11-03 advisories are Cache Components bugs. Nuera Dev is fully request-time and single-user, so start with Cache Components **off** and add it later if a page benefits [I].
- `experimental.agentUpgrade` defaults to `'security'` (upgrade reminders in `next dev`/`next build`).
- Note for 16.4 on Node ≥ 24.13.1: `turbopackPluginRuntimeStrategy: 'workerThreads'` silently falls back to child processes (Node bug) — irrelevant unless you enable it.
- `scroll-behavior: smooth` is no longer automatic (`data-scroll-behavior="smooth"` on `<html>` to opt in).

### 4.9 TypeScript 6 vs 7 [V][D]

- `npm view typescript` → `latest=7.0.2`, `beta=7.1.0-beta`. TypeScript 7 is the native (Go) compiler and ships **no JavaScript compiler API**.
- Next 16.4 can type-check with TS 7 (it shells out to the project-local `tsc` by default; `experimental.useTypeScriptCli: false` switches back to the JS API) [D]. But `typescript-eslint@8.72.1` (inside `eslint-config-next`) declares `typescript >=4.8.4 <6.1.0` [V][D], and editor/tooling plugins (Next TS plugin, Better Auth CLI via jiti/babel, drizzle-kit) expect the JS API.
- Decision: **`typescript@6.0.3` everywhere**. Revisit when typescript-eslint supports 7 (TS 7.1 is expected to bring an API) [I].

---

## 5. Tailwind CSS 4.3 (CSS-first) [D]

- Install: `tailwindcss @tailwindcss/postcss postcss`; `postcss.config.mjs` = `{ plugins: { "@tailwindcss/postcss": {} } }`; CSS entry starts with `@import "tailwindcss";`. No `tailwind.config.js`.
- `@theme { --color-x: … }` creates utilities (`bg-x`, `text-x`…). Namespaces: `--color-*`, `--font-*`, `--text-*`, `--font-weight-*`, `--tracking-*`, `--leading-*`, `--breakpoint-*`, `--container-*`, `--spacing-*`, `--radius-*`, `--shadow-*`, `--ease-*`, `--animate-*`… `--color-*: initial;` drops the default palette; `--*: initial` drops the whole default theme.
- **`@theme inline` is mandatory when a theme variable points at another variable** that changes per scope. Without `inline`, `bg-bg` compiles to `var(--color-bg)`, which is resolved once on `:root` and does not follow a `[data-tone=dark]` override. With `inline` the utility emits `var(--bg)` directly.
- `@custom-variant dark (&:where(.dark, .dark *));` or the `[data-theme=dark]` form replaces the default `prefers-color-scheme` dark variant.
- Fonts: `next/font/google` (`Outfit`, `JetBrains_Mono`) expose CSS variables; map them in `@theme inline { --font-sans: var(--font-outfit); }`.

`apps/web/app/globals.css` skeleton (token values from `docs/figma/design-system.md` §2 and `overview.md` §1.4; compiled with the `tailwindcss@4.3.4` engine in §10.7):

```css
@import "tailwindcss";

/* 1. Brand primitives and role tokens (Figma collection "Color", Light = default) */
:root {
  --ink: #233353;
  --paper: #ffffff;
  --near-black: #141830;
  --accent-on-light: #4368b1;
  --accent-on-dark: #a6b9dd;
  --accent-pale: #dee5f2;
  --muted-on-light: #645e78;
  --muted-on-dark: rgb(255 255 255 / 0.62);
  --border-on-light: #d9dade;
  --border-on-dark: rgb(255 255 255 / 0.14);
  --hairline-on-dark: rgb(255 255 255 / 0.1);
  --surface-raised-dark: rgb(255 255 255 / 0.05);

  --bg: var(--paper);
  --text: var(--ink);
  --accent: var(--accent-on-light);
  --muted: var(--muted-on-light);
  --border: var(--border-on-light);
  --surface: var(--paper);
  --surface-raised: var(--paper);

  /* "App · statuts" */
  --success: #2f6f4f;
  --success-pale: #e4f1ea;
  --success-on-dark: #5fc48b;
  --warn: #8a6516;
  --warn-pale: #fbf1dc;
  --warn-on-dark: #f2c14e;
  --danger: #b4451f;
  --danger-pale: #f8e6de;
  --running: #e0a10f; /* Figma "en-cours" */
}

/* 2. Dark scope: terminal blocks, sidebar content, dark toast (Figma "Dark" mode of Color) */
[data-tone="dark"] {
  --bg: var(--ink);
  --text: var(--paper);
  --accent: var(--accent-on-dark);
  --muted: var(--muted-on-dark);
  --border: var(--border-on-dark);
  --surface-raised: var(--surface-raised-dark);
}

/* 3. Variants: the app has no global dark mode; the dark scope is a variant for exceptions */
@custom-variant tone-dark (&:where([data-tone="dark"], [data-tone="dark"] *));

/* 4. Map tokens to utilities. `inline` so utilities follow the [data-tone] scope */
@theme inline {
  --color-*: initial;
  --color-bg: var(--bg);
  --color-text: var(--text);
  --color-accent: var(--accent);
  --color-accent-pale: var(--accent-pale);
  --color-muted: var(--muted);
  --color-border: var(--border);
  --color-surface: var(--surface);
  --color-surface-raised: var(--surface-raised);
  --color-near-black: var(--near-black);
  --color-paper: var(--paper);
  --color-ink: var(--ink);
  --color-success: var(--success);
  --color-success-pale: var(--success-pale);
  --color-success-on-dark: var(--success-on-dark);
  --color-warn: var(--warn);
  --color-warn-pale: var(--warn-pale);
  --color-danger: var(--danger);
  --color-danger-pale: var(--danger-pale);
  --color-running: var(--running);

  --font-sans: var(--font-outfit), ui-sans-serif, system-ui, sans-serif;
  --font-mono: var(--font-jetbrains-mono), ui-monospace, monospace;
}

/* 5. Static scales (plain values) */
@theme {
  --spacing: 4px; /* p-1 = 4px … p-20 = 80px, matches --space-N = N × 4 */
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 20px;
  --radius-xl: 28px;
  --text-app-28: 28px;
  --text-app-22: 22px;
  --text-app-18: 18px;
  --text-app-16: 16px;
  --text-app-14: 14px;
  --text-app-13: 13px;
  --text-app-12: 12px;
  --text-app-11: 11px;
  --breakpoint-md: 48rem; /* phone layout below; confirm against design-system.md §4.3 */
}

@layer base {
  html { color-scheme: light; }
  body { background: var(--bg); color: var(--text); font-family: var(--font-sans); }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  }
}
```

Usage: `<div data-tone="dark" className="bg-bg text-text border-border">` gives the terminal colours with the same class names as a light card; `tone-dark:` is only needed for real exceptions.

---

## 6. Better Auth 1.7 (single owner, password + TOTP + passkeys)

### 6.1 Facts [D][V]

- Packages: `better-auth` (core, adapters re-exported), `@better-auth/passkey` (plugin), CLI `auth` (`npx auth@latest generate|migrate`). `@better-auth/cli` = old CLI, deprecated.
- Env: `BETTER_AUTH_SECRET` (≥ 32 chars; production throws if missing — the dev fallback is a fixed public string) and `BETTER_AUTH_URL` (or `baseURL`).
- Drizzle: `import { drizzleAdapter } from "better-auth/adapters/drizzle"`, `provider: "pg"`; pass `schema` (or rely on the schema given to `drizzle()`); `usePlural`, `schemaName` options; Relations v2 variant at `@better-auth/drizzle-adapter/relations-v2`; `advanced.database.joins: true` (since 1.4) needs Drizzle relations.
- `auth migrate` only works with the built-in Kysely adapter; with Drizzle: `auth generate` → `drizzle-kit generate` → `drizzle-kit migrate`.
- Next: `toNextJsHandler(auth)` from `better-auth/next-js` in `app/api/auth/[...all]/route.ts`; `nextCookies()` plugin (same import) **must be the last plugin** so cookies set from Server Actions reach the browser. RSCs cannot set cookies (cookie cache refresh only after an action/route).
- Defaults: `emailAndPassword.enabled=false`, `disableSignUp=false`, `minPasswordLength=8`, `maxPasswordLength=128`, password hash = **scrypt**; session `expiresIn` 7 days, `updateAge` 1 day, `freshAge` 1 day; `cookieCache` off; `telemetry.enabled=false`; `basePath=/api/auth`; `trustedOrigins` = the base URL only.
- Rate limit: on in production, off in development; window 10 s / max 100; special rules `/sign-in/email` 3 per 10 s and `/two-factor/*` 3 per 10 s; storage `memory` (default), `database` (table `rateLimit`), `secondary-storage`. **Calls through `auth.api` on the server are not rate-limited.** IP from `X-Forwarded-For` by default (spoofable) → set `advanced.ipAddress.ipAddressHeaders` to the single header the reverse proxy overwrites.
- Cookies: `Secure` in production by default; `advanced.useSecureCookies: true` forces it everywhere; forwarded host/proto headers are ignored unless `advanced.trustedProxyHeaders: true`.
- 2FA (`twoFactor` from `better-auth/plugins`, client `twoFactorClient` from `better-auth/client/plugins`): issuer defaults to `appName`; adds `user.twoFactorEnabled` + table `twoFactor`; `enable({ password })` returns TOTP URI + backup codes and 2FA is active only after the first `verifyTotp` unless `skipVerificationOnEnable`; `/sign-in/email` then answers `twoFactorRedirect: true`; `trustDevice` = 30 days; passkey sign-in is **not** gated by 2FA.
- Passkey (`passkey` from `@better-auth/passkey`, client `passkeyClient` from `@better-auth/passkey/client`): options `rpID`, `rpName`, `origin` (defaults to baseURL origin + trusted origins), `authenticatorSelection`; table `passkey`; `"localhost"` is fine as rpID in dev; conditional UI needs `autocomplete="username webauthn"` + `signIn.passkey({ autoFill: true })`.
- Sessions: client `listSessions()`, `revokeSession({ token })`, `revokeOtherSessions()`, `revokeSessions()`; server `auth.api.*` equivalents need `headers`; `changePassword({ …, revokeOtherSessions: true })`.

### 6.2 Server config (`apps/web/lib/auth.ts`) — executed in §10.5 with the probe database

```ts
import 'server-only';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { twoFactor } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { count } from 'drizzle-orm';
import { db, schema } from '@nuera/db';

const appUrl = process.env.BETTER_AUTH_URL!; // e.g. https://dev.nuera.studio

export const auth = betterAuth({
  appName: 'Nuera Dev',
  baseURL: appUrl,
  secret: process.env.BETTER_AUTH_SECRET, // openssl rand -base64 32
  trustedOrigins: [appUrl],
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: process.env.NUERA_ALLOW_SIGNUP !== '1', // "Un seul propriétaire"
    minPasswordLength: 12,
  },
  session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
  databaseHooks: {
    user: {
      create: {
        // Belt and braces for single ownership: refuse a second user whatever the path
        before: async (user) => {
          const [{ n }] = await db.select({ n: count() }).from(schema.user);
          if (n > 0) throw new APIError('FORBIDDEN', { message: 'Nuera Dev a déjà un propriétaire.' });
          return { data: user };
        },
      },
    },
  },
  rateLimit: { enabled: true, window: 60, max: 60, storage: 'database' }, // survives restarts
  advanced: {
    useSecureCookies: process.env.NODE_ENV === 'production',
    ipAddress: { ipAddressHeaders: ['x-real-ip'] }, // the header the reverse proxy overwrites
  },
  plugins: [
    twoFactor({ issuer: 'Nuera Dev' }),
    passkey({ rpID: new URL(appUrl).hostname, rpName: 'Nuera Dev', origin: appUrl }),
    nextCookies(), // must stay last
  ],
});

export type Session = typeof auth.$Infer.Session;
```

### 6.3 Client (`apps/web/lib/auth-client.ts`)

```ts
'use client';
import { createAuthClient } from 'better-auth/react';
import { twoFactorClient } from 'better-auth/client/plugins';
import { passkeyClient } from '@better-auth/passkey/client';

export const authClient = createAuthClient({
  plugins: [
    twoFactorClient({ onTwoFactorRedirect: () => { window.location.href = '/connexion/deux-facteurs'; } }),
    passkeyClient(),
  ],
});
// authClient.signIn.email({ email, password }) · authClient.twoFactor.verifyTotp({ code, trustDevice: true })
// authClient.passkey.addPasskey({ name }) · authClient.signIn.passkey({ autoFill: true })
// authClient.listSessions() · authClient.revokeSession({ token }) · authClient.revokeOtherSessions()
```

### 6.4 Route, session helper, proxy

```ts
// app/api/auth/[...all]/route.ts
import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/lib/auth';
export const { GET, POST } = toNextJsHandler(auth);

// lib/session.ts — call in every page / action / route handler
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
export async function requireSession() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/connexion');
  return session;
}

// proxy.ts — optimistic only (cookie presence), real check stays in requireSession()
import { NextResponse, type NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';
export function proxy(request: NextRequest) {
  if (!getSessionCookie(request)) return NextResponse.redirect(new URL('/connexion', request.url));
  return NextResponse.next();
}
export const config = { matcher: ['/((?!api/auth|connexion|_next/static|_next/image|favicon.ico|manifest.webmanifest).*)'] };
```

### 6.5 Schema generation and the owner account

```bash
# generate the Drizzle tables for user/session/account/verification + twoFactor + passkey (+ rateLimit when storage:'database')
pnpm --filter @nuera/web exec auth generate --config lib/auth.ts --output ../../packages/db/src/auth-schema.ts --yes
pnpm --filter @nuera/db exec drizzle-kit generate
pnpm --filter @nuera/db exec drizzle-kit migrate   # or the programmatic migrate() at boot (§7.3)
```

CLI options [D]: `--config` (default search: `auth.ts` in the root, `lib/`, `utils/`, or the same under `src/`), `--output` (Drizzle default: `schema.ts` at the project root), `--yes`/`-y`, `-c/--cwd`, `--adapter prisma|drizzle|kysely` + `--dialect` (required with `--adapter drizzle`). Drizzle/Prisma generation needs no live database, but the CLI **loads the config** — so on the very first run the config must not import the not-yet-generated schema: generate once with a schema-less adapter, then commit `auth-schema.ts` [I]. The CLI itself could not be installed in this session (§10.5). Owner creation: a one-off script that runs with `NUERA_ALLOW_SIGNUP=1` and calls `auth.api.signUpEmail({ body: { name, email, password } })`; the `databaseHooks.user.create.before` guard refuses any second user even if the flag is left on [I; behaviour of `disableSignUp` on server calls measured in §10.5].

---

## 7. Drizzle ORM 0.45 + drizzle-kit 0.31 (PostgreSQL)

### 7.1 Config [D]

```ts
// packages/db/drizzle.config.ts
import { loadEnvConfig } from '@next/env';
import { defineConfig } from 'drizzle-kit';

loadEnvConfig(new URL('../../apps/web', import.meta.url).pathname); // same .env files as Next

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/schema.ts', './src/auth-schema.ts'],
  out: './migrations',
  dbCredentials: { url: process.env.DATABASE_URL! },
  migrations: { table: '__drizzle_migrations', schema: 'drizzle' }, // the defaults, written out
  strict: true,
  verbose: true,
});
```

Commands: `drizzle-kit generate` (SQL from schema diff), `drizzle-kit migrate` (apply), `push` (dev only, no files), `pull`, `export`, `studio`. Migration log table `drizzle.__drizzle_migrations` by default [D].

On Windows, `new URL(...).pathname` yields `/P:/...`; use `fileURLToPath` (`node:url`) instead — see §10.4 [V].

### 7.2 Client

```ts
// packages/db/src/client.ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema-all'; // app tables + auth tables

const globalForDb = globalThis as unknown as { pg?: ReturnType<typeof postgres> };
// One pool per process; survive Next dev HMR re-evaluating this module
export const client = globalForDb.pg ?? postgres(process.env.DATABASE_URL!, { max: 10, idle_timeout: 20, onnotice: () => {} });
if (process.env.NODE_ENV !== 'production') globalForDb.pg = client;
export const db = drizzle({ client, schema, casing: 'snake_case' });
export { schema };
```

Other documented forms: `drizzle(process.env.DATABASE_URL)` and `drizzle({ connection: { url, ssl } })` [D]. postgres.js uses prepared statements by default; with a transaction-mode pooler (PgBouncer) pass `prepare: false` [D].

### 7.3 Programmatic migrations

```ts
// packages/db/src/migrate.ts
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';

export async function runMigrations(url = process.env.DATABASE_URL!) {
  const sql = postgres(url, { max: 1, onnotice: () => {} }); // single connection for DDL
  try {
    await migrate(drizzle({ client: sql }), { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });
  } finally {
    await sql.end();
  }
}
```

Run it from exactly one process (the runner at boot, or a deploy step) — two processes migrating concurrently is not something to rely on [I].

### 7.4 postgres.js 3.4.9 vs 4.0.0

4.0.0 (2026-10-29) [D]: ESM-only (CommonJS needs `require('postgres').default`), the **server now decides parameter types** (`infer: false` default; `infer: true` restores v3), a `Date` compared with/written to `timestamp`/`date` is taken as UTC outside UTC, `sql.array()` removed (`${ids}::int[]`), a server-side rollback now rejects `sql.begin`, released/finished connections reject queries. Drizzle 0.45.4 was written against v3 (its peer range `postgres >=3` accepts v4 only by semver). Measured result: §10.4. **Pin 3.4.9 now; move to 4.x together with Drizzle 1.0** [I].

### 7.5 Drizzle 1.0 (rc) [D]

Docs and the upgrade guide already install `drizzle-orm@rc` / `drizzle-kit@rc`. Breaking: Relational Queries v2 (relations defined with `defineRelations`), migration folder format (no `journal.json`, one folder per migration, `drizzle-kit up` converts), `drizzle-kit drop` removed, DDL snapshots + commutativity checks. Better Auth already supports it (`@better-auth/drizzle-adapter/relations-v2`). Stay on 0.45.4 until 1.0 is `latest` [I].

---

## 8. embedded-postgres (local dev and tests only)

### 8.1 Facts [D][V]

- Options: `databaseDir` (default `./data/db`), `port` (5432), `user` (`postgres`), `password` (`password`), `authMethod` (`scram-sha-256` | `password` | `md5`, default **`password`**), `persistent` (true), `initdbFlags`, `postgresFlags`, `createPostgresUser` (root/Docker only — "WILL irreversibly modify your host system"), `autoRehydrateSymlinks`, `onLog`, `onError`. Methods: `initialise()`, `start()`, `stop()`, `createDatabase(name)`, `dropDatabase(name)`, `getPgClient()` (node-postgres client).
- Windows x64 supported for PostgreSQL 14–18. Versions follow zonky's embedded-postgres-binaries; only versions published on npm can be installed.
- PostgreSQL refuses to run as root (Linux/Docker) → `createPostgresUser`.
- The platform package's `postinstall` (`hydrate-symlinks.js`) recreates symlinks npm tarballs cannot carry; if install scripts are blocked (pnpm ≥ 10 without approval) it fails at runtime unless `autoRehydrateSymlinks: true`.

### 8.2 Bootstrap script (`packages/db/scripts/dev-db.ts`) — the probe in §10.3 ran the same calls

```ts
// Starts a persistent local Postgres in <repo>/.data/pg (git-ignored) and keeps it running until Ctrl+C.
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import postgres from 'postgres';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const databaseDir = path.join(root, '.data', 'pg');
const port = Number(process.env.NUERA_PG_PORT ?? 54329);
const user = 'nuera';
const password = process.env.NUERA_PG_PASSWORD ?? 'nuera-dev-only';
const database = 'nuera_dev';

const pg = new EmbeddedPostgres({
  databaseDir, port, user, password,
  authMethod: 'scram-sha-256',
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'], // never inherit the Windows ANSI locale (§10.3)
  onLog: () => {},
  onError: (m) => console.error('[pg]', String(m)),
});

if (!existsSync(path.join(databaseDir, 'PG_VERSION'))) await pg.initialise();
await pg.start();
const admin = postgres({ host: '127.0.0.1', port, user, password, database: 'postgres', max: 1 });
const [exists] = await admin`select 1 from pg_database where datname = ${database}`;
if (!exists) await pg.createDatabase(database);
await admin.end();
console.log(`DATABASE_URL=postgres://${user}:${password}@127.0.0.1:${port}/${database}`);

const shutdown = async () => { await pg.stop(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

Production (VPS-3) uses a regular PostgreSQL 18 service (or the Coolify-managed one) with the same `DATABASE_URL` contract; embedded-postgres is a devDependency only [I].

---

## 9. Runner: PTY with `@lydell/node-pty`

### 9.1 Usage

The PTY calls below (`spawn`, `onData`, `onExit`, `write`, `resize`, `kill`) were exercised on Windows (§10.1–10.2); the Fastify wiring follows the `@fastify/websocket` README (handler `(socket, req)`, auth in `preValidation`, attach `message` listeners synchronously or early messages are dropped) [D] and was not run here.

```ts
// apps/runner/src/routes/terminal.ts
import websocket from '@fastify/websocket';
import * as pty from '@lydell/node-pty'; // CJS package; namespace and default ESM imports both expose spawn [V]
import type { FastifyInstance } from 'fastify';

export async function terminalRoutes(app: FastifyInstance) {
  await app.register(websocket, { options: { maxPayload: 1 << 20 } });

  app.get<{ Params: { sessionId: string } }>('/terminal/:sessionId', {
    websocket: true,
    preValidation: async (req, reply) => {
      if (!(await isOwnerSession(req.headers.cookie))) return reply.code(401).send(); // before the upgrade
    },
  }, (socket, req) => {
    const isWin = process.platform === 'win32';
    const term = pty.spawn(isWin ? 'cmd.exe' : 'tmux', isWin ? [] : ['attach-session', '-t', tmuxName(req.params.sessionId)], {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd: worktreePath(req.params.sessionId),
      env: { ...cleanEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'C.UTF-8' },
    });

    // client → PTY: JSON control frames; attach synchronously
    socket.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { t: 'in'; d: string } | { t: 'resize'; cols: number; rows: number };
      if (msg.t === 'in') term.write(msg.d);
      else if (msg.cols > 0 && msg.rows > 0) term.resize(msg.cols, msg.rows); // must be positive integers
    });
    // PTY → client: raw chunks (strings, VT sequences included)
    const out = term.onData((chunk) => socket.send(chunk));
    let exited = false;
    term.onExit(({ exitCode }) => {
      exited = true;
      out.dispose();
      if (isWin) term.kill(); // frees the ConPTY worker thread (§9.2-1)
      socket.close(1000, `exit ${exitCode}`);
    });
    // Closing the tab must NOT stop the Claude session: kill only the attach client.
    socket.on('close', () => { if (!exited) term.kill(); }); // Unix: SIGHUP to `tmux attach`; Windows: no signal argument
  });
}
```

Browser side: `@xterm/xterm` 6 + `FitAddon` (call `fit()` on container resize and send the new `cols/rows`), `WebLinksAddon`, `Unicode11Addon` (`term.unicode.activeVersion = '11'`). xterm touches `window` — load it through `next/dynamic(() => import(…), { ssr: false })` **from a Client Component** (`ssr: false` is an error in Server Components [D]). xterm 6 removed the canvas renderer, `windowsMode` and `fastScrollModifier`, moved `overviewRulerWidth` under `overviewRuler`, reworked scrolling, and added synchronized output (DEC 2026) and OSC 52 [D].

### 9.2 Pitfalls found on Windows [V]

1. **The event loop stays alive after a natural exit.** Each Windows PTY keeps a `MessagePort` (conout worker thread) + a `Socket` after `onExit`; a script that spawned three `cmd /c echo hi` never exited. Calling `term.kill()` inside `onExit` freed the worker and node exited on its own. Same behaviour with Microsoft `node-pty@1.1.0`. In a long-lived runner that is a leaked worker thread per finished PTY — always `kill()` after exit on Windows.
2. **`pid` is 0 right after `spawn()`** on Windows (connection is completed asynchronously); read it in/after the first `onData`.
3. **`onExit` fires ~1 s after the process ends** (`FLUSH_DATA_INTERVAL = 1000` in `windowsPtyAgent`): measured 1.06–1.08 s for `cmd /c echo hi`.
4. `write`, `resize`, `kill` are queued until the first output chunk arrives (`_deferNoArgs`).
5. Output always starts with ConPTY control sequences (`ESC[?9001h ESC[?1004h ESC[?25l ESC[2J ESC[m ESC[H …`) and an OSC title (`ESC]0;C:\WINDOWS\SYSTEM32\cmd.exe BEL`) — feed raw chunks to xterm, never parse them as text.
6. **Windows PowerShell 5.1 start-up inside ConPTY is erratic on this machine**: first output after 0.25 s … 7.6 s, and 3 runs out of 10 printed nothing within 8 s (all 5/5 succeeded with a 30 s timeout). Direct (non-PTY) `powershell -Command` runs took 4.0 s cold then ~0.22 s. Use `cmd.exe` (or the real target: bash on Linux) in automated tests; never assume a shell prompt within a fixed short delay.
7. `useConptyDll: true` (the package's own `conpty.dll` + `OpenConsole.exe` instead of the inbox ConPTY; node-pty 1.1.0's postinstall reported OpenConsole 1.23.251008001; VS Code's integrated terminal runs this mode — its `OpenConsole.exe` was visible in the process list) also works, but emits `ESC[1t` / `ESC[c` (DA1) queries a real terminal answers, and was slower here with PowerShell (3.3–7.9 s to first output, 1 of 4 runs silent for 8 s); once it reported exit only after `kill()`.
8. `@lydell/node-pty` 1.2.0-beta.x ships **no winpty**; ConPTY only (Windows 10 1809+). Microsoft's 1.1.0 still ships winpty.

### 9.3 Linux / VPS-3 [V][I]

- `@lydell/node-pty-linux-x64` 1.2.0-beta.18 contains `prebuilds/linux-x64/pty.node` requiring **glibc ≥ 2.28** (highest `GLIBC_2.28` symbol; no musl build) → Debian 10+/Ubuntu 20.04+ OK, Alpine images are not [V].
- Per `docs/research/claude-code.md`, sessions live in tmux / `claude` background sessions on VPS-3; the runner's PTY only *attaches* (`tmux attach` / `claude attach`), so a runner restart does not kill work [I].

---

## 10. Probe results (Windows 11, Node 24.21.0)

### 10.1 `@lydell/node-pty@1.2.0-beta.18` [V]

- `pnpm add` installed 2 packages (`@lydell/node-pty` + `@lydell/node-pty-win32-x64`) in ~1 s; **no install script, no compilation**. The win32 package ships `prebuilds/win32-x64/conpty.node`, `conpty_console_list.node` and `conpty/conpty.dll` + `OpenConsole.exe`.
- Loads on Node 24.21.0 (N-API, ABI 137) in ~1.4 s (first load, cold); ESM `import()` exposes `spawn` both as namespace and default.
- Results (ConPTY, `name: xterm-256color`, 100×30):

| Command | Result |
|---|---|
| `powershell.exe -NoLogo -NoProfile -Command "echo hello"` | `hello`, exit 0 — first text at 256 ms, exit at 1277 ms when launched from a PowerShell host; erratic from this agent's environment (see §9.2-6) |
| `cmd.exe /c echo hi` | `hi`, exit 0 — 5/5 runs: first text 54–68 ms, exit 1060–1082 ms |
| `cmd.exe /c echo …` with `useConptyDll: true` | text OK; exit reported only after `kill()` in one run |
| `git.exe --version` | `git version 2.43.0.windows.1`, exit 0 |
| interactive PowerShell: `resize(120,40)` then `echo cols=…`, `exit 7` | PowerShell did not start within the window in that run (see §9.2-6) |
| `kill()` on `Start-Sleep 30` | exit reported ~0.9 s after `kill()` |

### 10.2 Microsoft `node-pty@1.1.0` [V]

- `npm install` log: `node scripts/prebuild.js || node-gyp rebuild` → "Checking prebuilds..." succeeded, **node-gyp not run**; postinstall copied `conpty.dll` + `OpenConsole.exe` 1.23.251008001. CPU time 0.1 s; the 11 minutes were registry/disk wait.
- Ships prebuilds for `darwin-arm64`, `darwin-x64`, `win32-arm64`, `win32-x64` only (plus winpty) → **would compile on Linux**. `node-pty@1.2.0-beta.18` adds `linux-x64` / `linux-arm64` prebuilds.
- Same runtime behaviour as §9.2 (cmd text ~60 ms, exit ~1.06 s, handles kept alive until `kill()`).

### 10.3 embedded-postgres (cluster on port 54329) — PENDING

### 10.4 Drizzle 0.45.4 with postgres.js 4.0.0 and 3.4.9 — PENDING

### 10.5 Better Auth 1.7.17 end-to-end (CLI generate, Drizzle, 2FA, sessions) — PENDING

### 10.6 SSE handler logic in plain Node [V]

The §4.3 handler body (minus `next/*` imports and the session check) was run against Node 24's own `Request`/`Response`/`ReadableStream` (`probes/sse.mjs`):

- Headers out: `content-type: text/event-stream; charset=utf-8`, `cache-control: no-cache, no-transform`.
- Over 160 ms with a 50 ms heartbeat: 7 frames = `retry: 3000`, 4 `: ping` comments, 2 events (`id: 1\nevent: session\ndata: {"id":"s1","statut":"en_attente"}` …).
- `AbortController.abort()` on the request → `abort` listener ran the cleanup once, the stream closed, 0 bus listeners left.
- A consumer calling `reader.cancel()` (what a server does when it stops reading) → `cancel()` ran the same cleanup, 0 listeners left.
- Not covered: Next's own wiring of `request.signal` / stream cancellation on a real client disconnect, gzip, and reverse-proxy buffering — check those in the first `next dev` spike [I].

### 10.7 Tailwind skeleton compilation [V]

The §5 `globals.css` was compiled with the `compile()` API of `tailwindcss@4.3.4` (`tw/compile.mjs`; JS core only — the PostCSS plugin and native Oxide scanner were not installed). For the candidates `bg-bg text-muted p-5 rounded-lg text-app-14 font-sans tone-dark:bg-accent md:p-8 bg-red-500 …`:

| Candidate | Output |
|---|---|
| `bg-bg` | `.bg-bg { background-color: var(--bg); }` — `@theme inline` emits the role variable directly, no `--color-bg` on `:root` |
| `text-muted` | `.text-muted { color: var(--muted); }` |
| `p-5` | `.p-5 { padding: calc(var(--spacing) * 5); }` with `--spacing: 4px` on `:root` → 20 px |
| `rounded-lg` | `.rounded-lg { border-radius: var(--radius-lg); }` (20 px) |
| `text-app-14` | `.text-app-14 { font-size: var(--text-app-14); }` |
| `font-sans` | `font-family: var(--font-outfit), ui-sans-serif, system-ui, sans-serif` |
| `tone-dark:bg-accent` | `.tone-dark\:bg-accent:where([data-tone="dark"], [data-tone="dark"] *) { background-color: var(--accent); }` |
| `md:p-8` | generated (inside the `md` media query) |
| `bg-red-500`, `text-sky-300` | **absent** — `--color-*: initial` removed the default palette |

### 10.8 git [V]

`git version 2.43.0.windows.1` (PATH: `C:\Program Files\Git\mingw64\bin\git.exe`; also spawned fine through the PTY). Git for Windows 2.43 is from late 2023 — fine for development (`worktree`, `--porcelain=v2`, `--progress` all exist), but VPS-3 should run a current git [I].

---

## 11. Pitfalls checklist

1. `typescript@latest` is 7 → pin 6.0.3 (typescript-eslint).
2. `@types/node@latest` is 26 → pin 24.x to match the runtime.
3. `postgres@latest` is a 6-day-old major with new parameter/Date semantics → pin 3.4.9 with Drizzle 0.45.
4. `@better-auth/cli` is deprecated → `auth` package; passkey is `@better-auth/passkey`.
5. `nextCookies()` must be the last Better Auth plugin.
6. Proxy is optimistic only; check the session in every page/action/route.
7. Parallel route slots need `default.tsx` in Next 16.
8. `@theme inline` for any token that changes inside `[data-tone=dark]`.
9. pnpm 9 ignores `onlyBuiltDependencies` in `pnpm-workspace.yaml`; the embedded-postgres scripts are in `@embedded-postgres/<platform>`.
10. Windows PTY: `kill()` after `onExit`, `pid` async, 1 s exit delay, erratic PowerShell start-up, MSYS path conversion in Git Bash.
11. `output: 'standalone'` on Windows needs symlink rights → build on Linux.
12. SSE: `Cache-Control: no-cache, no-transform`, heartbeat comments, disable proxy buffering, HTTP/2.
13. embedded-postgres on a French Windows: pass `--encoding=UTF8 --locale=C` (see §10.3).
14. `@lydell/node-pty` Linux prebuild needs glibc ≥ 2.28 (no Alpine).
15. Better Auth rate limiting does not apply to `auth.api` server calls; set `ipAddressHeaders` behind the proxy.

---

## 12. Open points

- Confirm the reverse proxy on VPS-3 (Coolify → Traefik) and which client-IP header it overwrites (`advanced.ipAddress.ipAddressHeaders`).
- Decide whether the runner authenticates WebSocket upgrades by validating the Better Auth session cookie itself (shared `@nuera/db` + same secret) or with a short-lived token minted by the web app [I].
- Re-evaluate postgres.js 4 + Drizzle 1.0 together once Drizzle 1.0 is `latest`.

---

## 13. Sources

- npm registry metadata, queried 2026-11-04 with `npm view <pkg> --json` (all versions, dist-tags, engines, peers in §2).
- Next.js 16 release: https://nextjs.org/blog/next-16
- Next.js 16.4 release: https://nextjs.org/blog/next-16-4
- Next.js November 2026 security release: https://nextjs.org/blog/november-2026-security-release
- Next.js blog index: https://nextjs.org/blog
- `proxy.js`: https://nextjs.org/docs/app/api-reference/file-conventions/proxy
- `route.js`: https://nextjs.org/docs/app/api-reference/file-conventions/route
- Route Handlers (caching, Cache Components): https://nextjs.org/docs/app/getting-started/route-handlers
- `output`: https://nextjs.org/docs/app/api-reference/config/next-config-js/output
- `instrumentation.js`: https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
- Environment variables: https://nextjs.org/docs/app/guides/environment-variables
- `serverActions`: https://nextjs.org/docs/app/api-reference/config/next-config-js/serverActions
- TypeScript (TS 7, typed routes): https://nextjs.org/docs/app/api-reference/config/typescript
- ESLint plugin: https://nextjs.org/docs/app/api-reference/config/eslint
- Next.js PR rejecting TS ≥ 7 on 15.5: https://github.com/vercel/next.js/pull/96110
- typescript-eslint dependency versions: https://typescript-eslint.io/users/dependency-versions/
- ESLint version support: https://eslint.org/version-support/
- Tailwind + Next.js: https://tailwindcss.com/docs/installation/framework-guides/nextjs
- Tailwind theme variables: https://tailwindcss.com/docs/theme
- Tailwind dark mode / `@custom-variant`: https://tailwindcss.com/docs/dark-mode
- Better Auth installation: https://www.better-auth.com/docs/installation
- Better Auth + Next.js: https://www.better-auth.com/docs/integrations/next
- Better Auth options: https://www.better-auth.com/docs/reference/options
- Better Auth sessions: https://www.better-auth.com/docs/concepts/session-management
- Better Auth rate limit: https://www.better-auth.com/docs/concepts/rate-limit
- Better Auth Drizzle adapter: https://www.better-auth.com/docs/adapters/drizzle
- Better Auth 2FA: https://www.better-auth.com/docs/plugins/2fa
- Better Auth passkey: https://www.better-auth.com/docs/plugins/passkey
- Better Auth email & password: https://better-auth.com/docs/authentication/email-password.md
- Community thread on seeding with `disableSignUp`: https://answeroverflow.com/m/1354152670759227485
- Drizzle PostgreSQL: https://orm.drizzle.team/docs/get-started-postgresql
- Drizzle migrations: https://orm.drizzle.team/docs/migrations
- Drizzle config file: https://orm.drizzle.team/docs/drizzle-config-file
- Drizzle v1 upgrade: https://orm.drizzle.team/docs/upgrade-v1
- postgres.js v4.0.0 release: https://github.com/porsager/postgres/releases/tag/v4.0.0
- embedded-postgres: https://github.com/leinelissen/embedded-postgres
- xterm.js 6.0.0: https://github.com/xtermjs/xterm.js/releases/tag/6.0.0
- `@lydell/node-pty` README (in the package; repository https://github.com/lydell/node-pty)
- pnpm v10.0.0 release: https://github.com/pnpm/pnpm/releases/tag/v10.0.0
- pnpm v10.5.0 release: https://github.com/pnpm/pnpm/releases/tag/v10.5.0
- pnpm build settings: https://pnpm.io/settings/build
- `compression` middleware (no-transform, SSE): https://github.com/expressjs/compression#compressionoptions and https://github.com/expressjs/compression#server-sent-events
- Next.js `compress`: https://nextjs.org/docs/app/api-reference/config/next-config-js/compress
- Next.js 16.1 (dev filesystem cache on by default): https://nextjs.org/blog/next-16-1
