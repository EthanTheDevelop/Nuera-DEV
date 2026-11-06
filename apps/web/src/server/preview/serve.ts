import 'server-only';
import type { NextRequest } from 'next/server';
import { isPreviewRequest, PREVIEW_COOKIE, readPreviewConfig } from '@/lib/preview';
import { PreviewDenied, resolvePreviewAccess } from './access';
import { previewMessagePage } from './html';
import { consumeHandoffToken, issuePreviewCookie, previewCookieHeader } from './tokens';

/**
 * Route handler of the preview host's entry (`/api/apercu/entree`, reached only through the rewrite
 * of src/proxy.ts; every other request of that host goes to the runner, see ./gate.ts). On any
 * other host it answers the same 404 as an unknown route.
 */

function unknownRoute(): Response {
  return Response.json({ error: { code: 'NOT_FOUND', message: 'Route inconnue.' } }, { status: 404, headers: { 'cache-control': 'no-store' } });
}

const CLOSED_TITLE = 'Aperçu fermé';

function denied(error: unknown): Response {
  if (error instanceof PreviewDenied) return previewMessagePage(403, CLOSED_TITLE, error.message);
  throw error;
}

/** `GET /__nuera/entree?jeton=` — spends the handoff token, sets `nuera_apercu`, redirects to the asked path. */
export async function servePreviewEntry(request: NextRequest): Promise<Response> {
  const config = readPreviewConfig();
  if (!config.enabled || !isPreviewRequest(request.headers, config)) return unknownRoute();
  const claims = consumeHandoffToken(request.nextUrl.searchParams.get('jeton'));
  if (!claims) {
    return previewMessagePage(401, "Lien d'aperçu expiré", "Ce lien ne sert qu'une fois, pendant une minute : rouvrez l'aperçu depuis le Workspace de Nuera Dev.");
  }
  try {
    await resolvePreviewAccess(claims, { fresh: true });
  } catch (error) {
    return denied(error);
  }
  const cookie = issuePreviewCookie(claims);
  return new Response(null, {
    status: 303,
    headers: {
      location: claims.path,
      'set-cookie': previewCookieHeader(PREVIEW_COOKIE, cookie.value, { maxAgeSeconds: cookie.maxAgeSeconds, secure: config.secure, sameSite: config.sameSite }),
      'cache-control': 'no-store',
    },
  });
}
