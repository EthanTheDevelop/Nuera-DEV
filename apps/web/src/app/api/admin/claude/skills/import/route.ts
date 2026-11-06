import { importSkillZip, SKILL_ZIP_MAX_BYTES } from '@/server/claude-config';
import { AppError } from '@/server/errors';
import { apiRoute } from '@/server/http';

/**
 * POST multipart/form-data: `file` (.zip, 4 Mio au plus), `allowScripts` (« on » to accept scripts),
 * `replace` (« on »: new version of the skill of the same name), `audience`, `enforcement`
 *   → { skill, scripts, created }
 * Validated before anything is written: SKILL.md (name, description), text files only, no hidden file,
 * no `..`, no link, sizes; scripts refused unless allowed.
 */
export const dynamic = 'force-dynamic';

const flag = (value: FormDataEntryValue | null) => value === 'on' || value === 'true' || value === '1';

export const POST = apiRoute({
  auth: 'admin',
  rateLimit: { limit: 30, windowMs: 10 * 60_000 },
  handler: async ({ user, request }) => {
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (declared > SKILL_ZIP_MAX_BYTES + 64 * 1024) throw new AppError('VALIDATION', 'Archive trop volumineuse (4 Mio au plus).');
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new AppError('VALIDATION', 'Formulaire illisible : envoyez le fichier .zip dans le champ « file ».');
    }
    const file = form.get('file');
    if (!file || typeof file === 'string') throw new AppError('VALIDATION', 'Choisissez un fichier .zip.');
    if (file.size > SKILL_ZIP_MAX_BYTES) throw new AppError('VALIDATION', 'Archive trop volumineuse (4 Mio au plus).');
    const buffer = Buffer.from(await file.arrayBuffer());
    return importSkillZip(user, buffer, {
      allowScripts: flag(form.get('allowScripts')),
      replace: flag(form.get('replace')),
      ...(form.get('audience') ? { audience: String(form.get('audience')) } : {}),
      ...(form.get('enforcement') ? { enforcement: String(form.get('enforcement')) } : {}),
    });
  },
});
