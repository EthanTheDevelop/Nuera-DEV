import { ATTACHMENT_MAX_BYTES } from '@nuera/shared/runner';
import { sessionParamsSchema } from '@/features/workspace/lib/contract';
import { attachmentFileSchema } from '@/features/workspace/lib/composer';
import { AppError, formatZodIssues } from '@/server/errors';
import { apiRoute } from '@/server/http';
import { requireSessionContext, uploadAttachment, withWorkspaceErrors } from '@/server/workspace';

/**
 * POST /api/sessions/[sessionId]/attachments (multipart, field `file`) — « Joindre » of the composer:
 * one file written by the runner under `.nuera/pieces-jointes/` of the session's worktree (git-ignored
 * through `info/exclude`), then referenced with `@<chemin>` in the instruction. Untrusted: size
 * declared and capped before reading (20 Mo), name and type validated here and the bytes checked
 * again by the runner; the file is never served back. Audited `session.attachment`.
 * → { path, name, size, kind, contentType }
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Multipart envelope around the file (boundary, headers of the part). */
const MULTIPART_OVERHEAD = 64 * 1024;

export const POST = apiRoute({
  params: sessionParamsSchema,
  rateLimit: { limit: 60, windowMs: 10 * 60_000 },
  // The session is checked before the body is read: an id of another space never gets its bytes read.
  handler: ({ params, ctx, request }) =>
    withWorkspaceErrors(async () => {
      await requireSessionContext(ctx, params.sessionId);
      const file = await readAttachment(request);
      return uploadAttachment(ctx, params.sessionId, file);
    }),
});

async function readAttachment(
  request: Request,
): Promise<{ name: string; type: string; bytes: Uint8Array }> {
  const declared = Number(request.headers.get('content-length') ?? Number.NaN);
  if (!Number.isFinite(declared) || declared <= 0) {
    throw new AppError('VALIDATION', 'Taille de la pièce jointe inconnue : envoi refusé.', {
      untouched: "Aucun fichier n'a été écrit.",
    });
  }
  if (declared > ATTACHMENT_MAX_BYTES + MULTIPART_OVERHEAD) {
    throw new AppError('VALIDATION', 'Fichier trop volumineux : 20 Mo au maximum.', {
      untouched: "Aucun fichier n'a été écrit.",
    });
  }
  if (
    !(request.headers.get('content-type') ?? '').toLowerCase().startsWith('multipart/form-data')
  ) {
    throw new AppError('VALIDATION', 'Envoi multipart attendu (champ « file »).', {
      untouched: "Aucun fichier n'a été écrit.",
    });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new AppError('VALIDATION', 'Pièce jointe illisible.', {
      untouched: "Aucun fichier n'a été écrit.",
    });
  }
  const files = form.getAll('file');
  const file = files[0];
  if (files.length !== 1 || !(file instanceof File)) {
    throw new AppError('VALIDATION', 'Un seul fichier par envoi (champ « file »).', {
      untouched: "Aucun fichier n'a été écrit.",
    });
  }
  const parsed = attachmentFileSchema.safeParse({
    name: file.name,
    size: file.size,
    type: file.type,
  });
  if (!parsed.success) {
    throw new AppError('VALIDATION', 'Pièce jointe refusée.', {
      detail: formatZodIssues(parsed.error),
      untouched: "Aucun fichier n'a été écrit.",
    });
  }
  return {
    name: parsed.data.name,
    type: parsed.data.type,
    bytes: new Uint8Array(await file.arrayBuffer()),
  };
}
