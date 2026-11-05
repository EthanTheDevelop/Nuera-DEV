// Workspace lot — browser side of `/workspace/[sessionId]` (D05 · M05 · W1–W7 · S1–S4).
// Server side: '@/server/workspace'. Contracts: './lib/contract'.
export { WorkspaceView, type WorkspaceViewProps } from './WorkspaceView';
export {
  WorkspaceApiError,
  decidePermissionRequest,
  fetchEvents,
  fetchSessionTerminal,
  interruptRequest,
  sendInstructionRequest,
} from './api';
export { workspaceUrl, type WorkspaceData } from './lib/contract';
