/**
 * Pure wording helpers of Paramètres (tested in copy.test.ts). French, straight apostrophe, « · ».
 * Dates and numbers through @nuera/shared/format (fr-FR, Europe/Paris); invalid dates never throw.
 */
import type { PermissionMode } from '@nuera/db/schema';
import {
  formatDuration,
  formatPercent,
  formatRelative,
  formatShortDate,
  formatTime,
  parisDayKey,
  plural,
} from '@nuera/shared/format';
import type { BadgeTone } from '@/components/ui';
import type {
  ClaudeCliView,
  LiveSessionsView,
  RunnerHealthView,
  SeenModel,
  StaleWorktreesView,
  UptimeView,
  WebSessionView,
} from './types';

type DateInput = Date | string | number;

export function isValidDate(value: DateInput | null | undefined): value is DateInput {
  if (value === null || value === undefined || value === '') return false;
  const date = value instanceof Date ? value : new Date(value);
  return !Number.isNaN(date.getTime());
}

function safe(value: DateInput | null | undefined, format: (value: DateInput) => string, fallback = ''): string {
  return isValidDate(value) ? format(value) : fallback;
}

// ---------------------------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------------------------

/** « Max », « Pro » — the plan exactly as the CLI reports it, capitalised; null when not reported. */
export function planLabel(subscriptionType: string | null | undefined): string | null {
  const value = subscriptionType?.trim();
  if (!value) return null;
  const known: Record<string, string> = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise', free: 'Free' };
  return known[value.toLowerCase()] ?? value;
}

/** Authentication method printed by `claude auth status --json`. */
export function authMethodLabel(method: string | null | undefined): string {
  switch (method) {
    case 'claude.ai':
      return 'Compte Claude (claude.ai)';
    case 'api_key':
      return 'Clé API';
    case 'oauth_token':
      return 'Jeton OAuth';
    case 'api_key_helper':
      return 'Assistant de clé API';
    case 'third_party':
      return 'Fournisseur tiers';
    case 'none':
    case null:
    case undefined:
    case '':
      return 'Aucune';
    default:
      return method;
  }
}

export interface BadgeCopy {
  tone: BadgeTone;
  label: string;
}

/** D08 Badge Succes `Connecté · formule Max` (desktop) / M08 `Connecté · Max` (phone). */
export function claudeBadge(view: ClaudeCliView | null, variant: 'desktop' | 'phone' = 'desktop'): BadgeCopy {
  if (!view) return { tone: 'neutral', label: 'État inconnu' };
  const plan = planLabel(view.subscriptionType);
  switch (view.state) {
    case 'connected':
      return { tone: 'success', label: plan ? (variant === 'phone' ? `Connecté · ${plan}` : `Connecté · formule ${plan}`) : 'Connecté' };
    case 'disconnected':
      return { tone: 'warn', label: 'Déconnecté' };
    case 'wrong_method':
      return { tone: 'warn', label: 'Mauvaise méthode' };
    case 'not_installed':
      return { tone: 'danger', label: 'CLI absent' };
    case 'error':
      return { tone: 'warn', label: 'État illisible' };
  }
}

/** One sentence explaining a non-connected state (shown under the tile description). */
export function claudeStateNote(view: ClaudeCliView, serverName: string): string | null {
  switch (view.state) {
    case 'connected':
      return null;
    case 'disconnected':
      return "Le CLI officiel signale une connexion expirée. Les sessions en cours s'arrêteront à leur prochaine requête.";
    case 'wrong_method':
      return `Le CLI est connecté par ${authMethodLabel(view.authMethod).toLowerCase()} et non par votre compte Claude : reconnectez-le avec claude auth login.`;
    case 'not_installed':
      return `Le CLI officiel claude est introuvable sur ${serverName}.`;
    case 'error':
      return view.error ? `État du CLI illisible : ${view.error}` : 'État du CLI illisible.';
  }
}

// ---------------------------------------------------------------------------------------------
// Réglages du CLI
// ---------------------------------------------------------------------------------------------

export const CLI_DEFAULT = '__cli__';

const PERMISSION_LONG: Record<PermissionMode, string> = {
  manual: "Demander avant d'agir",
  acceptEdits: 'Accepter les modifications',
  plan: 'Planifier sans modifier',
  auto: 'Automatique',
  dontAsk: 'Refuser sans demander',
  bypassPermissions: 'Sans autorisation',
};

const PERMISSION_SHORT: Record<PermissionMode, string> = {
  manual: 'Demander',
  acceptEdits: 'Accepter',
  plan: 'Planifier',
  auto: 'Automatique',
  dontAsk: 'Refuser',
  bypassPermissions: 'Sans autorisation',
};

const PERMISSION_DESCRIPTIONS: Record<PermissionMode, string> = {
  manual: 'Chaque modification et chaque commande attend votre accord.',
  acceptEdits: 'Les modifications de fichiers passent, les commandes demandent.',
  plan: 'Claude lit et propose un plan, sans rien modifier.',
  auto: 'Le CLI décide seul de ce qui demande un accord.',
  dontAsk: "Tout ce qui n'est pas déjà autorisé est refusé sans question.",
  bypassPermissions: 'Contourne toutes les demandes.',
};

export const PERMISSION_MODE_ORDER: readonly PermissionMode[] = ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];

export function permissionModeLong(mode: PermissionMode): string {
  return PERMISSION_LONG[mode] ?? mode;
}

export function permissionModeShort(mode: PermissionMode): string {
  return PERMISSION_SHORT[mode] ?? mode;
}

/** Options of « Mode de permission »: the bypass mode is never offered while it is blocked. */
export function permissionModeOptions(blockBypass: boolean) {
  return PERMISSION_MODE_ORDER.filter((mode) => !(blockBypass && mode === 'bypassPermissions')).map((mode) => ({
    value: mode,
    label: PERMISSION_LONG[mode],
    description: PERMISSION_DESCRIPTIONS[mode],
  }));
}

/** Model aliases documented by the official CLI (`--model`). */
const CLI_MODEL_ALIASES = [
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
] as const;

export const MODEL_OTHER = '__autre__';

/**
 * « Modèle par défaut »: Défaut du CLI, the CLI's documented aliases, the models the CLI reported in
 * past sessions' status lines, the current custom value, then « Autre modèle… » (free entry).
 */
export function modelOptions(current: string | null, seen: readonly SeenModel[]) {
  const options: Array<{ value: string; label: string; description?: string }> = [
    { value: CLI_DEFAULT, label: 'Défaut du CLI', description: 'aucun --model' },
  ];
  const known = new Set<string>();
  for (const alias of CLI_MODEL_ALIASES) {
    options.push({ value: alias.value, label: alias.label, description: `--model ${alias.value}` });
    known.add(alias.value);
  }
  for (const model of seen) {
    if (known.has(model.id)) continue;
    known.add(model.id);
    options.push({ value: model.id, label: model.displayName ?? model.id, description: `--model ${model.id}` });
  }
  if (current && !known.has(current)) options.push({ value: current, label: current, description: `--model ${current}` });
  options.push({ value: MODEL_OTHER, label: 'Autre modèle…', description: 'alias ou identifiant' });
  return options;
}

export function modelLabel(current: string | null, seen: readonly SeenModel[]): string {
  if (!current) return 'Défaut du CLI';
  const alias = CLI_MODEL_ALIASES.find((item) => item.value === current);
  if (alias) return alias.label;
  return seen.find((model) => model.id === current)?.displayName ?? current;
}

/** `--effort` levels accepted by the CLI. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const EFFORT_LABELS: Record<string, string> = { low: 'Faible', medium: 'Moyen', high: 'Élevé', xhigh: 'Très élevé', max: 'Maximal' };

export function effortOptions(current: string | null) {
  const levels: string[] = [...EFFORT_LEVELS];
  if (current && !levels.includes(current)) levels.push(current);
  return [
    { value: CLI_DEFAULT, label: 'Défaut du CLI', description: 'aucun --effort' },
    ...levels.map((level) => ({ value: level, label: EFFORT_LABELS[level] ?? level, description: `--effort ${level}` })),
  ];
}

export function effortLabel(current: string | null): string {
  if (!current) return 'Défaut du CLI';
  return EFFORT_LABELS[current] ?? current;
}

/** « 2 min », « 45 s », « 1 h 05 » for the permission wait setting. */
export function formatSeconds(seconds: number): string {
  return formatDuration(seconds * 1000);
}

// ---------------------------------------------------------------------------------------------
// Compte et sécurité
// ---------------------------------------------------------------------------------------------

/** « 8 codes de secours restants », « aucun code de secours restant », null when unreadable. */
export function backupCodesText(backupCodesRemaining: number | null): string | null {
  if (backupCodesRemaining === null) return null;
  if (backupCodesRemaining === 0) return 'aucun code de secours restant';
  return plural(backupCodesRemaining, 'code de secours restant', 'codes de secours restants');
}

/** D08 `Application d'authentification · 8 codes de secours restants`. */
export function twoFactorCaption(backupCodesRemaining: number | null): string {
  const codes = backupCodesText(backupCodesRemaining);
  return codes ? `Application d'authentification · ${codes}` : "Application d'authentification";
}

/** « dans 6 h », « dans 12 min », « dans 3 j ». */
export function formatIn(value: DateInput, now: DateInput): string {
  if (!isValidDate(value) || !isValidDate(now)) return '';
  const ms = new Date(value).getTime() - new Date(now).getTime();
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `dans ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `dans ${hours} h`;
  return `dans ${Math.round(hours / 24)} j`;
}

/**
 * D08 device caption: `Paris · maintenant`, `Lyon · hier 18:04 · expire dans 6 h`. The expiry is added
 * when less than half of the idle window is left (the access is about to close on its own).
 */
export function webSessionCaption(session: WebSessionView, now: DateInput, idleHours: number): string {
  const parts: string[] = [];
  if (session.location) parts.push(session.location);
  if (session.current) {
    // This request is the activity: « maintenant », as in D08.
    parts.push('maintenant');
  } else if (isValidDate(session.lastActiveAt)) {
    const days = dayDiff(session.lastActiveAt, now);
    parts.push(days === 1 ? `hier ${formatTime(session.lastActiveAt)}` : formatRelative(session.lastActiveAt, now));
  }
  if (!session.current && isValidDate(session.expiresAt) && isValidDate(now)) {
    const left = new Date(session.expiresAt).getTime() - new Date(now).getTime();
    if (left > 0 && left <= (idleHours * 3_600_000) / 2) parts.push(`expire ${formatIn(session.expiresAt, now)}`);
  }
  return parts.join(' · ');
}

function dayDiff(value: DateInput, now: DateInput): number {
  const a = parisDayKey(value);
  const b = parisDayKey(now);
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Journal date as in D08: `10:42` today, `hier 18:04`, then `2 nov.`. */
export function formatJournalDate(value: DateInput, now: DateInput): string {
  if (!isValidDate(value) || !isValidDate(now)) return '';
  const days = dayDiff(value, now);
  if (days <= 0) return formatTime(value);
  if (days === 1) return `hier ${formatTime(value)}`;
  return formatShortDate(value, now);
}

/** D08 `Un accès expire après 12 h d'inactivité, et au plus tard après 30 jours.` */
export function accessPolicyText(idleHours: number, maxDays: number): string {
  return `Un accès expire après ${idleHours} h d'inactivité, et au plus tard après ${plural(maxDays, 'jour')}.`;
}

// ---------------------------------------------------------------------------------------------
// Serveur
// ---------------------------------------------------------------------------------------------

export type ServiceTone = 'success' | 'warn' | 'danger' | 'neutral';

export interface ServiceRow {
  key: string;
  tone: ServiceTone;
  title: string;
  caption: string;
}

/** `2 processus tmux · crm-core, devis-pdf` */
export function liveSessionsCaption(live: LiveSessionsView, backend: 'tmux' | 'pty' | null): string {
  const kind = backend === 'pty' ? 'PTY' : 'tmux';
  if (live.count === 0) return `aucun processus ${kind} en cours`;
  const head = `${plural(live.count, `processus ${kind}`, `processus ${kind}`)}`;
  return live.names.length ? `${head} · ${live.names.join(', ')}` : head;
}

/** `en ligne · redémarrée il y a 18 j` */
export function webCaption(startedAt: DateInput, now: DateInput): string {
  if (!isValidDate(startedAt)) return 'en ligne';
  return `en ligne · redémarrée ${relativeLong(startedAt, now)}`;
}

/** « il y a 18 j », « il y a 3 h », « il y a 12 min », « à l'instant ». */
export function relativeLong(value: DateInput, now: DateInput): string {
  if (!isValidDate(value) || !isValidDate(now)) return '';
  const ms = new Date(now).getTime() - new Date(value).getTime();
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return `il y a ${Math.round(hours / 24)} j`;
}

/** Services shown under « Serveur VPS-3 », from what the runner and the web process report. */
export function serviceRows(input: {
  health: RunnerHealthView | null;
  live: LiveSessionsView | null;
  webStartedAt: string;
  now: DateInput;
  runnerUnavailable: boolean;
  detailed?: boolean;
}): ServiceRow[] {
  const { health, live, now } = input;
  const rows: ServiceRow[] = [];
  if (input.runnerUnavailable || !health) {
    rows.push({ key: 'sessions', tone: 'danger', title: 'Sessions Claude Code', caption: 'état inconnu : le runner ne répond pas' });
  } else {
    rows.push({
      key: 'sessions',
      tone: health.claude.available ? 'success' : 'danger',
      title: 'Sessions Claude Code',
      caption: live ? liveSessionsCaption(live, health.backend) : `backend ${health.backend === 'pty' ? 'PTY' : 'tmux'}`,
    });
  }
  rows.push({ key: 'web', tone: 'success', title: 'Application Nuera Dev', caption: webCaption(input.webStartedAt, now) });
  if (health && !input.runnerUnavailable) {
    rows.push({
      key: 'runner',
      tone: health.ok ? 'success' : 'warn',
      title: "Runner d'exécution",
      caption: `version ${health.version} · démarré ${relativeLong(health.startedAt, now)}`,
    });
    rows.push({
      key: 'database',
      tone: health.database.ok ? 'success' : 'danger',
      title: 'Base de données',
      caption: health.database.ok ? 'PostgreSQL joignable par le runner' : `injoignable : ${health.database.error ?? 'erreur inconnue'}`,
    });
    if (input.detailed) {
      rows.push({
        key: 'claude',
        tone: health.claude.available ? 'success' : 'danger',
        title: 'CLI Claude Code',
        caption: health.claude.available ? `version ${health.claude.version ?? 'inconnue'}` : (health.claude.error ?? 'introuvable'),
      });
      rows.push({
        key: 'git',
        tone: health.git.available ? 'success' : 'danger',
        title: 'Git',
        caption: health.git.available ? (health.git.version ?? 'disponible') : (health.git.error ?? 'introuvable'),
      });
      rows.push({
        key: 'backend',
        tone: health.backend === 'tmux' ? 'success' : 'warn',
        title: 'Persistance des sessions',
        caption:
          health.backend === 'tmux'
            ? `tmux${health.tmux.version ? ` · ${health.tmux.version}` : ''} : une coupure réseau n'arrête pas les sessions`
            : 'PTY direct : un redémarrage du runner interrompt les sessions (tmux absent)',
      });
    }
  } else {
    rows.push({ key: 'runner', tone: 'danger', title: "Runner d'exécution", caption: 'ne répond pas' });
  }
  return rows;
}

/** D08 Badge `En ligne` of « Serveur VPS-3 ». */
export function serverBadge(health: RunnerHealthView | null, unavailable: boolean): BadgeCopy {
  if (unavailable || !health) return { tone: 'danger', label: 'Hors ligne' };
  if (!health.ok || !health.database.ok) return { tone: 'warn', label: 'Dégradé' };
  return { tone: 'success', label: 'En ligne' };
}

const AVAILABILITY_FORMAT = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });

/** `99,95 %` (two decimals at most, as in Figma). */
export function formatAvailability(percent: number | null): string {
  if (percent === null) return '—';
  const value = Math.floor(percent * 100) / 100;
  return `${AVAILABILITY_FORMAT.format(value).replace(/[\u00a0\u202f]/g, ' ')} %`;
}

/** Bars of `UptimeBars` (0–1 ratios; incident days drawn warn). */
export function uptimeBarDays(uptime: UptimeView) {
  return uptime.days.map((day) => ({
    date: day.day,
    availability: day.availability === null ? null : day.availability / 100,
    incident: day.incidents.length > 0 || (day.availability !== null && day.availability < 100),
    ...(day.incidents[0] ? { note: lowerFirst(day.incidents[0].reason) } : {}),
  }));
}

/**
 * Caption under the bars, from the last incident reported by the runner: `28 oct. · runner indisponible
 * (arrêt ou redémarrage), 2 min d'indisponibilité.` — or the honest « nothing measured » sentence.
 */
export function uptimeCaption(uptime: UptimeView, now: DateInput): string {
  const incidents = uptime.days.flatMap((day) => day.incidents);
  const last = incidents
    .filter((incident) => isValidDate(incident.start))
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start))[0];
  if (last) {
    const end = last.end && isValidDate(last.end) ? Date.parse(last.end) : null;
    const duration = end ? `, ${formatDuration(Math.max(0, end - Date.parse(last.start)))} d'indisponibilité` : ', en cours';
    return `${safe(last.start, (v) => formatShortDate(v, now))} · ${lowerFirst(last.reason)}${duration}.`;
  }
  const measured = uptime.days.filter((day) => day.availability !== null);
  if (measured.length === 0) return 'Aucune mesure pour le moment : le runner enregistre un battement par minute.';
  const first = measured[0]!;
  return measured.length < uptime.days.length
    ? `Mesurée depuis le ${formatShortDate(`${first.day}T12:00:00Z`, now)}, sans indisponibilité relevée.`
    : 'Aucune indisponibilité relevée sur la période.';
}

function lowerFirst(text: string): string {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/** `3 worktrees sans session depuis 30 jours` */
export function staleWorktreesCaption(view: StaleWorktreesView): string {
  const count = view.items.length;
  if (count === 0) return `aucun worktree sans session depuis ${plural(view.staleDays, 'jour')}`;
  return `${plural(count, 'worktree')} sans session depuis ${plural(view.staleDays, 'jour')}`;
}

/** `Supprimer 2 worktrees` (the count follows the selected eligible items). */
export function removeWorktreesLabel(count: number): string {
  return `Supprimer ${plural(count, 'worktree')}`;
}

export function removeWorktreesTitle(count: number): string {
  return `Supprimer ${plural(count, 'worktree inactif', 'worktrees inactifs')} ?`;
}

/** « 2 fichiers non commités » */
export function dirtyFilesText(count: number): string {
  return plural(count, 'fichier non commité', 'fichiers non commités');
}

export const OPERATION_KIND_LABELS: Record<string, string> = {
  clone: 'Clonage',
  fetch: 'Récupération',
  pull: 'Synchronisation',
  push: 'Push',
  commit: 'Commit',
  checkout: 'Changement de branche',
  branch_create: 'Création de branche',
  worktree_create: 'Création de worktree',
  worktree_remove: 'Suppression de worktree',
  clone_remove: 'Suppression du clone',
  pr_create: 'Pull request',
  install: 'Installation',
  archive: 'Archivage',
  claude_md_update: 'CLAUDE.md',
  integration_check: "Vérification d'intégration",
  mcp_check: 'Vérification MCP',
  maintenance: 'Maintenance',
};

export function operationKindLabel(kind: string): string {
  return OPERATION_KIND_LABELS[kind] ?? kind;
}

export function operationStatusBadge(status: string): BadgeCopy {
  switch (status) {
    case 'succeeded':
      return { tone: 'success', label: 'Réussie' };
    case 'failed':
      return { tone: 'danger', label: 'Échouée' };
    case 'running':
      return { tone: 'accent', label: 'En cours' };
    case 'queued':
      return { tone: 'neutral', label: 'En attente' };
    case 'cancelled':
      return { tone: 'neutral', label: 'Annulée' };
    default:
      return { tone: 'neutral', label: status };
  }
}

export { formatPercent, plural };
