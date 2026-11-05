import { AppError, formatZodIssues } from '@/server/errors';
import { renderManifestFormPage, startManifestFlow, startManifestInputSchema, stateCookie } from '@/server/github';
import { apiRoute } from '@/server/http';

/**
 * POST /api/integrations/github/manifest — « Connecter GitHub » (D07, no app stored yet).
 * Accepts a form post (`organization`, `public`) or JSON, and answers with a self-submitting page
 * that posts the App manifest to github.com with a signed `state` (valid one hour, bound to this
 * browser by an HttpOnly cookie).
 */

export const dynamic = 'force-dynamic';

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

export const POST = apiRoute({
  rateLimit: { limit: 10, windowMs: 10 * 60_000 },
  handler: async ({ request, user }) => {
    const parsed = startManifestInputSchema.safeParse(await readInput(request));
    if (!parsed.success) throw new AppError('VALIDATION', 'Données invalides.', { detail: formatZodIssues(parsed.error) });
    const form = await startManifestFlow({
      userId: user.id,
      ...(parsed.data.organization ? { organization: parsed.data.organization } : {}),
      public: parsed.data.public,
    });
    return new Response(renderManifestFormPage(form), {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': stateCookie(form.nonce),
      },
    });
  },
});
