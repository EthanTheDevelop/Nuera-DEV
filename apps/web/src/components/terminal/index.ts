// Shared browser terminal of Nuera Dev (xterm.js). Inventory and wiring notes: ./README.md
export { TerminalView, type TerminalViewProps, type TerminalViewState } from './TerminalView';
export { TerminalDialog, type TerminalDialogProps } from './TerminalDialog';
export { useTerminalLauncher, type TerminalLauncher } from './useTerminalLauncher';
export {
  TERMINAL_PRIVACY_NOTE,
  claudeLoginTerminal,
  claudeStatusTerminal,
  mcpLoginTerminal,
  shellTerminal,
  type PresetOptions,
  type TerminalLaunch,
} from './presets';
export {
  TerminalApiError,
  closeTerminalRequest,
  createTerminal,
  fetchTerminal,
  startMcpLoginTerminal,
  terminalUrls,
  type CreateTerminalBody,
} from './api';
export type { TerminalErrorReason, TerminalSize } from './protocol';
