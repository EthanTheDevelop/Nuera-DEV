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
/** `/effort <level>` of the CLI (`auto`: back to its default; for the next launch: no --effort). */
export const effortInputSchema = z
  .object({ effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'auto'], "niveau d'effort inconnu") })
  .strict();
export type ComposerEffort = z.infer<typeof effortInputSchema>['effort'];

/** Effort chip: levels of the official CLI (`claude --help`), labels of « Nouvelle session ». */
export const COMPOSER_EFFORT_OPTIONS: ReadonlyArray<{ value: ComposerEffort; label: string; description: string }> = [
  { value: 'auto', label: 'Défaut du CLI', description: '/effort auto' },
  { value: 'low', label: 'Faible', description: '/effort low' },
  { value: 'medium', label: 'Moyen', description: '/effort medium' },
  { value: 'high', label: 'Élevé', description: '/effort high' },
  { value: 'xhigh', label: 'Très élevé', description: '/effort xhigh' },
  { value: 'max', label: 'Maximal', description: '/effort max' },
];

/**
 * What the effort chip shows: the effort the CLI reports (status line `effort.level`, hooks, its
 * « Set effort level to … » line), else the `--effort` of the next launch (« · au démarrage »), else
 * « Effort du CLI » — never a guess.
 */
export function effortChipLabel(input: { reported: string | null | undefined; launch: string | null; live: boolean }): string {
  const label = (value: string) => COMPOSER_EFFORT_OPTIONS.find((o) => o.value === value)?.label ?? value;
  if (input.reported) return `Effort ${label(input.reported).toLowerCase()}`;
  if (input.launch) return input.live ? `Effort ${label(input.launch).toLowerCase()} · demandé` : `Effort ${label(input.launch).toLowerCase()} · au démarrage`;
  return 'Effort du CLI';
}

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
