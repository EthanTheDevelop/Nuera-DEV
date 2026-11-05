// Nuera Dev composites (Figma section 04 « CRÉÉS POUR NUERA DEV » and the D/M/W/S screen parts built
// from them). Presentational only: props in, callbacks out, no data fetching. Inventory: ./README.md

// Conversation (Workspace · fil de session)
export { InstructionMessage, type InstructionMessageProps } from './conversation/InstructionMessage';
export { ClaudeMessage, type ClaudeMessageProps } from './conversation/ClaudeMessage';
export { ClaudeMarkdown, type ClaudeMarkdownProps } from './conversation/ClaudeMarkdown';
export { ToolLine, type ToolLineProps, type ToolLineStatus } from './conversation/ToolLine';
export { PlanCard, type PlanCardProps, type PlanStep } from './conversation/PlanCard';
export { PermissionRequestCard, type PermissionRequestCardProps } from './conversation/PermissionRequestCard';
export { CommandOutput, type CommandOutputProps } from './conversation/CommandOutput';
export { NotificationItem, type NotificationItemProps } from './conversation/NotificationItem';
export {
  SessionSummaryCard,
  sessionSummaryMeta,
  type SessionSummaryCardProps,
  type SessionSummaryMetaInput,
} from './conversation/SessionSummaryCard';
export {
  SessionEmptyState,
  newSessionDescription,
  type SessionEmptyStateProps,
  type SessionSuggestion,
  type NewSessionDescriptionInput,
} from './conversation/SessionEmptyState';

// Composer (Workspace · décisions et saisie)
export { Composer, COMPOSER_PLACEHOLDER, type ComposerProps } from './composer/Composer';
export { PhoneComposer, PHONE_COMPOSER_PLACEHOLDER, type PhoneComposerProps } from './composer/PhoneComposer';
export {
  SessionPersistenceLine,
  persistenceText,
  type PersistenceContext,
  type PersistenceText,
  type SessionPersistenceLineProps,
} from './composer/SessionPersistenceLine';
export { composerAccepts, draftAfterSend, type ComposerState } from './composer/use-composer';

// Changes / diff (Workspace · Git et lignes)
export { ChangedFileRow, ChangeStatusChip, type ChangedFileRowProps, type ChangeStatusChipProps } from './changes/ChangedFileRow';
export { DiffView, type DiffViewProps, type DiffViewFile, type DiffViewHunk } from './changes/DiffView';
export { DiffFilePager, DIFF_PHONE_HINT, type DiffFilePagerProps } from './changes/DiffFilePager';
export { BranchStatusBar, type BranchStatusBarProps } from './changes/BranchStatusBar';

// Lists and cards
export { SessionCard, type SessionCardProps, type SessionCardTime } from './lists/SessionCard';
export { NewSessionCard, type NewSessionCardProps } from './lists/NewSessionCard';
export { ProjectRow, ProjectTableHeader, PROJECT_TABLE_GRID, type ProjectRowProps } from './lists/ProjectRow';
export { RecentProjectRow, type RecentProjectRowProps } from './lists/RecentProjectRow';
export { HistoryRow, HistoryTableHeader, HISTORY_TABLE_GRID, type HistoryRowProps } from './lists/HistoryRow';
export { GitActivityRow, type GitActivityRowProps } from './lists/GitActivityRow';
export { BranchRow, type BranchRowProps, type BranchBadgeKind } from './lists/BranchRow';
export { CommandRow, type CommandRowProps } from './lists/CommandRow';
export { McpToolRow, type McpToolRowProps } from './lists/McpToolRow';
export { EnvVarRow, SECRET_MASK, type EnvVarRowProps } from './lists/EnvVarRow';
export {
  McpServerCard,
  AddMcpServerCard,
  type McpServerCardProps,
  type AddMcpServerCardProps,
} from './lists/McpServerCard';
export { IntegrationRow, type IntegrationRowProps } from './lists/IntegrationRow';
export {
  SessionSwitcherHeader,
  SessionSwitcherItem,
  SessionSwitcherNewItem,
  SessionSwitcherNote,
  SessionSwitcherAllLink,
  type SessionSwitcherHeaderProps,
  type SessionSwitcherItemProps,
  type SessionSwitcherNewItemProps,
  type SessionSwitcherVariant,
} from './lists/SessionSwitcher';
export { FavoriteToggle, type FavoriteToggleProps } from './lists/FavoriteToggle';
export { RowActionButton, ACTION_VARIANT, type RowAction, type RowActionButtonProps } from './lists/row-action';

// Status
export { SessionStatusBadge, type SessionStatusBadgeProps } from './status/SessionStatusBadge';
export { LiveTime, formatLiveTime, type LiveTimeProps, type LiveTimeFormat, type DateInput } from './status/LiveTime';

// Hooks
export { useNow } from './hooks/use-now';
export { useAutoGrow } from './hooks/use-auto-grow';
export { useKeyboardInset, type KeyboardInset } from './hooks/use-keyboard-inset';

// Copy and data helpers (pure)
export { MINUS, SEP, joinParts, formatAdditions, formatDeletions, formatLineDelta, formatHunkCount, formatFileCount, formatPosition, formatRatio, basename } from './lib/format';
export {
  sessionStatusMeta,
  sessionBadgeLabel,
  defaultSessionAction,
  historyStatusMeta,
  mostUrgentStatus,
  type SessionStatus,
  type SessionStatusMeta,
  type SessionActionPreset,
  type SessionActionVariant,
  type HistoryStatusMeta,
} from './lib/session-status';
export {
  defaultPermissionOptions,
  permissionTitle,
  permissionSummary,
  permissionModeLabel,
  permissionModeText,
  isCommandTool,
  type PermissionOption,
  type PermissionMode,
  type PermissionRequestStatus,
} from './lib/permission';
export {
  describeBranchStatus,
  syncBadge,
  toChangeStatus,
  CHANGE_STATUS_LABEL,
  type BranchStatusInput,
  type SyncBadgeInput,
  type SyncBadge,
  type SyncState,
  type ChangeStatus,
} from './lib/git';
export {
  integrationStatusBadge,
  mcpStatusBadge,
  projectCountLabel,
  type StatusBadge,
  type IntegrationStatus,
  type McpStatus,
} from './lib/integrations';
export {
  COMMAND_KIND_LABEL,
  commandRunBadge,
  testCountsMeta,
  type CommandKind,
  type CommandRunStatus,
  type CommandRunSummary,
  type CommandRunBadge,
} from './lib/commands';
export { projectSessionsSummary, type ProjectSessionsInput, type ProjectSessionsSummary } from './lib/projects';
export {
  parseUnifiedDiff,
  toSplitRows,
  diffTotals,
  unquoteGitPath,
  type DiffFile,
  type DiffHunk,
  type DiffLine,
  type DiffLineLike,
  type DiffLineType,
  type SplitRow,
  type SplitCell,
  type DiffTotals,
} from './lib/diff';
export { stripAnsi, terminalText } from './lib/ansi';
export { TONE_TEXT, type BadgeTone, type DotTone } from './lib/tones';
