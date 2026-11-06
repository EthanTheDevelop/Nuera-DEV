import 'server-only';

/**
 * Administration of the instance (docs/MULTICOMPTE.md §6, §10, §11) — owner and administrators only.
 * Route handlers: app/api/admin/** (`apiRoute({ auth: 'admin' })`); console: /administration
 * (features/admin, server actions). Every function re-checks the role of the actor it receives.
 */
export { type AdminActor } from './common';
export {
  ACCOUNT_GUARDS,
  changeAccountRole,
  changeRoleSchema,
  createAccountRecoveryLink,
  deleteAccount,
  disableAccount,
  disableAccountSchema,
  enableAccount,
  getAccount,
  listAccounts,
  recoverySchema,
  type AdminAccountView,
  type DisableAccountResult,
  type RecoveryLinkView,
} from './accounts';
export {
  createInvitation,
  createInvitationSchema,
  listInvitations,
  revokeInvitation,
  VALIDITY_CHOICES,
  type AdminInvitationView,
  type CreatedInvitation,
} from './invitations';
export {
  addServerAccount,
  allowedRunnerHosts,
  assignServer,
  assignServerSchema,
  fullDatabaseWarning,
  getServer,
  listServers,
  normaliseRunnerUrl,
  registerServer,
  registerServerSchema,
  removeServerAccount,
  restrictServerDatabase,
  retireServer,
  rotateServerToken,
  SERVER_ADDRESS_GUARDS,
  updateServer,
  updateServerSchema,
  verifyServer,
  type AdminServerView,
  type ServerAccountView,
  type RegisteredServer,
  type RestrictedDatabaseAccess,
  type RotatedToken,
  type ServerVerification,
  type UpdatedServer,
} from './servers';
export {
  getInstanceJournal,
  getInstanceView,
  instancePatchSchema,
  journalQuerySchema,
  updateInstance,
  type InstanceJournalEntry,
  type InstanceView,
} from './instance';
export { promoteRunnerToken } from './token-rotation';
export { loadAdministration, type AdministrationData, type Section } from './view';
