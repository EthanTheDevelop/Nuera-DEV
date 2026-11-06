import 'server-only';
import { isSafePreviewPath, PREVIEW_LIMITS } from '@nuera/shared/runner';
import type { NextRequest } from 'next/server';
import { isPreviewRequest, PREVIEW_COOKIE, PREVIEW_PATH_HEADER, readPreviewConfig } from '@/lib/preview';
import { PreviewDenied, resolvePreviewAccess } from './access';
import { previewMessagePage } from './html';
import { relayPreviewRequest } from './relay';
import { consumeHandoffToken, issuePreviewCookie, previewCookieHeader, readPreviewCookie } from './tokens';

/**
 * Route handlers of the preview host (`/api/apercu/*`, reached only through the rewrite of
 * src/proxy.ts). On any other host they answer the same 404 as an unknown route.
 */

function unknownRoute(): Response {
  return Response.json({ error: { code: 'NOT_FOUND', message: 'Route inconnue.' } }, { status: 404, headers: { 'cache-control': 'no-store' } });
}

const CLOSED_TITLE = 'Aperçu fermé';
const CLOSED_TEXT = "Ouvrez l'aperçu depuis le Workspace de Nuera Dev.";

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

/** Any other request of the preview host: cookie → access → relay to the dev server. */
export async function servePreviewRequest(request: NextRequest): Promise<Response> {
  const config = readPreviewConfig();
  if (!config.enabled || !isPreviewRequest(request.headers, config)) return unknownRoute();
  const path = request.headers.get(PREVIEW_PATH_HEADER);
  if (!path || !isSafePreviewPath(path)) return previewMessagePage(400, 'Adresse refusée', "Ce chemin ne peut pas être transmis au serveur de développement.");
  const claims = readPreviewCookie(request.cookies.get(PREVIEW_COOKIE)?.value);
  if (!claims) return previewMessagePage(401, CLOSED_TITLE, CLOSED_TEXT);
  let access: Awaited<ReturnType<typeof resolvePreviewAccess>>;
  try {
    access = await resolvePreviewAccess(claims);
  } catch (error) {
    return denied(error);
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > PREVIEW_LIMITS.requestBodyBytes) {
    return previewMessagePage(413, 'Envoi trop volumineux', "L'aperçu transmet au plus 10 Mo par requête.");
  }
  return relayPreviewRequest(request, access, path, config);
}
