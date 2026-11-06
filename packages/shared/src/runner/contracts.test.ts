import { describe, expect, it } from 'vitest';
import {
  CreateRunRequestSchema,
  CreateTerminalRequestSchema,
  HealthResponseSchema,
  RemoveCloneQuerySchema,
  RemoveWorktreeQuerySchema,
  RUNNER_CONTRACT_VERSION,
  RUNNER_ERROR_REASONS,
  RUNNER_ROUTES,
  RUNNER_STATES,
  SessionLaunchOptionsSchema,
  StartSessionRequestSchema,
  TerminalDtoSchema,
  uptimeServiceKey,
} from './index';

/** Contract version 2 (docs/MULTICOMPTE.md §4): every new field is optional, both ways. */

const ENV_ID = '6f1c0b39-9f4c-4c1f-9c2e-8a8a2b0c1d2e';

const HEALTH_V1 = {
  ok: true,
  service: 'runner',
  version: '0.1.0',
  startedAt: '2026-11-05T10:00:00.000Z',
  uptimeSec: 12,
  backend: 'tmux',
  git: { available: true, version: '2.47.0', error: null },
  tmux: { available: true, version: '3.5', error: null },
  claude: { available: true, version: '2.1.0', error: null },
  database: { ok: true, error: null },
  disk: null,
  projectsRoot: '/srv/dev',
  dataDir: '/data',
};

const TERMINAL_V1 = {
  id: 'abcdefgh1234',
  kind: 'shell',
  title: 'Terminal',
  cwd: '/srv/dev/nuera-os',
  worktreeId: ENV_ID,
  sessionId: null,
  cols: 120,
  rows: 32,
  alive: true,
  exitCode: null,
  private: false,
  subscribers: 1,
  createdAt: '2026-11-05T10:00:00.000Z',
  lastActivityAt: '2026-11-05T10:00:00.000Z',
};

describe('contrat runner ⇄ web, version 2', () => {
  it('expose la version du contrat et la clé de disponibilité de chaque serveur', () => {
    expect(RUNNER_CONTRACT_VERSION).toBe(2);
    expect(uptimeServiceKey({ id: ENV_ID, isDefault: true })).toBe('runner');
    expect(uptimeServiceKey({ id: ENV_ID, isDefault: false })).toBe(`runner:${ENV_ID}`);
  });

  it("la santé d'un runner plus ancien reste lisible ; un runner récent annonce son serveur et son état", () => {
    const old = HealthResponseSchema.parse(HEALTH_V1);
    expect(old.environment).toBeUndefined();
    expect(old.state).toBeUndefined();
    expect(old.contractVersion).toBeUndefined();
    const recent = HealthResponseSchema.parse({
      ...HEALTH_V1,
      environment: { id: ENV_ID, name: 'VPS-3' },
      state: 'ready',
      contractVersion: RUNNER_CONTRACT_VERSION,
    });
    expect(recent).toMatchObject({ environment: { id: ENV_ID, name: 'VPS-3' }, state: 'ready', contractVersion: 2 });
    expect(HealthResponseSchema.parse({ ...HEALTH_V1, environment: null, state: 'unregistered', contractVersion: 2 }).environment).toBeNull();
    expect(RUNNER_STATES).toEqual(['ready', 'starting', 'unregistered', 'disabled']);
    expect(HealthResponseSchema.safeParse({ ...HEALTH_V1, state: 'sleeping' }).success).toBe(false);
    expect(HealthResponseSchema.safeParse({ ...HEALTH_V1, environment: { id: 'pas-un-uuid', name: 'x' } }).success).toBe(false);
  });

  it("connaît les refus d'un serveur non enregistré ou désactivé", () => {
    expect(RUNNER_ERROR_REASONS).toEqual(expect.arrayContaining(['ENVIRONMENT_UNREGISTERED', 'ENVIRONMENT_STARTING', 'ENVIRONMENT_DISABLED']));
  });

  it("les options de lancement acceptent les politiques et l'identité Git, et restent compatibles", () => {
    expect(SessionLaunchOptionsSchema.parse({})).toEqual({ denyRules: [], env: {} });
    const options = SessionLaunchOptionsSchema.parse({
      permissionWaitSeconds: 300,
      blockBypassPermissions: false,
      gitIdentity: { name: 'Camille Martin', email: 'camille@example.test' },
    });
    expect(options).toMatchObject({
      permissionWaitSeconds: 300,
      blockBypassPermissions: false,
      gitIdentity: { name: 'Camille Martin', email: 'camille@example.test' },
    });
    expect(SessionLaunchOptionsSchema.parse({ gitIdentity: null }).gitIdentity).toBeNull();
    expect(SessionLaunchOptionsSchema.safeParse({ gitIdentity: { name: '', email: 'x@y' } }).success).toBe(false);
    expect(SessionLaunchOptionsSchema.safeParse({ gitIdentity: { name: 'A', email: 'pas une adresse' } }).success).toBe(false);
    // A resume may send only part of the options.
    const resumed = StartSessionRequestSchema.parse({ launch: { blockBypassPermissions: true } }).launch;
    expect(resumed).toMatchObject({ blockBypassPermissions: true });
    expect(resumed).not.toHaveProperty('gitIdentity');
    expect(resumed).not.toHaveProperty('permissionWaitSeconds');
  });

  it('les terminaux portent leur auteur (et une identité Git pour le shell)', () => {
    const shell = CreateTerminalRequestSchema.parse({
      kind: 'shell',
      worktreeId: ENV_ID,
      actorUserId: 'user_123',
      gitIdentity: { name: 'Ethan', email: 'ethan@example.test' },
    });
    expect(shell).toMatchObject({ kind: 'shell', actorUserId: 'user_123', gitIdentity: { name: 'Ethan', email: 'ethan@example.test' } });
    expect(CreateTerminalRequestSchema.parse({ kind: 'claude-login', actorUserId: 'user_123' })).toMatchObject({ actorUserId: 'user_123' });
    expect(CreateTerminalRequestSchema.parse({ kind: 'mcp-login', serverName: 'figma' })).not.toHaveProperty('actorUserId');
    expect(CreateTerminalRequestSchema.safeParse({ kind: 'claude-status', actorUserId: '' }).success).toBe(false);
    // An identity only means something in a shell: ignored on the other kinds.
    expect(CreateTerminalRequestSchema.parse({ kind: 'claude-status', gitIdentity: { name: 'x', email: 'x@y' } })).not.toHaveProperty('gitIdentity');
    expect(TerminalDtoSchema.parse(TERMINAL_V1).ownerUserId).toBeUndefined();
    expect(TerminalDtoSchema.parse({ ...TERMINAL_V1, ownerUserId: 'user_123' }).ownerUserId).toBe('user_123');
    expect(TerminalDtoSchema.parse({ ...TERMINAL_V1, ownerUserId: null }).ownerUserId).toBeNull();
  });

  it('les lancements et les suppressions de worktree ou de clone portent leur auteur', () => {
    const run = CreateRunRequestSchema.parse({
      projectId: ENV_ID,
      kind: 'test',
      actorUserId: 'user_123',
      gitIdentity: { name: 'Ethan', email: 'ethan@example.test' },
    });
    expect(run).toMatchObject({ actorUserId: 'user_123', gitIdentity: { name: 'Ethan', email: 'ethan@example.test' } });
    expect(CreateRunRequestSchema.parse({ projectId: ENV_ID, kind: 'test' }).gitIdentity).toBeUndefined();
    expect(RemoveWorktreeQuerySchema.parse({ force: '1', actorUserId: 'user_123' })).toEqual({ force: true, deleteBranch: false, actorUserId: 'user_123' });
    expect(RemoveWorktreeQuerySchema.parse({})).toEqual({ force: false, deleteBranch: false });
    expect(RemoveCloneQuerySchema.parse({ actorUserId: 'user_123' })).toEqual({ actorUserId: 'user_123' });
    expect(RemoveCloneQuerySchema.parse({})).toEqual({});
    expect(RUNNER_ROUTES.removeClone.query).toBe(RemoveCloneQuerySchema);
  });

  it('un runner plus ancien ignore les champs nouveaux (schémas non stricts)', () => {
    // What a contract-1 runner does with a contract-2 request: unknown keys are dropped, never refused.
    const launchV1 = SessionLaunchOptionsSchema.pick({ denyRules: true, env: true, permissionWaitSeconds: true });
    expect(launchV1.parse({ denyRules: [], env: {}, gitIdentity: { name: 'x', email: 'x@y' }, blockBypassPermissions: true })).toEqual({
      denyRules: [],
      env: {},
    });
  });
});
