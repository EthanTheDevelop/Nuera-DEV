import { describe, expect, it } from 'vitest';
import {
  connectionValue,
  drawerMode,
  effectiveMcpStatus,
  expiredWhen,
  expiryToIso,
  githubNotice,
  githubTile,
  installedOnSentence,
  isGithubOutcome,
  lastCallValue,
  mcpCardAction,
  phoneAlertTitle,
  reconnectBanner,
  serverNameProblem,
  slugifyServerName,
  verificationValue,
  writeRightsShort,
  GITHUB_OUTCOMES,
} from './model';
import type { GithubStatus, IntegrationsOverview, McpDetailContext, McpServerView } from './types';

const NOW = new Date('2026-11-05T14:30:00Z'); // 15:30 à Paris

function github(overrides: Partial<GithubStatus> = {}): GithubStatus {
  return {
    mode: 'app',
    status: 'connected',
    app: { id: 1, slug: 'nuera-dev-test', name: 'Nuera Dev', htmlUrl: 'https://github.com/apps/nuera-dev-test', public: true, ownerLogin: 'org-a', createdAt: NOW.toISOString() },
    accounts: [
      { login: 'org-a', type: 'Organization', installationId: 1, repositorySelection: 'selected', repoCount: 3, suspended: false, suspendedBy: null, manageUrl: null },
      { login: 'user-b', type: 'User', installationId: 2, repositorySelection: 'selected', repoCount: 2, suspended: false, suspendedBy: null, manageUrl: null },
    ],
    ignoredInstallations: 0,
    repoCount: 5,
    permissions: {
      granted: { contents: 'write', pull_requests: 'write', issues: 'read', metadata: 'read' },
      missing: [],
      title: 'Contenu · pull requests',
      detail: 'lecture et écriture ; issues en lecture',
    },
    manageAccessUrl: 'https://github.com/apps/nuera-dev-test/installations/new',
    installUrl: '/api/integrations/github/install',
    lastCheckedAt: '2026-11-05T14:24:00Z',
    lastSuccessAt: '2026-11-05T14:24:00Z',
    failingSince: null,
    lastError: null,
    reason: null,
    action: null,
    expiresAt: null,
    lastCheck: null,
    history: [],
    ...overrides,
  };
}

function server(overrides: Partial<McpServerView> = {}): McpServerView {
  return {
    id: 's1',
    name: 'figma',
    label: 'Figma',
    description: 'Maquettes',
    subtitle: null,
    projectLine: null,
    icon: 'figma',
    preset: 'figma',
    transport: 'http',
    authKind: 'oauth',
    credential: 'claude_oauth',
    url: 'https://mcp.figma.com/mcp',
    command: null,
    args: [],
    isEnabled: true,
    status: 'connected',
    displayStatus: 'connected',
    badge: { label: 'Connecté', tone: 'success' },
    projectCount: 2,
    projects: [
      { id: 'p1', name: 'Devis Express', enabled: true },
      { id: 'p2', name: 'Catalogue', enabled: true },
      { id: 'p3', name: 'Outils', enabled: false },
    ],
    secretKeys: [],
    scopeNote: null,
    permissionsNote: null,
    permissions: [],
    configurationLines: [],
    denyRules: [],
    toolCount: null,
    lastCheckedAt: null,
    lastLatencyMs: null,
    lastError: null,
    failingSince: null,
    expiresAt: null,
    syncedToCliAt: null,
    lastCall: null,
    action: { kind: 'configure', label: 'Configurer' },
    lastCheck: null,
    history: [],
    ...overrides,
  } as McpServerView;
}

const coolifyOk = { configured: true, status: 'connected' as const, failingSince: null };

describe('GitHub tile', () => {
  it('describes the installation from the real accounts', () => {
    expect(installedOnSentence(github().accounts)).toBe("installée sur l'organisation org-a (3 dépôts) et sur le compte user-b (2 dépôts)");
    const model = githubTile(github(), NOW);
    expect(model.badge).toEqual({ label: 'Connecté', tone: 'success' });
    expect(model.description).toContain("Connecté par l'application GitHub de Nuera Dev, installée sur l'organisation org-a");
    expect(model.details?.repos).toEqual({ value: '5 dépôts', caption: "sélectionnés à l'installation" });
    expect(model.details?.lastCheck.caption).toBe('synchronisation sans erreur');
    expect(model.primary).toEqual({ label: "Gérer l'accès", href: 'https://github.com/apps/nuera-dev-test/installations/new', external: true });
    expect(model.phoneSummary).toBe('5 dépôts · contenu et pull requests en écriture');
  });

  it('offers the install route when the app is not installed, the connect form when there is none', () => {
    const pending = githubTile(github({ status: 'pending', accounts: [], repoCount: 0 }));
    expect(pending.primary).toEqual({ label: 'Installer sur GitHub', href: '/api/integrations/github/install', external: false });
    const none = githubTile(github({ mode: 'none', status: 'not_configured', app: null }));
    expect(none.connectForm).toBe(true);
    expect(none.details).toBeNull();
    expect(none.canCheck).toBe(false);
  });

  it('flags missing rights and failing checks', () => {
    const model = githubTile(github({ status: 'expired', reason: 'Installation suspendue.', permissions: { granted: {}, missing: ['contents'], title: 'Aucun droit', detail: '' } }));
    expect(model.details?.rights.warn).toBe(true);
    expect(model.details?.lastCheck.failing).toBe(true);
    expect(model.description.startsWith('Installation suspendue.')).toBe(true);
  });

  it('summarises write rights', () => {
    expect(writeRightsShort({ contents: 'write', pull_requests: 'write' })).toBe('contenu et pull requests en écriture');
    expect(writeRightsShort({ contents: 'read' })).toBe('lecture seule');
    expect(writeRightsShort({})).toBe('aucun droit');
  });
});

describe('?github=<code>', () => {
  it('knows every documented outcome', () => {
    for (const code of GITHUB_OUTCOMES) expect(githubNotice(code, 'dev-test')).toBeTruthy();
    expect(isGithubOutcome('installed')).toBe(true);
    expect(isGithubOutcome('<script>')).toBe(false);
  });

  it('toasts successes and keeps failures as banners', () => {
    expect(githubNotice('installed', 'dev-test')).toEqual({ kind: 'toast', message: 'Application GitHub installée sur dev-test' });
    expect(githubNotice('installed', 'bad name!')).toEqual({ kind: 'toast', message: 'Application GitHub installée' });
    expect(githubNotice('state_expired')).toMatchObject({ kind: 'banner', tone: 'danger', body: expect.stringContaining("Rien n'a été enregistré") });
  });
});

describe('MCP view helpers', () => {
  it('maps the card action', () => {
    expect(mcpCardAction(server())).toMatchObject({ label: 'Configurer', variant: 'secondaire', href: '/integrations/mcp/figma' });
    expect(mcpCardAction(server({ action: { kind: 'activate', label: 'Activer' } }))).toMatchObject({ label: 'Activer' });
    expect(mcpCardAction(server({ action: { kind: 'reconnect', label: 'Reconnecter', via: 'mcp_login' } }))).toMatchObject({ variant: 'principal', icon: 'refresh' });
  });

  it('shows the Coolify server expired when the token is refused', () => {
    const coolify = server({ name: 'coolify', preset: 'coolify', credential: 'coolify_token' });
    expect(effectiveMcpStatus(coolify, { configured: true, status: 'expired' })).toBe('expired');
    expect(effectiveMcpStatus(coolify, coolifyOk)).toBe('connected');
    expect(effectiveMcpStatus({ ...coolify, displayStatus: 'disabled' }, { configured: true, status: 'expired' })).toBe('disabled');
  });

  it('picks D2 when the server needs the owner', () => {
    expect(drawerMode(server(), coolifyOk)).toEqual({ kind: 'detail' });
    expect(drawerMode(server({ status: 'expired' }), coolifyOk)).toEqual({ kind: 'reconnect', via: 'mcp_login' });
    expect(drawerMode(server({ preset: 'coolify', credential: 'coolify_token' }), { configured: false, status: 'not_configured' })).toEqual({ kind: 'reconnect', via: 'coolify_token' });
    expect(drawerMode(server({ status: 'needs_auth', credential: 'stored_headers', preset: null }), coolifyOk)).toEqual({ kind: 'reconnect', via: 'headers' });
  });

  it('writes the expiry moment like Figma', () => {
    expect(expiredWhen('2026-11-05T08:12:00Z', NOW)).toBe('ce matin à 09:12');
    expect(expiredWhen('2026-11-05T13:05:00Z', NOW)).toBe('cet après-midi à 14:05');
    expect(expiredWhen('2026-11-04T17:40:00Z', NOW)).toBe('hier à 18:40');
    expect(expiredWhen('2026-10-28T08:12:00Z', NOW)).toBe('le 28 oct. à 09:12');
    expect(expiredWhen('pas une date', NOW)).toBeNull();
  });

  it('builds the D2 banner from the projects using the server', () => {
    const banner = reconnectBanner(server({ preset: 'coolify', label: 'Coolify' }), { configured: true, status: 'expired', failingSince: '2026-11-05T08:12:00Z' }, NOW);
    expect(banner).toEqual({
      tone: 'danger',
      title: 'Jeton expiré ce matin à 09:12',
      body: "Les sessions de Devis Express et Catalogue n'ont plus accès aux environnements de développement.",
    });
  });

  it('never invents an account for « Connexion »', () => {
    const context = {
      coolify: { baseUrl: 'https://coolify.example.test', tokenFingerprint: 'jeton n°67' },
      github: { accounts: github().accounts },
    } as unknown as McpDetailContext;
    expect(connectionValue(server(), context)).toBe('autorisation OAuth dans Claude Code');
    expect(connectionValue(server({ credential: 'coolify_token' }), context)).toBe('jeton n°67 · coolify.example.test');
    expect(connectionValue(server({ credential: 'github_installation' }), context)).toBe('application GitHub · org-a, user-b');
    expect(connectionValue(server({ credential: 'stored_headers', secretKeys: ['X-Api-Key'] }), context)).toBe('en-têtes chiffrés · X-Api-Key');
  });

  it('formats « Dernier appel » and « Vérification »', () => {
    expect(lastCallValue(null, NOW)).toBe('aucun appel enregistré');
    expect(lastCallValue({ at: '2026-11-05T14:27:00Z', tool: 'mcp__figma__x', projectId: 'p1', projectName: 'Devis Express', ok: true }, NOW)).toBe('il y a 3 min · Devis Express');
    expect(verificationValue(server({ lastCheckedAt: NOW.toISOString() }), 15)).toBe('toutes les 15 min · OK');
    expect(verificationValue(server({ projectCount: 0 }), 15)).toBe('manuelle (aucun projet) · jamais vérifié');
  });

  it('titles the M07 alert cards', () => {
    const overview = { github: github(), coolify: { status: 'expired' }, mcp: { servers: [] } } as unknown as IntegrationsOverview;
    expect(phoneAlertTitle({ target: 'coolify', tone: 'danger', title: 'Coolify ne répond plus depuis 09:12' }, overview)).toBe('Coolify : autorisation expirée');
    expect(phoneAlertTitle({ target: 'github', tone: 'danger', title: "L'accès GitHub a été retiré" }, { ...overview, github: github({ status: 'error' }) })).toBe('GitHub : accès retiré');
  });
});

describe('forms', () => {
  it('proposes an identifier and validates it', () => {
    expect(slugifyServerName('Sentry · Équipe EU')).toBe('sentry-equipe-eu');
    expect(serverNameProblem('figma')).toBe('Identifiant réservé à un serveur intégré.');
    expect(serverNameProblem('Bad Name')).not.toBeNull();
    expect(serverNameProblem('docs-internes')).toBeNull();
  });

  it('turns the Coolify expiry choice into a date', () => {
    expect(expiryToIso('never', NOW)).toBeNull();
    expect(expiryToIso('90', NOW)).toBe('2027-02-03T14:30:00.000Z');
  });
});
