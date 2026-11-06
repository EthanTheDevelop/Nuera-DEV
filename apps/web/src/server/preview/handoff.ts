import 'server-only';
import { commandRuns } from '@nuera/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { normalizePreviewPath, PREVIEW_ENTRY_PATH, readPreviewConfig, type PreviewConfig } from '@/lib/preview';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import type { RequestContext } from '@/server/tenancy/context';
import { scopeOfRun } from '@/server/tenancy/scope';
import { issueHandoffToken } from './tokens';

export const previewHandoffInputSchema = z
  .object({
    runId: z.uuid('lancement invalide'),
    /** Path to open first (« Ouvrir dans un nouvel onglet » keeps the page shown). Default `/`. */
    path: z.string().max(2048, 'chemin trop long').optional(),
  })
  .strict();
export type PreviewHandoffInput = z.input<typeof previewHandoffInputSchema>;

export interface PreviewHandoff {
  /** `https://PREVIEW_HOST/__nuera/entree?jeton=…` — single use, 60 s. */
  url: string;
  origin: string;
  expiresAt: string;
}

/** What the Workspace needs to know about the preview (never a secret). */
export type PreviewSettingsView = { enabled: true; origin: string } | { enabled: false; reason: string };

export function previewSettingsView(config: PreviewConfig = readPreviewConfig()): PreviewSettingsView {
  return config.enabled ? { enabled: true, origin: config.origin } : { enabled: false, reason: config.reason };
}

/**
 * Handoff to the preview origin (POST /api/previews): the run must be a dev server of the account's
 * space (same 404 as an unknown run otherwise, before any runner call), alive with a detected port.
 * Returns the single-use entry URL of the preview host, bound to this account, its current web
 * access and the run. Switching to another worktree's preview = a new handoff.
 */
export async function createPreviewHandoff(ctx: RequestContext, input: PreviewHandoffInput): Promise<PreviewHandoff> {
  const parsed = previewHandoffInputSchema.parse(input);
  const config = readPreviewConfig();
  if (!config.enabled) throw new AppError('CONFLICT', config.reason, { reason: 'PREVIEW_DISABLED' });
  const path = normalizePreviewPath(parsed.path);
  if (!path) throw new AppError('VALIDATION', 'Chemin invalide : saisissez un chemin du site, par exemple /devis.');
  const scope = await scopeOfRun(ctx, parsed.runId);
  const [row] = await db.select({ kind: commandRuns.kind }).from(commandRuns).where(eq(commandRuns.id, scope.runId)).limit(1);
  if (row?.kind !== 'dev') throw new AppError('VALIDATION', "Ce lancement n'est pas un serveur de développement.", { reason: 'PREVIEW_NOT_DEV' });
  const run = await scope.runner.getRun({ params: { runId: scope.runId } }, { timeoutMs: 5_000 });
  if (!run.live || run.status !== 'running') throw new AppError('CONFLICT', 'Le serveur de développement est arrêté.', { reason: 'PREVIEW_NOT_RUNNING' });
  if (!run.port) {
    throw new AppError('CONFLICT', "Le port du serveur de développement n'apparaît pas encore dans sa sortie.", { reason: 'PREVIEW_NO_PORT' });
  }
  const { token, expiresAt } = issueHandoffToken({ userId: ctx.user.id, authSessionId: ctx.user.authSessionId, runId: scope.runId, path });
  return {
    url: `${config.origin}${PREVIEW_ENTRY_PATH}?jeton=${encodeURIComponent(token)}`,
    origin: config.origin,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}
