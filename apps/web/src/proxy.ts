import { getSessionCookie } from 'better-auth/cookies';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Optimistic gate (Next 16 « proxy », Node runtime): only checks that a session cookie is
 * PRESENT. It never proves a session is valid — every page, route handler and server action
 * re-checks it with requireUser() / requireUserForApi().
 *
 *  - no session cookie, page request  → /connexion?suivant=<path> (or the second-factor step
 *    when the password step succeeded: cookie `nuera.two_factor`);
 *  - no session cookie, /api/* request → 401 JSON;
 *  - otherwise: passes the requested path to the server (x-nuera-path) for the post-login return.
 * Public: /connexion, /configuration, /mot-de-passe-oublie(/<jeton>), /invitation/<jeton> and /recuperation/<jeton> (single-use links,
 * checked by their pages), /api/auth/*, /api/health, /api/internal/* (Bearer runner
 * token), /api/push/subscription/renew (the service worker reads the public VAPID key and renews a
 * push subscription, possibly once the access has ended: the route itself only renews the row of the
 * account whose session cookie it carries, writes nothing without one, and always answers 204)
 * and static assets (matcher below).
 */

const PUBLIC_PAGES = /^\/(connexion|configuration|invitation|recuperation|mot-de-passe-oublie)(\/|$)/;
/** Same list as BROWSER_API_ROUTES (server/auth/policy.ts): API routes GitHub sends the browser to. */
const BROWSER_API_ROUTES = /^\/api\/integrations\/github\/(callback|setup|install)$/;
/** API routes without a session cookie by design (they check their own capability). */
const PUBLIC_API_ROUTES = /^\/api\/push\/subscription\/renew$/;
/** Development gallery (/kit): public only with NUERA_KIT_PUBLIC=1 in development (the (dev) layout agrees). */
const kitIsPublic = process.env.NODE_ENV === 'development' && process.env.NUERA_KIT_PUBLIC === '1';
const REQUEST_PATH_HEADER = 'x-nuera-path';

function hasPendingSecondFactor(request: NextRequest): boolean {
  return Boolean(request.cookies.get('nuera.two_factor') ?? request.cookies.get('__Secure-nuera.two_factor'));
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const forwarded = new Headers(request.headers);
  forwarded.delete(REQUEST_PATH_HEADER);

  if (PUBLIC_PAGES.test(pathname) || PUBLIC_API_ROUTES.test(pathname) || (kitIsPublic && /^\/kit(\/|$)/.test(pathname))) {
    return NextResponse.next({ request: { headers: forwarded } });
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
  return NextResponse.next({ request: { headers: forwarded } });
}

export const config = {
  matcher: [
    '/((?!api/auth|api/health|api/internal|_next/static|_next/image|favicon\\.ico|icon|apple-icon|manifest\\.webmanifest|sw\\.js|robots\\.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|txt|xml|woff2?|map)$).*)',
  ],
};
