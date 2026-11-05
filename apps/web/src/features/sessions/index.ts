// Sessions lot — browser side: the « Nouvelle session » dialog used everywhere, its triggers and the
// session actions (resume / stop / archive / rename). Server side: '@/server/sessions'.
export { NewSessionDialog, type NewSessionDialogProps } from './NewSessionDialog';
export { NewSessionButton, type NewSessionButtonProps, type NewSessionButtonVariant } from './NewSessionButton';
export { StopSessionDialog, type StopSessionDialogProps } from './StopSessionDialog';
export { useSessionActions, type SessionActionTarget, type SessionActions } from './useSessionActions';
export {
  SessionApiError,
  archiveSessionRequest,
  createSessionRequest,
  fetchSessionSummary,
  renameSessionRequest,
  resumeSessionRequest,
  stopSessionRequest,
} from './api';
export {
  workspaceUrl,
  type CreateSessionInput,
  type CreateSessionResult,
  type SessionCapacity,
  type SessionListItem,
  type SessionSummary,
} from './lib/contract';
