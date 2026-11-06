/**
 * Tabs of Paramètres (D08 `Onglets`) and their URL slugs (overview.md §6: `?onglet=` = the 5 D08 tab
 * names). `CLAUDE_RECONNECT_HREF` (shell, T6) = `/parametres?onglet=claude-code&action=reconnexion`.
 */
export const SETTINGS_TABS = [
  { value: 'vue-d-ensemble', label: "Vue d'ensemble" },
  { value: 'compte-et-securite', label: 'Compte et sécurité' },
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'serveur', label: 'Serveur' },
  { value: 'preferences', label: 'Préférences' },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]['value'];

export const DEFAULT_SETTINGS_TAB: SettingsTab = 'vue-d-ensemble';

export function parseSettingsTab(value: string | string[] | null | undefined): SettingsTab {
  const raw = Array.isArray(value) ? value[0] : value;
  return SETTINGS_TABS.some((tab) => tab.value === raw) ? (raw as SettingsTab) : DEFAULT_SETTINGS_TAB;
}

/** `?onglet=` was given explicitly (the phone shows that tab as a drill-down page, M08 → detail). */
export function hasExplicitTab(value: string | string[] | null | undefined): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  return SETTINGS_TABS.some((tab) => tab.value === raw) && raw !== DEFAULT_SETTINGS_TAB;
}

export function settingsTabLabel(tab: SettingsTab): string {
  return SETTINGS_TABS.find((item) => item.value === tab)?.label ?? "Vue d'ensemble";
}

/** `?action=reconnexion` opens « Se reconnecter dans un terminal » once (T6 target). */
export const RECONNECT_ACTION = 'reconnexion';

/** Anchors inside tabs (`#journal-de-securite` from M08 « Journal de sécurité » and D08 « Tout voir »). */
export const SECTION_IDS = {
  twoFactor: 'double-facteur',
  passkeys: 'cles-d-acces',
  password: 'mot-de-passe',
  sessions: 'acces-ouverts',
  journal: 'journal-de-securite',
  gitIdentity: 'identite-git',
  services: 'etat-du-serveur',
  worktrees: 'worktrees-inactifs',
  logs: 'journaux',
} as const;

export function settingsHref(tab: SettingsTab, section?: string): string {
  const query = tab === DEFAULT_SETTINGS_TAB ? '' : `?onglet=${tab}`;
  return `/parametres${query}${section ? `#${section}` : ''}`;
}
