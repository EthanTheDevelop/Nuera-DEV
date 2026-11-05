/**
 * Pure logic of the « Nouvelle session » dialog (tested in form.test.ts): branch suggestion and
 * validation, option lists, request body.
 */
import { isValidBranchName, slugify, worktreeNameFromBranch } from '@nuera/shared/paths';
import {
  DEFAULT_SESSION_TITLE,
  PERMISSION_MODE_VALUES,
  type BranchMode,
  type CreateSessionInput,
  type PermissionMode,
  type ProjectBranchOptions,
} from './contract';

/** Sentinel of the « Défaut du CLI » option (Radix Select refuses an empty value). */
export const CLI_DEFAULT = '__cli';

/** French labels of the permission modes, capitalised as in D08 (« Demander avant d'agir »). */
export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  manual: "Demander avant d'agir",
  acceptEdits: 'Accepter les modifications',
  plan: 'Planifier sans modifier',
  auto: 'Automatique',
  dontAsk: 'Refuser sans demander',
  bypassPermissions: 'Sans autorisation',
};

const PERMISSION_MODE_HINTS: Record<PermissionMode, string> = {
  manual: 'Claude demande avant chaque modification ou commande.',
  acceptEdits: 'Les modifications de fichiers passent, les commandes sont demandées.',
  plan: 'Claude lit et propose un plan, sans rien modifier.',
  auto: 'Le CLI décide seul de ce qui demande une autorisation.',
  dontAsk: "Tout ce qui n'est pas déjà autorisé est refusé, sans demande.",
  bypassPermissions: 'Aucune demande : toutes les actions sont autorisées.',
};

export const BYPASS_BLOCKED_REASON = 'Bloqué dans Paramètres · Claude Code.';

export function permissionModeOptions(blockBypass: boolean) {
  return PERMISSION_MODE_VALUES.map((mode) => ({
    value: mode,
    label: PERMISSION_MODE_LABELS[mode],
    description: mode === 'bypassPermissions' && blockBypass ? BYPASS_BLOCKED_REASON : PERMISSION_MODE_HINTS[mode],
    disabled: mode === 'bypassPermissions' && blockBypass,
  }));
}

/** `--effort` levels accepted by the CLI. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const EFFORT_LABELS: Record<string, string> = { low: 'Faible', medium: 'Moyen', high: 'Élevé', xhigh: 'Très élevé', max: 'Maximal' };

export function effortOptions(current: string | null) {
  const levels: string[] = [...EFFORT_LEVELS];
  if (current && !levels.includes(current)) levels.push(current);
  return [
    { value: CLI_DEFAULT, label: 'Défaut du CLI' },
    ...levels.map((level) => ({ value: level, label: EFFORT_LABELS[level] ?? level, description: `--effort ${level}` })),
  ];
}

/** `feature/<titre>` from the session title (nothing when the title is still the default). */
export function suggestBranchName(title: string): string {
  const trimmed = title.trim();
  if (!trimmed || trimmed === DEFAULT_SESSION_TITLE) return '';
  const slug = slugify(trimmed, 48);
  return slug === 'x' ? '' : `feature/${slug}`;
}

/** French error of a new-branch name, or null when it can be created. */
export function newBranchError(name: string, branches: ProjectBranchOptions['branches'] | null): string | null {
  const value = name.trim();
  if (!value) return 'Nom de branche requis.';
  if (!isValidBranchName(value)) return 'Nom de branche invalide : ni espace, ni « .. », ni ~ ^ : ? * [ \\.';
  if (branches?.some((b) => b.name === value)) return 'Cette branche existe déjà : choisissez « Branche existante ».';
  return null;
}

export function worktreeHint(branch: string, base: string): string | null {
  const value = branch.trim();
  if (!value || !isValidBranchName(value)) return null;
  return `Worktree ${worktreeNameFromBranch(value)} créé depuis ${base}.`;
}

export const BRANCH_MODE_ITEMS: ReadonlyArray<{ value: BranchMode; label: string; short: string }> = [
  { value: 'new', label: 'Nouvelle branche', short: 'Nouvelle' },
  { value: 'existing', label: 'Branche existante', short: 'Existante' },
  { value: 'primary', label: 'Worktree principal', short: 'Principal' },
];

/** Default branch mode of a project (`options.worktreePerSession`, D03 « Un worktree par session »). */
export function defaultBranchMode(worktreePerSession: boolean): BranchMode {
  return worktreePerSession ? 'new' : 'primary';
}

/** Existing branches offered by the dialog: reusable ones first, busy ones disabled with the reason. */
export function existingBranchOptions(options: ProjectBranchOptions | null, primaryBusy: boolean) {
  if (!options) return [];
  return options.branches.map((branch) => {
    const busy = Boolean(branch.busySessionId) || (branch.current && !branch.worktreeName && primaryBusy);
    const description = busy
      ? 'Une session tourne déjà sur cette branche'
      : branch.worktreeName
        ? `worktree ${branch.worktreeName}`
        : branch.current
          ? 'clone principal'
          : branch.kind === 'remote'
            ? 'sur origin · nouveau worktree'
            : 'nouveau worktree';
    return { value: branch.name, label: branch.name, description, disabled: busy };
  });
}

export interface NewSessionFormState {
  projectId: string;
  title: string;
  mode: BranchMode;
  newBranch: string;
  base: string;
  existingBranch: string;
  permissionMode: PermissionMode;
  model: string;
  effort: string;
  remoteControl: boolean;
  instruction: string;
}

export function toCreateInput(state: NewSessionFormState): CreateSessionInput {
  const branch =
    state.mode === 'new'
      ? { mode: 'new' as const, branch: state.newBranch.trim(), ...(state.base ? { base: state.base } : {}) }
      : state.mode === 'existing'
        ? { mode: 'existing' as const, branch: state.existingBranch }
        : { mode: 'primary' as const };
  return {
    projectId: state.projectId,
    title: state.title.trim() || DEFAULT_SESSION_TITLE,
    branch,
    permissionMode: state.permissionMode,
    model: state.model.trim() === '' ? null : state.model.trim(),
    effort: state.effort === CLI_DEFAULT ? null : state.effort,
    remoteControl: state.remoteControl,
    ...(state.instruction.trim() ? { instruction: state.instruction } : {}),
  };
}

/** « 2 sessions actives sur 4 possibles » (D01 wording). */
export function capacityLine(active: number, max: number): string {
  return `${active} ${active >= 2 ? 'sessions actives' : 'session active'} sur ${max} ${max >= 2 ? 'possibles' : 'possible'}`;
}

export function capacityFullReason(active: number, max: number): string {
  return `Capacité atteinte : ${active} sur ${max}. Arrêtez une session avant d'en démarrer une autre.`;
}
