import 'server-only';
import { AppError, formatZodIssues } from '@/server/errors';
import type { RequestContext } from '@/server/tenancy/context';
import { renderManifestFormPage, startManifestFlow, startManifestInputSchema, stateCookie } from './manifest';
import { integrationsUrl, redirectResponse } from './redirects';

/**
 * « Connecter GitHub » / « Ajouter une source GitHub » (POST /api/integrations/github/manifest and
 * POST /api/integrations/github/sources): a form post (`organization`, `public`) or JSON answered by
 * the self-submitting page that posts the App manifest to github.com, with a signed state (account,
 * space, new source id) bound to this browser by an HttpOnly cookie of the account. The space
 * already holding the maximum of sources is sent back to Intégrations (`?github=source_limit`).
 */

async function readInput(request: Request): Promise<unknown> {
  const type = request.headers.get('content-type')?.toLowerCase() ?? '';
  const text = await request.text();
  if (text.length > 4096) throw new AppError('VALIDATION', 'Requête trop volumineuse.');
  if (!text.trim()) return {};
  if (type.includes('application/json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new AppError('VALIDATION', 'Corps JSON illisible.');
    }
  }
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  throw new AppError('VALIDATION', 'Formulaire attendu.');
}

export async function startManifestResponse(request: Request, ctx: Pick<RequestContext, 'user' | 'space'>): Promise<Response> {
  const parsed = startManifestInputSchema.safeParse(await readInput(request));
  if (!parsed.success) throw new AppError('VALIDATION', 'Données invalides.', { detail: formatZodIssues(parsed.error) });
  let form;
  try {
    form = await startManifestFlow({
      userId: ctx.user.id,
      spaceId: ctx.space.id,
      ...(parsed.data.organization ? { organization: parsed.data.organization } : {}),
      public: parsed.data.public,
    });
  } catch (error) {
    if (error instanceof AppError && error.reason === 'SOURCE_LIMIT') return redirectResponse(integrationsUrl('source_limit'));
    throw error;
  }
  return new Response(renderManifestFormPage(form), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': stateCookie(form.nonce, ctx.user.id),
    },
  });
}
