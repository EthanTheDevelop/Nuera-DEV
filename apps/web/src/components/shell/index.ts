// App shell of Nuera Dev (navigation, global states, palette). Inventory: ../README.md
export { AppShell, type AppShellProps } from './AppShell';
export {
  CommandPalette,
  CommandRegistryProvider,
  useCommandPaletteShortcut,
  useRegisterCommands,
  useRegisterSearchProvider,
  type CommandGroupDef,
  type CommandItem,
  type CommandPaletteProps,
  type CommandSearchProvider,
} from './CommandPalette';
export {
  ClaudeDisconnected,
  ClaudeDisconnectedBanner,
  ConnectionLostBanner,
  Delayed,
  ServerUnavailable,
  type ClaudeDisconnectedProps,
  type ConnectionLostBannerProps,
  type Fact,
  type ServerUnavailableProps,
} from './GlobalStates';
export { activeNavKey, CLAUDE_RECONNECT_HREF, hidesTabBar, NAV_ITEMS, type NavItem, type NavKey } from './nav-items';
export { NotificationBell, NotificationList, type NotificationBellProps, type NotificationListProps } from './NotificationBell';
export { PageHeader, type PageHeaderProps } from './PageHeader';
export { ServerCard, type ServerCardProps } from './ServerCard';
export { ShellAvailability, availabilitySentence } from './ShellAvailability';
export { ShellDataProvider, useCommandPaletteControl, useOptionalShellData, useShellData } from './ShellContext';
export { Sidebar, type SidebarProps } from './Sidebar';
export { SidebarRail, type SidebarRailProps } from './SidebarRail';
export { claudeLine, formatServerMetrics, lastContactText, serverLabel, serverTone } from './status-text';
export { TabBar, type TabBarProps } from './TabBar';
export * from './types';
export { UserCard, type UserCardProps } from './UserCard';
export { UserMenu, type UserMenuProps } from './UserMenu';
