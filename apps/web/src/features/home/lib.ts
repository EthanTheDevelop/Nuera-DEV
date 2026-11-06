/**
 * Accueil — pure presentation helpers (copy, ordering, live patches). No I/O; tested in lib.test.ts.
 * Copy is Figma's (D01 / M01) when drawn; undrawn states use sober French sentences.
 */
import { formatNumber, formatRelative, formatUsage, plural } from '@nuera/shared/format';
import { usageLimitLabel } from '@/components/dev/lib/usage-limit';
import type { SessionStatusEvent } from '@nuera/shared/events';
import type {
  ClaudeState,
  HomeClaude,
  HomeOnboarding,
  HomePendingPermission,
  HomeServerMetrics,
  HomeSession,
  ServerAvailability,
  SessionStatus,
} from './types';

export type BadgeTone = 'accent' | 'success' | 'warn' | 'danger' | 'neutral';

/** Statuses shown in the « sessions actives » cards (same set as the sidebar bubble). */
export const HOME_ACTIVE_STATUSES: readonly SessionStatus[] = ['new', 'running', 'waiting_permission', 'waiting_input'];

export function isHomeActive(status: SessionStatus): boolean {
  return HOME_ACTIVE_STATUSES.includes(status);
}

const URGENCY: Record<SessionStatus, number> = {
  waiting_permission: 4,
  running: 3,
  waiting_input: 2,
  new: 1,
  interrupted: 0,
  failed: 0,
  stopped: 0,
  finished: 0,
  archived: -1,
};

const time = (value: string | null | undefined): number => {
  const t = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(t) ? 0 : t;
};

/** Last sign of life of a session (activity, else start, else creation). */
export function sessionRecency(session: Pick<HomeSession, 'lastActivityAt' | 'startedAt' | 'createdAt'>): number {
  return time(session.lastActivityAt) || time(session.startedAt) || time(session.createdAt);
}

/**
 * Order of the session cards: a request waiting for the owner is never hidden (most urgent first),
 * then the most recent activity.
 */
export function sortActiveSessions<T extends Pick<HomeSession, 'status' | 'lastActivityAt' | 'startedAt' | 'createdAt'>>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => URGENCY[b.status] - URGENCY[a.status] || sessionRecency(b) - sessionRecency(a));
}

/**
 * `Reprise rapide`: the active session the owner touched last — preferring one that does not already
 * wait for a permission (that one has its own alert / card) — else null (the caller then looks at
 * the history for a resumable session).
 */
export function pickQuickResume<T extends Pick<HomeSession, 'status' | 'lastActivityAt' | 'startedAt' | 'createdAt'>>(items: readonly T[]): T | null {
  if (items.length === 0) return null;
  const byRecency = [...items].sort((a, b) => sessionRecency(b) - sessionRecency(a));
  return byRecency.find((s) => s.status !== 'waiting_permission') ?? byRecency[0] ?? null;
}

/** Lower-cases the first letter of a sentence used after « · » (« Écrit les tests » → « écrit les tests »), not of an acronym. */
export function lowerFirst(text: string): string {
  const [first, second] = [text.charAt(0), text.charAt(1)];
  if (!first || (second && second === second.toUpperCase() && second !== second.toLowerCase())) return text;
  return first.toLowerCase() + text.slice(1);
}

/** `Plan 3 / 5 · écrit les tests de pipeline-totals.ts` (D01) — or the activity alone without a plan. */
export function progressLine(session: Pick<HomeSession, 'planDone' | 'planTotal' | 'currentActivity'> & { limit?: HomeSession['limit'] }): string | null {
  // Stopped by the usage limit: what the CLI announced, never a plan that no longer moves.
  const limited = usageLimitLabel(session.limit);
  if (limited) return limited;
  const activity = session.currentActivity?.trim() || null;
  const hasPlan = typeof session.planTotal === 'number' && session.planTotal > 0;
  if (hasPlan) {
    const plan = `Plan ${formatNumber(session.planDone ?? 0)} / ${formatNumber(session.planTotal!)}`;
    return activity ? `${plan} · ${lowerFirst(activity)}` : plan;
  }
  return activity;
}

/**
 * Activity line of a session card: « Attend votre accord pour npm run test -- crm » while a request
 * is pending (D01 / M01), else the runner's current activity.
 */
export function cardActivity(session: Pick<HomeSession, 'status' | 'currentActivity' | 'pendingPermission'> & { limit?: HomeSession['limit'] }): string | null {
  const limited = usageLimitLabel(session.limit);
  if (limited) return limited;
  const target = session.pendingPermission?.target?.trim();
  if (session.status === 'waiting_permission' && target) return `Attend votre accord pour ${target}`;
  return session.currentActivity?.trim() || null;
}

/** Label next to the big number of the Claude Code tile: « sessions actives sur 4 possibles ». */
export function capacityLabel(active: number, max: number): string {
  const noun = Math.abs(active) >= 2 ? 'sessions actives' : 'session active';
  return `${noun} sur ${formatNumber(max)} ${max >= 2 ? 'possibles' : 'possible'}`;
}

/** Warn line of the Claude Code tile: « Tests e2e du devis attend votre autorisation ». */
export function pendingAlert(pending: readonly Pick<HomePendingPermission, 'sessionTitle' | 'sessionId'>[]): string | null {
  if (pending.length === 0) return null;
  const sessions = new Set(pending.map((p) => p.sessionId));
  if (sessions.size === 1) return `${pending[0]!.sessionTitle} attend votre autorisation`;
  return `${formatNumber(sessions.size)} sessions attendent votre autorisation`;
}

/** Badge of the Claude Code tile. « Attention requise » (Alerte) when a request waits (Figma). */
export function claudeBadge(state: ClaudeState, pendingCount: number, server: ServerAvailability): { label: string; tone: BadgeTone } {
  if (server === 'unavailable') return { label: 'Injoignable', tone: 'neutral' };
  if (state === 'connected') return pendingCount > 0 ? { label: 'Attention requise', tone: 'warn' } : { label: 'Connecté', tone: 'success' };
  switch (state) {
    case 'disconnected':
      return { label: 'Déconnecté', tone: 'warn' };
    case 'wrong_method':
      return { label: "Clé d'API", tone: 'warn' };
    case 'not_installed':
      return { label: 'Non installé', tone: 'danger' };
    case 'error':
      return { label: 'État illisible', tone: 'warn' };
    default:
      return { label: 'Vérification…', tone: 'neutral' };
  }
}

/** « formule Max » from the CLI's `subscriptionType` (« max », « pro », « team »…). */
export function planLabel(plan: string | null): string | null {
  const value = plan?.trim();
  if (!value) return null;
  return `formule ${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

/**
 * Note of the Claude Code tile. Connected: « CLI officiel connecté au compte Claude · formule Max.
 * Nuera Dev ne stocke aucun identifiant. » (Figma), plus the default model (« défaut du CLI » when unset).
 */
export function claudeNote(claude: Pick<HomeClaude, 'state' | 'plan' | 'defaultModel'>, server: ServerAvailability): string {
  const model = `modèle : ${claude.defaultModel?.trim() || 'défaut du CLI'}`;
  if (server === 'unavailable') return `Le CLI officiel tourne sur le serveur, qui ne répond pas. Nuera Dev ne stocke aucun identifiant.`;
  switch (claude.state) {
    case 'connected': {
      const plan = planLabel(claude.plan);
      return `CLI officiel connecté au compte Claude${plan ? ` · ${plan}` : ''} · ${model}. Nuera Dev ne stocke aucun identifiant.`;
    }
    case 'disconnected':
      return "Le CLI officiel signale une connexion expirée. Les sessions en cours s'arrêteront à leur prochaine requête.";
    case 'wrong_method':
      return "Le CLI est connecté par une clé d'API, pas par votre compte Claude : reconnectez-le dans un terminal.";
    case 'not_installed':
      return "Le CLI officiel Claude Code n'est pas installé sur le serveur.";
    case 'error':
      return "L'état du CLI n'a pas pu être lu. Nuera Dev ne stocke aucun identifiant.";
    default:
      return 'Vérification du CLI officiel en cours. Nuera Dev ne stocke aucun identifiant.';
  }
}

/** Server tile badge: « En ligne » (Figma), « Ne répond pas » (T5), « Non vérifié ». */
export function serverBadge(availability: ServerAvailability): { label: string; tone: BadgeTone } {
  if (availability === 'available') return { label: 'En ligne', tone: 'success' };
  if (availability === 'unavailable') return { label: 'Ne répond pas', tone: 'danger' };
  return { label: 'Non vérifié', tone: 'neutral' };
}

/** « 18 j », « 5 h », « 12 min » (host uptime). */
export function uptimeText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s >= 86_400) return `${formatNumber(Math.floor(s / 86_400))} j`;
  if (s >= 3_600) return `${formatNumber(Math.floor(s / 3_600))} h`;
  return `${formatNumber(Math.max(1, Math.floor(s / 60)))} min`;
}

/** Footer of the server tile: « OVH Gravelines · en ligne depuis 18 j » (T5: last contact). */
export function serverFooter(input: {
  location: string | null;
  availability: ServerAvailability;
  uptimeSec: number | null;
  lastContactAt: string | null;
  now: number;
}): string | null {
  const parts: string[] = [];
  if (input.location) parts.push(input.location);
  if (input.availability === 'available' && typeof input.uptimeSec === 'number') parts.push(`en ligne depuis ${uptimeText(input.uptimeSec)}`);
  if (input.availability === 'unavailable') {
    const valid = input.lastContactAt && !Number.isNaN(Date.parse(input.lastContactAt));
    if (valid) {
      const rel = formatRelative(input.lastContactAt!, input.now);
      parts.push(`dernier contact ${rel === 'maintenant' ? "à l'instant" : rel}`);
    } else parts.push('aucun contact récent');
  }
  return parts.length ? parts.join(' · ') : null;
}

export interface MeterValue {
  valueLabel: string;
  percent: number | null;
}

const pct = (used: number, total: number) => (total > 0 ? (used / total) * 100 : null);

/** The three gauges of the server tile (Processeur / Mémoire / Stockage); unknown → « — », empty track. */
export function serverMeters(metrics: HomeServerMetrics | null): { cpu: MeterValue; memory: MeterValue; disk: MeterValue } {
  const unknown: MeterValue = { valueLabel: '—', percent: null };
  if (!metrics) return { cpu: unknown, memory: unknown, disk: unknown };
  const disk =
    typeof metrics.diskUsedBytes === 'number' && typeof metrics.diskTotalBytes === 'number' && metrics.diskTotalBytes > 0
      ? { valueLabel: formatUsage(metrics.diskUsedBytes, metrics.diskTotalBytes), percent: pct(metrics.diskUsedBytes, metrics.diskTotalBytes) }
      : unknown;
  return {
    cpu: { valueLabel: `${formatNumber(Math.round(metrics.cpuPercent))} %`, percent: metrics.cpuPercent },
    memory: { valueLabel: formatUsage(metrics.memoryUsedBytes, metrics.memoryTotalBytes), percent: pct(metrics.memoryUsedBytes, metrics.memoryTotalBytes) },
    disk,
  };
}

/** Meter tone: warn above 80 %, danger above 92 %. */
export function meterTone(percent: number | null): 'accent' | 'warn' | 'danger' {
  if (percent === null) return 'accent';
  if (percent >= 92) return 'danger';
  if (percent >= 80) return 'warn';
  return 'accent';
}

/** « SESSIONS ACTIVES · 2 » (M01 overline). */
export function activeOverline(count: number): string {
  return `Sessions actives · ${formatNumber(count)}`;
}

/** Phone status pill of the server: « VPS-3 en ligne ». */
export function serverPill(name: string, availability: ServerAvailability): { label: string; tone: 'success' | 'danger' | 'neutral' } {
  if (availability === 'available') return { label: `${name} en ligne`, tone: 'success' };
  if (availability === 'unavailable') return { label: `${name} ne répond pas`, tone: 'danger' };
  return { label: `${name} : vérification…`, tone: 'neutral' };
}

/** Phone status pill of the CLI: « Claude Code connecté ». */
export function claudePill(state: ClaudeState, server: ServerAvailability): { label: string; tone: 'success' | 'warn' | 'danger' | 'neutral' } {
  if (server === 'unavailable') return { label: 'Claude Code injoignable', tone: 'neutral' };
  switch (state) {
    case 'connected':
      return { label: 'Claude Code connecté', tone: 'success' };
    case 'disconnected':
      return { label: 'Claude Code déconnecté', tone: 'warn' };
    case 'wrong_method':
      return { label: "Claude Code par clé d'API", tone: 'warn' };
    case 'not_installed':
      return { label: 'Claude Code non installé', tone: 'danger' };
    case 'error':
      return { label: 'Claude Code : état illisible', tone: 'warn' };
    default:
      return { label: 'Claude Code : vérification…', tone: 'neutral' };
  }
}

/** « Tests e2e du devis · Nuera OS » (M01 pending card). */
export function pendingContext(p: Pick<HomePendingPermission, 'sessionTitle' | 'projectName'>): string {
  return `${p.sessionTitle} · ${p.projectName}`;
}

/** « 3 projets » for the empty / partial states. */
export function projectCount(n: number): string {
  return plural(n, 'projet');
}

/**
 * Live patch of the session cards from a `session.status` event. Returns the new list, or `null`
 * when the event cannot be applied in place (unknown session, a session entering or leaving the
 * active set, a new pending request) and the server data must be read again.
 */
export function applySessionStatus(items: readonly HomeSession[], event: SessionStatusEvent): HomeSession[] | null {
  const index = items.findIndex((s) => s.id === event.sessionId);
  const active = isHomeActive(event.status);
  if (index === -1) return active ? null : [...items];
  const current = items[index]!;
  if (!active) return null;
  // A request appeared or changed: its target lives in the database (re-read).
  const pendingChanged = (event.pendingPermissionId ?? null) !== (current.pendingPermission?.id ?? null);
  if (pendingChanged && event.pendingPermissionId) return null;
  const next: HomeSession = {
    ...current,
    title: event.title ?? current.title,
    status: event.status,
    live: event.live,
    currentActivity: event.currentActivity,
    lastInstruction: event.lastInstruction,
    lastActivityAt: event.lastActivityAt,
    startedAt: event.startedAt,
    planDone: event.planDone,
    planTotal: event.planTotal,
    pendingPermission: event.pendingPermissionId ? current.pendingPermission : null,
    limit: event.limit !== undefined ? event.limit : current.limit,
  };
  const copy = [...items];
  copy[index] = next;
  return copy;
}

// ---------------------------------------------------------------------------------------------
// « Premiers pas » (no Figma): three steps driven by real states only
// ---------------------------------------------------------------------------------------------

/**
 * `done` · `todo` (a real negative state, with its action) · `blocked` (needs a server first) ·
 * `unknown` (the state could not be read: never presented as something to do).
 */
export type FirstStepState = 'done' | 'todo' | 'blocked' | 'unknown';

export interface FirstStep {
  id: 'claude' | 'github' | 'project';
  title: string;
  text: string;
  state: FirstStepState;
  action: { kind: 'link'; label: string; href: string; icon: string } | { kind: 'claude-login'; label: string; icon: string } | null;
}

const NEEDS_SERVER = "Disponible dès qu'un administrateur vous attribue un serveur.";

export function firstSteps(input: {
  /** Server of the space (null = none assigned). */
  server: { name: string; availability: ServerAvailability } | null;
  claudeState: ClaudeState;
  onboarding: { github: boolean | null; project: boolean };
}): FirstStep[] {
  const { server, claudeState, onboarding } = input;
  let claude: FirstStep;
  if (!server) {
    claude = { id: 'claude', title: 'Connecter Claude Code', text: NEEDS_SERVER, state: 'blocked', action: null };
  } else if (claudeState === 'connected') {
    claude = { id: 'claude', title: 'Connecter Claude Code', text: `Le CLI officiel de ${server.name} est connecté à votre compte Claude.`, state: 'done', action: null };
  } else if (server.availability !== 'unavailable' && (claudeState === 'disconnected' || claudeState === 'wrong_method')) {
    claude = {
      id: 'claude',
      title: 'Connecter Claude Code',
      text: `Connectez le CLI officiel de ${server.name} à votre compte Claude, dans un terminal. Nuera Dev ne stocke aucun identifiant.`,
      state: 'todo',
      action: { kind: 'claude-login', label: 'Se connecter dans un terminal', icon: 'terminal' },
    };
  } else {
    claude = { id: 'claude', title: 'Connecter Claude Code', text: `L'état du CLI de ${server.name} n'a pas pu être lu pour le moment.`, state: 'unknown', action: null };
  }
  const github: FirstStep =
    onboarding.github === true
      ? { id: 'github', title: 'Connecter GitHub', text: 'Une source GitHub de votre espace donne accès à vos dépôts.', state: 'done', action: null }
      : onboarding.github === false
        ? {
            id: 'github',
            title: 'Connecter GitHub',
            text: 'Reliez une application GitHub à votre espace pour choisir les dépôts à cloner.',
            state: 'todo',
            action: { kind: 'link', label: 'Ouvrir Intégrations', href: '/integrations', icon: 'github' },
          }
        : { id: 'github', title: 'Connecter GitHub', text: "L'état de GitHub n'a pas pu être lu pour le moment.", state: 'unknown', action: null };
  const project: FirstStep = onboarding.project
    ? { id: 'project', title: 'Ajouter un premier projet', text: 'Votre espace a déjà un projet.', state: 'done', action: null }
    : !server
      ? { id: 'project', title: 'Ajouter un premier projet', text: NEEDS_SERVER, state: 'blocked', action: null }
      : {
          id: 'project',
          title: 'Ajouter un premier projet',
          text: `Clonez un dépôt GitHub sur ${server.name}, prêt pour Claude Code.`,
          state: 'todo',
          action: { kind: 'link', label: 'Ajouter un projet', href: '/projets/nouveau', icon: 'plus' },
        };
  return [claude, github, project];
}

/**
 * Shown while a step is really left to do (or waits for a server); hidden once all are done, and for
 * good once the space has run a Claude Code session in a project: a set-up account keeps the Figma
 * Accueil whatever happens later (a disconnected CLI is T6, a revoked GitHub source a banner).
 */
export function firstStepsVisible(steps: readonly FirstStep[], onboarding?: Pick<HomeOnboarding, 'project' | 'session'>): boolean {
  if (onboarding?.project && onboarding.session) return false;
  return steps.some((step) => step.state === 'todo' || step.state === 'blocked');
}

/** Phone status pill when no server is assigned. */
export const NO_SERVER_PILL = { label: 'Aucun serveur attribué', tone: 'neutral' as const };
