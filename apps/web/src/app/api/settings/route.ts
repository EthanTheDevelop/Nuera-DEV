import { apiRoute } from '@/server/http';
import { getSettingsValues, settingsPatchSchema, updateSettings } from '@/server/preferences';

/**
 * Réglages de Paramètres, chaque clé dans sa portée (docs/MULTICOMPTE.md §8): instance
 * (propriétaire / administrateurs), serveur de l'espace (nom et lieu : administrateurs ; sessions
 * parallèles et mémoire : propriétaire de l'espace, sous le plafond de l'administrateur), espace,
 * compte.
 *   GET   → SettingsValues of the account (+ `editable` per key; no secret)
 *   PATCH { <flat keys> } → SettingsValues + `results` (per key: updated · unchanged · ignored ·
 *         refused). Nothing went through → the refusal itself: 403 « Réglage réservé aux
 *         administrateurs. » for an instance key changed by a member, 422 for an invalid value
 *         (nothing written), 409 without a server for a server key.
 */

export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  handler: async ({ ctx }) => getSettingsValues(ctx),
});

export const PATCH = apiRoute({
  body: settingsPatchSchema,
  maxBodyBytes: 8 * 1024,
  rateLimit: { limit: 60, windowMs: 60_000 },
  handler: async ({ body, ctx }) => {
    const { values, results } = await updateSettings(ctx, body);
    return { ...values, results };
  },
});
