/**
 * Composer of the Workspace (« comme un chat Claude Code ») — contracts shared by the browser and
 * the routes `POST /api/sessions/[id]/attachments | model | permission-mode` and
 * `GET /api/sessions/[id]/composer`. Pure: Zod schemas, types, option lists.
 */
import { ATTACHMENT_MAX_BYTES, attachmentKindOf } from '@nuera/shared/attachments';
import type {
  AttachmentDto,
  PermissionModeValue,
  SessionSkill,
  SwitchablePermissionMode,
} from '@nuera/shared/runner';
import { z } from 'zod';

export type { AttachmentDto, SessionSkill, SwitchablePermissionMode };

/** Same rule as the runner's `ModelNameSchema` (no space, no control character: safe to type into the CLI). */
export const modelInputSchema = z
  .object({
    model: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._:[\]-]{1,80}$/, 'modèle invalide'),
  })
  .strict();
export const permissionModeInputSchema = z
  .object({ mode: z.enum(['manual', 'acceptEdits', 'plan', 'auto'], 'mode inconnu') })
  .strict();

/** The uploaded part of `POST …/attachments` (multipart field `file`). */
export const attachmentFileSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'nom de fichier requis')
    .max(255, 'nom de fichier trop long')
    .refine((name) => attachmentKindOf(name) !== null, 'type de fichier refusé'),
  size: z
    .number()
    .int()
    .positive('fichier vide')
    .max(ATTACHMENT_MAX_BYTES, 'fichier trop volumineux (20 Mo au maximum)'),
  type: z.string().max(120),
});

/** Documented aliases of the official CLI (`/model <alias>`, `--model`). */
export const COMPOSER_MODEL_ALIASES = [
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
] as const;

export interface ComposerModelOption {
  value: string;
  label: string;
  description: string;
}

/** Aliases first, then the models the CLI reported in past sessions of the space. */
export function composerModelOptions(
  seen: ReadonlyArray<{ id: string; displayName: string | null }>,
): ComposerModelOption[] {
  const options: ComposerModelOption[] = COMPOSER_MODEL_ALIASES.map((alias) => ({
    value: alias.value,
    label: alias.label,
    description: `/model ${alias.value}`,
  }));
  const known = new Set<string>(options.map((o) => o.value));
  for (const model of seen) {
    if (known.has(model.id)) continue;
    known.add(model.id);
    options.push({
      value: model.id,
      label: model.displayName ?? model.id,
      description: `/model ${model.id}`,
    });
  }
  return options;
}

/** MCP server of the project, as the palette offers it (tools from its last diagnostic, if any). */
export interface ComposerMcpServer {
  name: string;
  label: string;
  tools: string[];
}

export interface ComposerPaletteData {
  /** null when the server could not list them (`skillsError` says why). */
  skills: SessionSkill[] | null;
  skillsError: string | null;
  mcp: ComposerMcpServer[];
  models: ComposerModelOption[];
}

/** Labels of the mode chip (capitalised as in « Nouvelle session »). */
export const COMPOSER_MODE_LABELS: Record<PermissionModeValue, string> = {
  manual: "Demander avant d'agir",
  acceptEdits: 'Accepter les modifications',
  plan: 'Planifier sans modifier',
  auto: 'Automatique',
  dontAsk: 'Refuser sans demander',
  bypassPermissions: 'Sans autorisation',
};

/** Short chip text (phone and narrow desktop columns). */
export const COMPOSER_MODE_SHORT: Record<PermissionModeValue, string> = {
  manual: 'Demander',
  acceptEdits: 'Modifications',
  plan: 'Plan',
  auto: 'Auto',
  dontAsk: 'Refuser',
  bypassPermissions: 'Sans autorisation',
};

export const COMPOSER_MODE_HINTS: Record<SwitchablePermissionMode, string> = {
  manual: 'Claude demande avant chaque modification ou commande.',
  acceptEdits: 'Les modifications de fichiers passent, les commandes sont demandées.',
  plan: 'Claude lit et propose un plan, sans rien modifier.',
  auto: 'Le CLI décide seul de ce qui demande une autorisation (si ce mode est proposé).',
};

export const SWITCHABLE_MODES: readonly SwitchablePermissionMode[] = [
  'manual',
  'acceptEdits',
  'plan',
  'auto',
];
