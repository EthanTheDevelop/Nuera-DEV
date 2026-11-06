import { getSessionCookie } from 'better-auth/cookies';
import { NextResponse, type NextRequest } from 'next/server';
import {
  PREVIEW_COOKIE,
  PREVIEW_ENTRY_PATH,
  PREVIEW_RESERVED_PREFIX,
  PREVIEW_ROUTES,
  isPreviewRequest,
  previewResponseHeaders,
  readPreviewConfig,
  type PreviewConfig,
} from '@/lib/preview';
import { appContentSecurityPolicy, githubWebOrigin } from '@/lib/security-headers';

/**
 * Next 16 « proxy » (Node runtime), first stop of EVERY request (the matcher takes everything: the
 * preview host must see the previewed site's static files too).
 *
 * 1. Preview host (`PREVIEW_HOST`, « Aperçu »): nothing of the application is reachable. Every
 *    request goes to the runner of the run's server by an EXTERNAL rewrite once the preview cookie
 *    and the access are checked (`server/preview/gate.ts`: Next streams it, WebSocket upgrades
 *    included, and never handles it as one of its own RSC requests), except `/__nuera/entree`
 *    (handoff → cookie) and the rest of `/__nuera/*` (404). Its responses may only be framed by the
 *    application (`frame-ancestors <APP_URL>`).
 * 2. Application host: the relay routes answer 404; static assets pass untouched; then the optimistic
 *    session gate — it only checks that a session cookie is PRESENT. It never proves a session is
 *    valid: every page, route handler and server action re-checks it with requireUser() /
 *    requireUserForApi().
 *    - no session cookie, page request  → /connexion?suivant=<path> (or the second-factor step
 *      when the password step succeeded: cookie `nuera.two_factor`);
 *    - no session cookie, /api/* request → 401 JSON;
 *    - otherwise: passes the requested path to the server (x-nuera-path) for the post-login return,
 *      and, when the preview is on, the page CSP with `frame-src <preview origin>`.
 * Public: /connexion, /configuration, /mot-de-passe-oublie(/<jeton>), /invitation/<jeton> and /recuperation/<jeton> (single-use links,
 * checked by their pages), /api/auth/*, /api/health, /api/internal/* (Bearer runner
 * token), /api/push/subscription/renew (the service worker reads the public VAPID key and renews a
 * push subscription, possibly once the access has ended: the route itself only renews the row of the
 * account whose session cookie it carries, writes nothing without one, and always answers 204)
 * and static assets.
 */

const PUBLIC_PAGES = /^\/(connexion|configuration|invitation|recuperation|mot-de-passe-oublie)(\/|$)/;
/** Same list as BROWSER_API_ROUTES (server/auth/policy.ts): API routes GitHub sends the browser to. */
const BROWSER_API_ROUTES = /^\/api\/integrations\/github\/(callback|setup|install)$/;
/** API routes without a session cookie by design (they check their own capability). */
const PUBLIC_API_ROUTES = /^\/api\/push\/subscription\/renew$/;
/** What the former matcher left out: auth, health and runner callbacks (own checks), static assets. */
const UNGATED = /^\/(?:api\/auth|api\/health|api\/internal|_next\/static|_next\/image|favicon\.ico|icon|apple-icon|manifest\.webmanifest|sw\.js|robots\.txt)(?:\/|$)|\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|txt|xml|woff2?|map)$/;
/** Route handlers of the preview host: never served on the application host. */
const PREVIEW_ONLY = /^\/api\/apercu(?:\/|$)/;
/** Development gallery (/kit): public only with NUERA_KIT_PUBLIC=1 in development (the (dev) layout agrees). */
const kitIsPublic = process.env.NODE_ENV === 'development' && process.env.NUERA_KIT_PUBLIC === '1';
const REQUEST_PATH_HEADER = 'x-nuera-path';

function hasPendingSecondFactor(request: NextRequest): boolean {
  return Boolean(request.cookies.get('nuera.two_factor') ?? request.cookies.get('__Secure-nuera.two_factor'));
}

/** Raw path + query as the browser sent it (percent-encoding kept). */
function rawPathAndQuery(request: NextRequest): string {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

async function previewHost(request: NextRequest, config: Extract<PreviewConfig, { enabled: true }>): Promise<Response> {
  const { pathname } = request.nextUrl;
  const headers = previewResponseHeaders(config);
  const forwarded = new Headers(request.headers);
  forwarded.delete(REQUEST_PATH_HEADER);
  if (pathname === PREVIEW_ENTRY_PATH) {
    const target = new URL(PREVIEW_ROUTES.entry, request.url);
    target.search = request.nextUrl.search;
    // The handoff token is in the query: it never leaves as a Referer.
    return NextResponse.rewrite(target, { request: { headers: forwarded }, headers: { ...headers, 'referrer-policy': 'no-referrer' } });
  }
  if (pathname === PREVIEW_RESERVED_PREFIX.slice(0, -1) || pathname.startsWith(PREVIEW_RESERVED_PREFIX)) {
    return new NextResponse('Introuvable.', { status: 404, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  }
  // Loaded on the preview host only (database access): the application's requests never pay for it.
  const { previewGate } = await import('@/server/preview/gate');
  const decision = await previewGate({ headers: request.headers, cookie: request.cookies.get(PREVIEW_COOKIE)?.value }, rawPathAndQuery(request), config);
  if (decision.kind === 'response') {
    for (const [name, value] of Object.entries(headers)) decision.response.headers.set(name, value);
    return decision.response;
  }
  return NextResponse.rewrite(decision.url, { request: { headers: decision.headers }, headers });
}

/** Query of an application request without Next's RSC cache-busting marker (`skipProxyUrlNormalize`). */
function searchOf(request: NextRequest): string {
  const params = new URLSearchParams(request.nextUrl.search);
  if (!params.has('_rsc')) return request.nextUrl.search;
  params.delete('_rsc');
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const preview = readPreviewConfig();
  if (preview.enabled && isPreviewRequest(request.headers, preview)) return previewHost(request, preview);

  if (PREVIEW_ONLY.test(pathname)) {
    return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Route inconnue.' } }, { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  if (UNGATED.test(pathname)) return NextResponse.next();
  const search = searchOf(request);

  const forwarded = new Headers(request.headers);
  forwarded.delete(REQUEST_PATH_HEADER);
  // Pages may frame the preview origin, and nothing else (next.config's CSP is fixed at build time).
  const responseHeaders: Record<string, string> = preview.enabled
    ? { 'content-security-policy': appContentSecurityPolicy({ isProd: process.env.NODE_ENV === 'production', githubOrigin: githubWebOrigin(), frameOrigin: preview.origin }) }
    : {};

  if (PUBLIC_PAGES.test(pathname) || PUBLIC_API_ROUTES.test(pathname) || (kitIsPublic && /^\/kit(\/|$)/.test(pathname))) {
    return NextResponse.next({ request: { headers: forwarded }, headers: responseHeaders });
  }

  if (!getSessionCookie(request, { cookiePrefix: 'nuera' })) {
    if (pathname.startsWith('/api/') && !BROWSER_API_ROUTES.test(pathname)) {
      return NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Connexion requise.' } },
        { status: 401, headers: { 'cache-control': 'no-store' } },
      );
    }
    const target = new URL(hasPendingSecondFactor(request) ? '/connexion/deux-facteurs' : '/connexion', request.url);
    const requested = `${pathname}${search}`;
    if (requested !== '/' && !requested.startsWith('/deconnexion')) target.searchParams.set('suivant', requested);
    return NextResponse.redirect(target);
  }

  forwarded.set(REQUEST_PATH_HEADER, `${pathname}${search}`);
  return NextResponse.next({ request: { headers: forwarded }, headers: responseHeaders });
}

export const config = {
  // Everything: the preview host relays the previewed site's own static files (`/_next/static/…`,
  // `/logo.png`), so the application's exclusions moved to UNGATED above.
  matcher: ['/:path*'],
};
