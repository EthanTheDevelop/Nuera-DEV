// App shell of Nuera Dev (navigation, global states, palette). Inventory: ../README.md
export { AppShell, type AppShellProps } from './AppShell';
export {
  administrationGroup,
  CommandPalette,
  CommandRegistryProvider,
  useCommandPaletteShortcut,
  useRegisterCommands,
  useRegisterSearchProvider,
  type CommandGroupDef,
  type CommandItem,
  type CommandPaletteProps,
  type CommandSearchProvider,
  navigationGroup,
} from './CommandPalette';
export {
  ClaudeDisconnected,
  ClaudeDisconnectedBanner,
  ConnectionLostBanner,
  Delayed,
  NoServerAssigned,
  ServerUnavailable,
  ServerUnavailableBanner,
  type ClaudeDisconnectedProps,
  type ConnectionLostBannerProps,
  type Fact,
  type NoServerAssignedProps,
  type ServerUnavailableBannerProps,
  type ServerUnavailableProps,
} from './GlobalStates';
export {
  activeNavKey,
  ADMIN_NAV_ITEM,
  CLAUDE_RECONNECT_HREF,
  hidesTabBar,
  isAdminRole,
  isRunnerIndependentPage,
  NAV_ITEMS,
  navItemsFor,
  tabBarActiveKey,
  type NavItem,
  type NavKey,
} from './nav-items';
export { NotificationBell, NotificationList, type NotificationBellProps, type NotificationListProps } from './NotificationBell';
export { PageHeader, type PageHeaderProps } from './PageHeader';
export { ServerCard, type ServerCardProps } from './ServerCard';
export { ShellAvailability, availabilitySentence } from './ShellAvailability';
export {
  ShellDataProvider,
  useCommandPaletteControl,
  useIsInstanceAdmin,
  useOptionalShellData,
  useServerName,
  useShellData,
  useShellEnvironment,
} from './ShellContext';
export { Sidebar, type SidebarProps } from './Sidebar';
export { SidebarRail, type SidebarRailProps } from './SidebarRail';
export {
  claudeLine,
  formatServerMetrics,
  lastContactText,
  NO_SERVER_DETAIL,
  NO_SERVER_LABEL,
  NO_SERVER_MESSAGE,
  ROLE_LABELS,
  roleLine,
  serverLabel,
  serverTone,
} from './status-text';
export { TabBar, type TabBarProps } from './TabBar';
export * from './types';
export { UserCard, type UserCardProps } from './UserCard';
export { UserMenu, type UserMenuProps } from './UserMenu';
