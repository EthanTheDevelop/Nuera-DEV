/**
 * Pure view logic of Intégrations (D07 / M07) and of the MCP drawers (D1 / D2): every sentence is
 * built from the data of the server (accounts, counts, statuses, dates), never from Figma's sample
 * values. Tested in `model.test.ts`.
 */
import { formatRelative, formatShortDate, formatTime, parisDayKey, plural, TIME_ZONE, LOCALE } from '@nuera/shared/format';
import { ICON_NAMES, type IconName } from '@/components/icons';
import type { BadgeTone, CompactButtonVariant } from '@/components/ui';
import type { CoolifySettingsView, DiagnosticBanner, GithubStatus, IntegrationCheck, IntegrationsOverview, McpDetailContext, McpServerView } from './types';

type DateInput = Date | string | number;

const validDate = (value: DateInput | null | undefined): Date | null => {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export function iconOf(name: string | null | undefined, fallback: IconName = 'plug'): IconName {
  return name && (ICON_NAMES as readonly string[]).includes(name) ? (name as IconName) : fallback;
}

/** « a, b et c » */
export function frenchList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} et ${items.at(-1)}`;
}

// ---------------------------------------------------------------------------------------------
// GitHub tile (D07 216:2120 / M07 « GitHub »)
// ---------------------------------------------------------------------------------------------

export interface TileBadge {
  label: string;
  tone: BadgeTone;
}

export const GITHUB_STATUS_BADGES: Record<GithubStatus['status'], TileBadge> = {
  connected: { label: 'Connecté', tone: 'success' },
  expiring: { label: 'Bientôt expiré', tone: 'warn' },
  expired: { label: 'Autorisation expirée', tone: 'danger' },
  error: { label: 'Injoignable', tone: 'danger' },
  pending: { label: 'Application non installée', tone: 'warn' },
  not_configured: { label: 'Non connecté', tone: 'neutral' },
};

type GithubAccount = GithubStatus['accounts'][number];

/** « l'organisation nuera-studio (12 dépôts) » / « le compte ethanthedevelop » */
export function accountPhrase(account: Pick<GithubAccount, 'login' | 'type' | 'repoCount' | 'suspended'>): string {
  const kind = account.type === 'Organization' ? "l'organisation" : 'le compte';
  const extras = [
    typeof account.repoCount === 'number' ? plural(account.repoCount, 'dépôt') : null,
    account.suspended ? 'suspendue' : null,
  ].filter(Boolean);
  return `${kind} ${account.login}${extras.length ? ` (${extras.join(', ')})` : ''}`;
}

/** « installée sur l'organisation a (3 dépôts) et sur le compte b (2 dépôts) » */
export function installedOnSentence(accounts: ReadonlyArray<Pick<GithubAccount, 'login' | 'type' | 'repoCount' | 'suspended'>>): string {
  if (accounts.length === 0) return '';
  const phrases = accounts.map(accountPhrase);
  if (phrases.length === 1) return `installée sur ${phrases[0]}`;
  return `installée sur ${phrases.slice(0, -1).join(', sur ')} et sur ${phrases.at(-1)}`;
}

const PERMISSION_WORDS: Record<string, string> = { contents: 'contenu', pull_requests: 'pull requests', issues: 'issues', checks: 'checks', statuses: 'statuts' };
const LEVEL: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** M07 « contenu et pull requests en écriture » from the permissions actually granted. */
export function writeRightsShort(granted: Record<string, string | undefined>): string {
  const write = Object.keys(PERMISSION_WORDS).filter((key) => (LEVEL[granted[key] ?? ''] ?? 0) >= 2);
  if (write.length) return `${frenchList(write.map((key) => PERMISSION_WORDS[key]!))} en écriture`;
  const read = Object.keys(PERMISSION_WORDS).filter((key) => (LEVEL[granted[key] ?? ''] ?? 0) === 1);
  return read.length ? 'lecture seule' : 'aucun droit';
}

export interface GithubTileModel {
  badge: TileBadge;
  /** D07 description under the title. */
  description: string;
  /** M07 sub-line under « GitHub ». */
  phoneSubtitle: string;
  /** Detail boxes (null when no app is registered). */
  details: {
    repos: { value: string; caption: string };
    rights: { value: string; caption: string; warn: boolean };
    lastCheck: { at: string | null; caption: string; failing: boolean };
  } | null;
  /** M07 one-line summary (« 12 dépôts · contenu et pull requests en écriture · vérifiée il y a 6 min »), without the date. */
  phoneSummary: string | null;
  /** « Gérer l'accès » or the action GitHub requires (install, re-authorise). */
  primary: { label: string; href: string; external: boolean } | null;
  /** The connect form (no app stored yet, or only the fallback token). */
  connectForm: boolean;
  canCheck: boolean;
  repoCount: number | null;
  /** Expiry line next to the actions. */
  note: string | null;
}

export function githubTile(github: GithubStatus, now: DateInput = new Date()): GithubTileModel {
  const badge = GITHUB_STATUS_BADGES[github.status] ?? GITHUB_STATUS_BADGES.not_configured;
  const usable = github.accounts.filter((account) => !account.suspended);
  const installed = installedOnSentence(github.accounts);
  if (github.mode === 'none') {
    return {
      badge,
      description:
        "Connectez l'application GitHub de Nuera Dev : elle est créée sur GitHub en un clic, puis installée sur les comptes et les dépôts de votre choix. Aucun jeton n'est saisi à la main.",
      phoneSubtitle: 'Application GitHub de Nuera Dev',
      details: null,
      phoneSummary: null,
      primary: null,
      connectForm: true,
      canCheck: false,
      repoCount: null,
      note: null,
    };
  }
  if (github.mode === 'fallback_token') {
    const expires = validDate(github.expiresAt);
    return {
      badge,
      description:
        "Connecté par le jeton de secours du serveur, sans application GitHub. Connectez l'application GitHub de Nuera Dev pour des accès limités à chaque dépôt.",
      phoneSubtitle: 'Jeton de secours du serveur',
      details: {
        repos: { value: '—', caption: 'non compté avec un jeton de secours' },
        rights: { value: github.permissions.title, caption: github.permissions.detail, warn: false },
        lastCheck: lastCheckBox(github),
      },
      phoneSummary: `jeton de secours${github.accounts[0] ? ` · ${github.accounts[0].login}` : ''}`,
      primary: null,
      connectForm: true,
      canCheck: true,
      repoCount: null,
      note: expires ? `Expiration du jeton : ${formatShortDate(expires, now)}.` : null,
    };
  }
  // GitHub App registered.
  const description =
    github.status === 'pending'
      ? "L'application GitHub de Nuera Dev est créée mais installée sur aucun compte : installez-la pour choisir les dépôts accessibles."
      : github.status === 'connected' || github.status === 'expiring'
        ? `Connecté par l'application GitHub de Nuera Dev${installed ? `, ${installed}` : ''}. Aucun jeton n'est saisi à la main.`
        : `${github.reason ?? "L'application GitHub de Nuera Dev ne répond plus."}${installed ? ` Application ${installed}.` : ''}`;
  const selection = github.accounts.length && github.accounts.every((account) => account.repositorySelection === 'all') ? 'tous les dépôts des comptes' : "sélectionnés à l'installation";
  const missing = github.permissions.missing.length > 0;
  const repoCount = github.repoCount;
  const primary: GithubTileModel['primary'] =
    github.status === 'pending'
      ? { label: 'Installer sur GitHub', href: github.installUrl ?? '/api/integrations/github/install', external: false }
      : (github.status === 'expired' || github.status === 'error') && github.action?.url
        ? { label: github.action.label, href: github.action.url, external: /^https?:/i.test(github.action.url) }
        : github.manageAccessUrl
          ? { label: "Gérer l'accès", href: github.manageAccessUrl, external: true }
          : null;
  return {
    badge,
    description,
    phoneSubtitle: 'Application GitHub de Nuera Dev',
    details: {
      repos: { value: typeof repoCount === 'number' ? plural(repoCount, 'dépôt') : '—', caption: usable.length ? selection : 'aucun compte installé' },
      rights: missing
        ? { value: github.permissions.title, caption: 'droits à accepter sur GitHub', warn: true }
        : { value: github.permissions.title, caption: github.permissions.detail, warn: false },
      lastCheck: lastCheckBox(github),
    },
    phoneSummary: [typeof repoCount === 'number' ? plural(repoCount, 'dépôt') : null, writeRightsShort(github.permissions.granted)].filter(Boolean).join(' · '),
    primary,
    connectForm: false,
    canCheck: true,
    repoCount,
    note: "Expiration : jeton d'installation renouvelé automatiquement par GitHub.",
  };
}

function lastCheckBox(github: GithubStatus): { at: string | null; caption: string; failing: boolean } {
  const at = validDate(github.lastCheckedAt) ? github.lastCheckedAt : null;
  if (!at) return { at: null, caption: 'aucune vérification', failing: false };
  const result = github.lastCheck?.result;
  if (github.status === 'connected' || github.status === 'expiring') {
    return { at, caption: 'synchronisation sans erreur', failing: false };
  }
  return { at, caption: result?.reason ?? github.reason ?? GITHUB_STATUS_BADGES[github.status].label, failing: true };
}

// ---------------------------------------------------------------------------------------------
// ?github=<outcome> (docs/INTEGRATIONS.md §2.2)
// ---------------------------------------------------------------------------------------------

export type GithubNoticeAction = 'connect' | 'install' | 'check';

export type GithubNotice =
  | { kind: 'toast'; message: string }
  | { kind: 'banner'; tone: 'info' | 'warn' | 'danger'; title: string; body: string; action: GithubNoticeAction | null };

export const GITHUB_OUTCOMES = [
  'app_created',
  'installed',
  'updated',
  'requested',
  'state_invalid',
  'state_expired',
  'already_connected',
  'conversion_failed',
  'installation_unknown',
  'installation_failed',
  'not_connected',
] as const;
export type GithubOutcome = (typeof GITHUB_OUTCOMES)[number];

export function isGithubOutcome(value: unknown): value is GithubOutcome {
  return typeof value === 'string' && (GITHUB_OUTCOMES as readonly string[]).includes(value);
}

const ACCOUNT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** Toast (success, T3) or banner (T4 / T7 tones) for the code GitHub's return route sent back. */
export function githubNotice(outcome: GithubOutcome, account?: string | null): GithubNotice {
  const login = account && ACCOUNT_RE.test(account) ? account : null;
  switch (outcome) {
    case 'installed':
      return { kind: 'toast', message: login ? `Application GitHub installée sur ${login}` : 'Application GitHub installée' };
    case 'updated':
      return { kind: 'toast', message: login ? `Accès GitHub mis à jour pour ${login}` : 'Accès GitHub mis à jour' };
    case 'app_created':
      return { kind: 'toast', message: 'Application GitHub créée' };
    case 'requested':
      return {
        kind: 'banner',
        tone: 'info',
        title: 'Installation demandée sur GitHub',
        body: `${login ? `Un administrateur de ${login}` : 'Un administrateur du compte'} doit approuver l'installation de l'application. Les dépôts apparaîtront ici ensuite.`,
        action: null,
      };
    case 'state_invalid':
      return {
        kind: 'banner',
        tone: 'danger',
        title: 'Retour de GitHub non reconnu',
        body: "Ce retour ne correspond à aucune demande partie de ce navigateur. Rien n'a été enregistré.",
        action: 'connect',
      };
    case 'state_expired':
      return {
        kind: 'banner',
        tone: 'danger',
        title: 'Demande GitHub expirée',
        body: "Plus d'une heure s'est écoulée depuis la demande. Rien n'a été enregistré : recommencez.",
        action: 'connect',
      };
    case 'already_connected':
      return {
        kind: 'banner',
        tone: 'warn',
        title: 'Une application GitHub est déjà enregistrée',
        body: "La nouvelle application n'a pas été enregistrée. Gérez l'accès de l'application actuelle ci-dessous.",
        action: null,
      };
    case 'conversion_failed':
      return {
        kind: 'banner',
        tone: 'danger',
        title: "GitHub a refusé la création de l'application",
        body: "Le code envoyé par GitHub a expiré ou a déjà servi. Rien n'a été enregistré.",
        action: 'connect',
      };
    case 'installation_unknown':
      return {
        kind: 'banner',
        tone: 'warn',
        title: 'Installation non reconnue',
        body: "Cette installation n'a pas été demandée depuis Nuera Dev : elle est ignorée. Installez l'application depuis cette page pour autoriser un compte.",
        action: 'install',
      };
    case 'installation_failed':
      return {
        kind: 'banner',
        tone: 'danger',
        title: "L'installation n'a pas pu être vérifiée",
        body: "GitHub n'a pas confirmé l'installation. Rien n'a été modifié : vérifiez la connexion pour réessayer.",
        action: 'check',
      };
    case 'not_connected':
      return {
        kind: 'banner',
        tone: 'warn',
        title: "Aucune application GitHub n'est enregistrée",
        body: "Connectez GitHub avant d'installer l'application sur un compte.",
        action: 'connect',
      };
  }
}

// ---------------------------------------------------------------------------------------------
// MCP grid / list / drawer
// ---------------------------------------------------------------------------------------------

export const mcpHref = (name: string, extra?: string) => `/integrations/mcp/${encodeURIComponent(name)}${extra ? `?${extra}` : ''}`;

export interface CardAction {
  label: string;
  href: string;
  variant: CompactButtonVariant;
  icon?: IconName;
}

/** D07 card button: Secondaire « Configurer » / « Activer », Principal « Reconnecter » (refresh). */
export function mcpCardAction(server: Pick<McpServerView, 'name' | 'action'>, status?: McpServerView['displayStatus']): CardAction {
  const href = mcpHref(server.name);
  if (server.action.kind === 'reconnect' || (status === 'expired' && server.action.kind !== 'activate')) return { label: 'Reconnecter', href, variant: 'principal', icon: 'refresh' };
  if (server.action.kind === 'activate') return { label: 'Activer', href, variant: 'secondaire' };
  return { label: 'Configurer', href, variant: 'secondaire' };
}

export type ReconnectVia = 'coolify_token' | 'mcp_login' | 'github_app' | 'headers';

/**
 * Status shown for a server: the Coolify MCP server depends on the Coolify token, so a refused token
 * (integration `expired`) shows « Autorisation expirée » even before the MCP server is re-tested.
 */
export function effectiveMcpStatus(
  server: Pick<McpServerView, 'preset' | 'displayStatus'>,
  coolify: Pick<CoolifySettingsView, 'configured' | 'status'>,
): McpServerView['displayStatus'] {
  if (server.preset === 'coolify' && server.displayStatus !== 'disabled' && coolify.configured && coolify.status === 'expired') return 'expired';
  return server.displayStatus;
}

/** D2 (reconnect form) when the server needs the owner, D1 otherwise. */
export function drawerMode(server: Pick<McpServerView, 'status' | 'credential' | 'preset' | 'action'>, coolify: Pick<CoolifySettingsView, 'configured' | 'status'>):
  | { kind: 'reconnect'; via: ReconnectVia }
  | { kind: 'detail' } {
  if (server.preset === 'coolify' && (!coolify.configured || coolify.status === 'expired')) return { kind: 'reconnect', via: 'coolify_token' };
  if (server.status === 'expired' || server.status === 'needs_auth') {
    const via: ReconnectVia =
      server.credential === 'claude_oauth'
        ? 'mcp_login'
        : server.credential === 'coolify_token'
          ? 'coolify_token'
          : server.credential === 'github_installation'
            ? 'github_app'
            : 'headers';
    return { kind: 'reconnect', via };
  }
  return { kind: 'detail' };
}

/** « ce matin à 09:12 », « cet après-midi à 14:05 », « hier à 18:40 », « le 28 oct. à 09:12 ». */
export function expiredWhen(value: DateInput | null | undefined, now: DateInput = new Date()): string | null {
  const date = validDate(value);
  const ref = validDate(now);
  if (!date || !ref) return null;
  const time = formatTime(date);
  if (parisDayKey(date) === parisDayKey(ref)) {
    const hourPart = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, hour: 'numeric', hourCycle: 'h23' }).formatToParts(date).find((part) => part.type === 'hour');
    const hour = Number(hourPart?.value ?? 0);
    if (hour < 12) return `ce matin à ${time}`;
    if (hour < 18) return `cet après-midi à ${time}`;
    return `ce soir à ${time}`;
  }
  const yesterday = new Date(ref.getTime() - 24 * 3600_000);
  if (parisDayKey(date) === parisDayKey(yesterday)) return `hier à ${time}`;
  return `le ${formatShortDate(date, ref)} à ${time}`;
}

/** « Les sessions de A et B » (the projects where the server is enabled) or « Les sessions ». */
export function sessionsOf(server: Pick<McpServerView, 'projects'>): string {
  const names = server.projects.filter((project) => project.enabled).map((project) => project.name);
  return names.length ? `Les sessions de ${frenchList(names)}` : 'Les sessions';
}

/** D2 banner (Ton=Erreur, no action) for a server that needs reconnecting. */
export function reconnectBanner(
  server: Pick<McpServerView, 'label' | 'preset' | 'status' | 'failingSince' | 'projects' | 'lastError'>,
  coolify: Pick<CoolifySettingsView, 'configured' | 'status' | 'failingSince'>,
  now: DateInput = new Date(),
): { tone: 'danger' | 'warn' | 'info'; title: string; body: string } {
  const sessions = sessionsOf(server);
  if (server.preset === 'coolify') {
    if (!coolify.configured) {
      return {
        tone: 'info',
        title: "Coolify n'est pas encore connecté",
        body: `${sessions} n'ont pas accès aux environnements de développement tant qu'aucun jeton n'est enregistré.`,
      };
    }
    const when = expiredWhen(coolify.failingSince ?? server.failingSince, now);
    return {
      tone: 'danger',
      title: when ? `Jeton expiré ${when}` : 'Jeton expiré',
      body: `${sessions} n'ont plus accès aux environnements de développement.`,
    };
  }
  if (server.status === 'needs_auth') {
    return {
      tone: 'warn',
      title: 'Connexion requise',
      body: `Aucune autorisation n'a encore été donnée : ${sessions.charAt(0).toLowerCase()}${sessions.slice(1)} n'utilisent pas ${server.label}.`,
    };
  }
  const when = expiredWhen(server.failingSince, now);
  return {
    tone: 'danger',
    title: when ? `Autorisation expirée ${when}` : 'Autorisation expirée',
    body: `${sessions} n'ont plus accès au serveur MCP ${server.label}.`,
  };
}

/** D1 « Connexion » value, from real data only (never an invented account name). */
export function connectionValue(server: Pick<McpServerView, 'credential' | 'transport' | 'secretKeys' | 'url'>, context: Pick<McpDetailContext, 'coolify' | 'github'>): string {
  switch (server.credential) {
    case 'claude_oauth':
      return 'autorisation OAuth dans Claude Code';
    case 'github_installation': {
      const logins = context.github.accounts.filter((account) => !account.suspended).map((account) => account.login);
      return logins.length ? `application GitHub · ${logins.join(', ')}` : "application GitHub non installée";
    }
    case 'coolify_token': {
      const host = hostOf(context.coolify.baseUrl);
      return [context.coolify.tokenFingerprint ?? 'aucun jeton', host].filter(Boolean).join(' · ');
    }
    case 'stored_headers':
      return `en-têtes chiffrés · ${server.secretKeys.join(', ')}`;
    case 'none':
      return server.transport === 'stdio' ? 'commande locale, sans compte' : 'sans authentification';
  }
}

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** D1 « Dernier appel »: « il y a 3 min · Nuera OS » (+ « · échec »), or « aucun appel enregistré ». */
export function lastCallValue(lastCall: McpServerView['lastCall'], now: DateInput = new Date()): string {
  const at = validDate(lastCall?.at);
  if (!lastCall || !at) return 'aucun appel enregistré';
  return [formatRelative(at, now), lastCall.projectName || null, lastCall.ok ? null : 'échec'].filter(Boolean).join(' · ');
}

/** D1 « Vérification »: « toutes les 15 min · OK ». */
export function verificationValue(server: Pick<McpServerView, 'projectCount' | 'lastCheckedAt' | 'status' | 'badge' | 'lastCheck'>, intervalMinutes: number): string {
  const cadence = server.projectCount > 0 ? `toutes les ${intervalMinutes} min` : 'manuelle (aucun projet)';
  if (!validDate(server.lastCheckedAt)) return `${cadence} · jamais vérifié`;
  return `${cadence} · ${server.status === 'connected' ? 'OK' : server.badge.label}`;
}

/** Line under « Tester la connexion »: « Dernier test il y a 2 min · 14 outils · 85 ms ». */
export function lastTestLine(server: Pick<McpServerView, 'lastCheckedAt' | 'toolCount' | 'lastLatencyMs'>, now: DateInput = new Date()): string | null {
  const at = validDate(server.lastCheckedAt);
  if (!at) return null;
  return [
    `Dernier test ${formatRelative(at, now)}`,
    typeof server.toolCount === 'number' ? plural(server.toolCount, 'outil') : null,
    typeof server.lastLatencyMs === 'number' ? `${server.lastLatencyMs} ms` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

// ---------------------------------------------------------------------------------------------
// Coolify token expiry (D2): the API does not return it, the owner reports the one chosen in Coolify
// ---------------------------------------------------------------------------------------------

export const COOLIFY_EXPIRY_OPTIONS = [
  { value: '7', label: '7 jours' },
  { value: '30', label: '30 jours' },
  { value: '60', label: '60 jours' },
  { value: '90', label: '90 jours (conseillé)' },
  { value: '365', label: '1 an' },
  { value: 'never', label: 'Jamais' },
] as const;
export type CoolifyExpiryChoice = (typeof COOLIFY_EXPIRY_OPTIONS)[number]['value'];
export const DEFAULT_COOLIFY_EXPIRY: CoolifyExpiryChoice = '90';

export function expiryToIso(choice: string, now: DateInput = new Date()): string | null {
  if (choice === 'never') return null;
  const days = Number(choice);
  const ref = validDate(now) ?? new Date();
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(ref.getTime() + days * 24 * 3600_000).toISOString();
}

// ---------------------------------------------------------------------------------------------
// Add-server form
// ---------------------------------------------------------------------------------------------

const RESERVED = ['figma', 'github', 'coolify', 'playwright'];

/** Identifier proposed from the display name (« Sentry EU » → `sentry-eu`). */
export function slugifyServerName(label: string): string {
  const slug = label
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug;
}

/** Client-side check of the identifier (the server validates again). */
export function serverNameProblem(name: string): string | null {
  if (!name) return 'Identifiant requis.';
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) return 'Minuscules, chiffres et tirets uniquement (40 caractères au plus).';
  if (RESERVED.includes(name)) return 'Identifiant réservé à un serveur intégré.';
  return null;
}

/** Header name accepted by the registry (`X-Api-Key`). */
export function headerNameProblem(name: string): string | null {
  if (!name) return "Nom d'en-tête requis.";
  return /^[A-Za-z0-9-]{1,64}$/.test(name) ? null : "Nom d'en-tête invalide (lettres, chiffres et tirets).";
}

/** Arguments typed one per line (stdio). */
export function parseArgs(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// Diagnostics (D07 banners, M07 alert cards)
// ---------------------------------------------------------------------------------------------

/** Service label, status and icon behind a diagnostic banner. */
export function diagnosticSubject(banner: Pick<DiagnosticBanner, 'target'>, overview: Pick<IntegrationsOverview, 'github' | 'coolify' | 'mcp'>): {
  label: string;
  status: string;
  icon: IconName;
} {
  if (banner.target === 'github') return { label: 'GitHub', status: overview.github.status, icon: 'github' };
  if (banner.target === 'coolify') return { label: 'Coolify', status: overview.coolify.status, icon: 'rocket' };
  const name = banner.target.replace(/^mcp:/, '');
  const server = overview.mcp.servers.find((item) => item.name === name);
  return { label: server?.label ?? name, status: server?.displayStatus ?? 'error', icon: iconOf(server?.icon) };
}

/** T7 « après » banners use the service icon; the D07 diagnostic keeps the alert triangle. */
export function diagnosticIcon(banner: Pick<DiagnosticBanner, 'title' | 'tone' | 'target'>, overview: Pick<IntegrationsOverview, 'github' | 'coolify' | 'mcp'>): IconName {
  return banner.tone === 'danger' && banner.title.startsWith("L'accès ") ? diagnosticSubject(banner, overview).icon : 'alert';
}

/** M07 « Coolify : autorisation expirée ». */
export function phoneAlertTitle(banner: Pick<DiagnosticBanner, 'target' | 'tone' | 'title'>, overview: Pick<IntegrationsOverview, 'github' | 'coolify' | 'mcp'>): string {
  const subject = diagnosticSubject(banner, overview);
  if (banner.tone === 'warn') return `${subject.label} : autorisation bientôt expirée`;
  if (subject.status === 'expired') return `${subject.label} : autorisation expirée`;
  if (banner.title.startsWith("L'accès ")) return `${subject.label} : accès retiré`;
  return `${subject.label} : ne répond plus`;
}

// ---------------------------------------------------------------------------------------------
// Journal (« Voir le journal »)
// ---------------------------------------------------------------------------------------------

export const TRIGGER_LABELS: Record<string, string> = {
  schedule: 'automatique',
  manual: 'manuelle',
  hook: 'session',
  git_failure: 'échec Git',
  startup: 'démarrage',
  setup: 'connexion',
};

/** One readable line per step: « GET /app → 200 · 12 ms », « claude mcp get figma → échec · Runner injoignable. ». */
export function stepLine(step: IntegrationCheck['steps'][number]): string {
  const outcome = step.httpStatus ? String(step.httpStatus) : step.ok ? 'OK' : 'échec';
  return [`${step.name} → ${outcome}`, `${step.ms} ms`, step.providerMessage ?? null].filter(Boolean).join(' · ');
}

/** Raw text of a check (« sortie complète »): step lines, then the redacted raw outputs. */
export function checkRaw(check: IntegrationCheck | null): string {
  if (!check) return '';
  const lines = check.steps.map(stepLine);
  const raws = check.steps.filter((step) => step.raw).map((step) => `$ ${step.name}\n${step.raw}`);
  return [...lines, ...(raws.length ? ['', ...raws] : [])].join('\n');
}
