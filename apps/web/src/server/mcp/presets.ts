import 'server-only';
import type { McpAuthKind, McpTransport } from '@nuera/db/schema';

/**
 * Built-in MCP servers (research §4–§6). Their names are reserved: a custom server cannot use them.
 * Each preset says how Claude authenticates and which tools Nuera Dev refuses (Claude Code
 * `permissions.deny` rules, which win over any allow rule).
 */

export type McpPresetId = 'figma' | 'github' | 'coolify' | 'playwright';

/** Where the credential of a server comes from. Never from a file given to Claude. */
export type McpCredentialSource =
  | 'claude_oauth' // OAuth grant held by Claude Code itself (`claude mcp login <name> --no-browser`)
  | 'github_installation' // read-only installation token for the session's repository, minted per call
  | 'coolify_token' // the Coolify integration token (read-only, development scope)
  | 'stored_headers' // headers stored encrypted in mcp_servers.secrets_encrypted (custom servers)
  | 'none';

export interface McpPermissionLine {
  label: string;
  granted: boolean;
  /** « non accordé » / « bloqué par Nuera Dev »… */
  note?: string;
}

export interface McpPreset {
  id: McpPresetId;
  label: string;
  /** Card copy (D07). */
  description: string;
  /** Drawer sub-line (D1/D2). */
  subtitle: string;
  /** Project list line (D04 « Outils MCP du projet »). */
  projectLine: string;
  icon: string;
  transport: McpTransport;
  authKind: McpAuthKind;
  credential: McpCredentialSource;
  /** Fixed URL (Coolify's is derived from the Coolify integration). */
  url?: string;
  command?: string;
  args?: string[];
  /** Non-secret headers sent as-is. */
  staticHeaders?: Record<string, string>;
  /** Claude Code permission rules added to every session where the server is enabled. */
  denyRules: string[];
  scopeNote: string;
  permissionsNote: string;
  permissions: McpPermissionLine[];
  /** French lines of the « CONFIGURATION » block (D1). */
  configurationLines: string[];
}

/** Pinned Playwright MCP version (npm `@playwright/mcp`, checked 2026-11-05). */
export const PLAYWRIGHT_MCP_VERSION = '0.0.84';

/** Figma tools that write to the canvas or create files: refused for every project (research §4.5). */
export const FIGMA_WRITE_TOOLS = [
  'use_figma',
  'generate_figma_design',
  'create_new_file',
  'upload_assets',
  'send_code_to_figma',
  'add_code_connect_map',
  'send_code_connect_mappings',
  'generate_diagram',
  'create_generative_plugin',
  'update_generative_plugin',
  'create_shader',
  'update_shader',
  'generate_image',
  'weave_run_model',
  'weave_run_tool',
  'weave_upload_asset',
  'weave_cancel_tool_run',
] as const;

/** Coolify tools that act on resources (deploy tier) — « Production hors de portée » (P4). */
export const COOLIFY_MUTATING_TOOLS = ['deploy', 'control', 'cancel_deployment', 'rollback_application'] as const;

/** GitHub MCP write tools — already hidden by X-MCP-Readonly and refused by the read-only token. */
export const GITHUB_WRITE_TOOLS = [
  'create_or_update_file',
  'delete_file',
  'push_files',
  'create_branch',
  'create_repository',
  'fork_repository',
  'create_pull_request',
  'update_pull_request',
  'merge_pull_request',
  'update_pull_request_branch',
  'pull_request_review_write',
  'create_pending_pull_request_review',
  'submit_pending_pull_request_review',
  'add_comment_to_pending_review',
  'create_issue',
  'update_issue',
  'issue_write',
  'add_issue_comment',
  'sub_issue_write',
] as const;

const deny = (server: string, tools: readonly string[]) => tools.map((tool) => `mcp__${server}__${tool}`);

export const MCP_PRESETS: Record<McpPresetId, McpPreset> = {
  figma: {
    id: 'figma',
    label: 'Figma',
    description: 'Maquettes et composants nécessaires au développement.',
    subtitle: 'Serveur MCP · lecture des maquettes et des composants',
    projectLine: 'maquettes · lecture',
    icon: 'figma',
    transport: 'http',
    authKind: 'oauth',
    credential: 'claude_oauth',
    url: 'https://mcp.figma.com/mcp',
    denyRules: deny('figma', FIGMA_WRITE_TOOLS),
    scopeNote: 'Lecture des fichiers, des composants, des variables et des styles.',
    permissionsNote: "Les droits viennent de l'autorisation donnée dans Figma, révocable depuis Figma.",
    permissions: [
      { label: 'Lire les fichiers et les composants', granted: true },
      { label: 'Lire les variables et les styles', granted: true },
      { label: 'Modifier les fichiers Figma', granted: false, note: 'non accordé' },
    ],
    configurationLines: [
      'configuration générée par Nuera Dev pour chaque session',
      'transport : HTTP distant',
      'authentification : autorisation Figma (OAuth)',
    ],
  },
  github: {
    id: 'github',
    label: 'GitHub',
    description: "Issues et pull requests, dans le périmètre de l'application.",
    subtitle: 'Serveur MCP · issues et pull requests du dépôt',
    projectLine: 'issues et pull requests du dépôt',
    icon: 'github',
    transport: 'http',
    authKind: 'bearer',
    credential: 'github_installation',
    url: 'https://api.githubcopilot.com/mcp/',
    staticHeaders: { 'X-MCP-Readonly': 'true', 'X-MCP-Toolsets': 'repos,issues,pull_requests' },
    denyRules: deny('github', GITHUB_WRITE_TOOLS),
    scopeNote: 'Le dépôt du projet uniquement, en lecture.',
    permissionsNote: "Jeton de l'application GitHub limité au dépôt de la session, en lecture, renouvelé toutes les heures.",
    permissions: [
      { label: 'Lire le code, les issues et les pull requests du dépôt', granted: true },
      { label: 'Commenter, ouvrir ou fusionner sur GitHub', granted: false, note: 'non accordé' },
    ],
    configurationLines: [
      'configuration générée par Nuera Dev pour chaque session',
      'transport : HTTP distant (lecture seule)',
      'authentification : application GitHub de Nuera Dev',
    ],
  },
  coolify: {
    id: 'coolify',
    label: 'Coolify',
    description: 'Environnements de développement. Production exclue.',
    subtitle: 'Serveur MCP · environnements de développement',
    projectLine: 'environnement de développement',
    icon: 'rocket',
    transport: 'http',
    authKind: 'bearer',
    credential: 'coolify_token',
    denyRules: deny('coolify', COOLIFY_MUTATING_TOOLS),
    scopeNote: 'Environnements de développement · journaux, variables, état des déploiements.',
    permissionsNote: 'Jeton Coolify en lecture ; déployer, arrêter ou redémarrer reste refusé à Claude.',
    permissions: [
      { label: 'Lire les applications, les journaux et les déploiements', granted: true },
      { label: 'Déployer, arrêter ou redémarrer un service', granted: false, note: 'non accordé' },
    ],
    configurationLines: [
      'configuration générée par Nuera Dev pour chaque session',
      'transport : HTTP distant',
      'authentification : jeton Coolify chiffré sur {serveur}',
    ],
  },
  playwright: {
    id: 'playwright',
    label: 'Playwright',
    description: 'Tests de bout en bout pilotés par Claude.',
    subtitle: 'Serveur MCP · navigateur de test sur {serveur}',
    projectLine: 'navigateur de test',
    icon: 'globe2',
    transport: 'stdio',
    authKind: 'none',
    credential: 'none',
    command: 'npx',
    args: ['-y', `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`, '--headless', '--isolated'],
    denyRules: [],
    scopeNote: 'Navigateur sans interface lancé sur {serveur}, profil effacé à chaque session.',
    permissionsNote: 'Aucun accès à un compte externe.',
    permissions: [{ label: 'Piloter un navigateur de test', granted: true }],
    configurationLines: [
      'configuration générée par Nuera Dev pour chaque session',
      `transport : stdio (npx @playwright/mcp@${PLAYWRIGHT_MCP_VERSION})`,
      'authentification : aucune',
    ],
  },
};

export const MCP_PRESET_IDS = Object.keys(MCP_PRESETS) as McpPresetId[];

export function isPresetName(name: string): name is McpPresetId {
  return (MCP_PRESET_IDS as string[]).includes(name);
}

export function presetOf(name: string): McpPreset | null {
  return isPresetName(name) ? MCP_PRESETS[name] : null;
}

/** Server (runner) of the space a view is built for: its name, and whether it is the default one. */
export interface PresetServerContext {
  name: string;
  isDefault: boolean;
}

/** Name used when the space has no server yet. */
export const NO_SERVER_NAME = 'votre serveur';

/**
 * Where secrets are said to be encrypted: « chiffré sur VPS-3 » for the default server (Figma copy),
 * « chiffré par Nuera Dev » elsewhere — the secrets live in the central database, not on that server.
 */
export function encryptedWhere(server: PresetServerContext | null, plural = false): string {
  const word = plural ? 'chiffrés' : 'chiffré';
  return server?.isDefault ? `${word} sur ${server.name}` : `${word} par Nuera Dev`;
}

/** Copy of a preset with `{serveur}` replaced by the server of the space (see {@link encryptedWhere}). */
export function presetText(text: string, server: PresetServerContext | null): string {
  return text
    .replace(/chiffrés sur \{serveur\}/g, encryptedWhere(server, true))
    .replace(/chiffré sur \{serveur\}/g, encryptedWhere(server))
    .replace(/\{serveur\}/g, server?.name ?? NO_SERVER_NAME);
}

/** The copy written in `mcp_servers.scope_note` before servers had names (« … sur VPS-3 … »). */
export function legacyPresetText(text: string): string {
  return text.replace(/\{serveur\}/g, 'VPS-3');
}
