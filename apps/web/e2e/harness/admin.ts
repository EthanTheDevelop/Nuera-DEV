/**
 * TEST-ONLY — what the harness asks the administration of the web under test (signed in as the
 * owner, account `a`): register a server (« Serveurs » → token and restricted database DSN shown once)
 * and invite an account (link `/invitation/<jeton>` shown once). Both go through the REAL admin routes
 * (`/api/admin/**`, the same server functions as the console). While a web under test has no such
 * route yet (404), a fallback writes the same rows directly — TODO: drop the fallbacks once every
 * supported web serves /api/admin/** (they only exist for a web built before the administration).
 */
import type { APIRequestContext } from '@playwright/test';
import { environments, invitations } from '@nuera/db';
import { generateLinkToken, generateRunnerToken, hashToken } from '@nuera/shared/tokens';
import { eq } from 'drizzle-orm';
import { createServerRole, encryptLegacySecret, withStackDb } from './db';
import type { StackState } from './state';

/** Admin routes tried in order (the first one that exists answers). */
export const ADMIN_SERVER_ROUTES = ['/api/admin/servers', '/api/admin/environments'] as const;
export const ADMIN_INVITATION_ROUTES = ['/api/admin/invitations'] as const;

export interface RegisteredServer {
  environmentId: string;
  /** RUNNER_TOKEN of the new server (shown once). */
  token: string;
  /** Restricted login role and its DSN (RUNNER_DATABASE_URL, shown once). */
  dbRole: string | null;
  databaseUrl: string | null;
  via: 'admin' | 'sql';
}

export interface CreatedInvitation {
  url: string;
  token: string;
  via: 'admin' | 'sql';
}

type Json = Record<string, unknown>;

/** First string value found under one of `keys` (depth-first), or matching `test`. Exported for tests. */
export function findString(value: unknown, keys: readonly string[], test?: (text: string) => boolean): string | null {
  const seen = new Set<unknown>();
  const visit = (node: unknown): string | null => {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    for (const [key, item] of Object.entries(node as Json)) {
      if (typeof item === 'string' && keys.includes(key) && (!test || test(item))) return item;
    }
    for (const item of Object.values(node as Json)) {
      const found = visit(item);
      if (found) return found;
    }
    return null;
  };
  return visit(value);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function postFirst(request: APIRequestContext, web: string, routes: readonly string[], data: Json): Promise<{ route: string; status: number; body: unknown } | null> {
  for (const route of routes) {
    const response = await request.post(`${web}${route}`, { data, headers: { origin: web, 'content-type': 'application/json' }, timeout: 300_000 });
    if (response.status() === 404 || response.status() === 405) {
      await response.dispose();
      continue;
    }
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // HTML or text
    }
    return { route, status: response.status(), body };
  }
  return null;
}

function describe(body: unknown): string {
  return (typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 400);
}

/**
 * Registers a server (`name`, internal URL of its runner) as the owner would in Administration ›
 * Serveurs. Returns its id, its one-time token and the restricted DSN of its runner.
 */
export async function registerServer(request: APIRequestContext, state: StackState, input: { name: string; url: string; location?: string }, log: (line: string) => void): Promise<RegisteredServer> {
  const answer = await postFirst(request, state.urls.web, ADMIN_SERVER_ROUTES, { name: input.name, url: input.url, ...(input.location ? { location: input.location } : {}) });
  if (answer) {
    if (answer.status >= 400) throw new Error(`POST ${answer.route} → HTTP ${answer.status} ${describe(answer.body)}`);
    const environmentId = findString(answer.body, ['id', 'environmentId', 'serverId'], (text) => UUID.test(text));
    const token = findString(answer.body, ['token', 'runnerToken'], (text) => text.length >= 32);
    const databaseUrl = findString(answer.body, ['databaseUrl', 'dsn', 'runnerDatabaseUrl', 'databaseDsn'], (text) => /^postgres(ql)?:\/\//.test(text));
    const dbRole = findString(answer.body, ['dbRole', 'role', 'databaseRole'], (text) => /^[a-z0-9_]+$/.test(text) && text !== 'member' && text !== 'admin' && text !== 'owner');
    if (!environmentId || !token) throw new Error(`POST ${answer.route} : identifiant ou jeton du serveur introuvable dans la réponse (${describe(answer.body)}).`);
    log(`  serveur « ${input.name} » enregistré par l'administration (${answer.route})`);
    return { environmentId, token, dbRole, databaseUrl, via: 'admin' };
  }
  // TODO(admin): fallback for a web without /api/admin/** (same rows as the registration writes).
  log(`  serveur « ${input.name} » : aucune route d'administration, enregistrement direct en base (repli)`);
  const token = generateRunnerToken();
  const [row] = await withStackDb(state.database.url, (db) =>
    db
      .insert(environments)
      .values({
        name: input.name,
        location: input.location ?? null,
        status: 'pending',
        configSource: 'db',
        isDefault: false,
        url: input.url,
        tokenEncrypted: encryptLegacySecret(token, state.secrets.appEncryptionKey),
        tokenHash: hashToken(token),
        createdByUserId: state.owner.userId,
      })
      .returning({ id: environments.id }),
  );
  if (!row) throw new Error(`Serveur « ${input.name} » non créé.`);
  const { role, password } = await createServerRole(state.database.adminUrl, state.database.name, row.id.replace(/-/g, '').slice(0, 8));
  await withStackDb(state.database.url, (db) => db.update(environments).set({ dbRole: role }).where(eq(environments.id, row.id)));
  const dsn = new URL(state.database.url);
  dsn.username = role;
  dsn.password = password;
  return { environmentId: row.id, token, dbRole: role, databaseUrl: dsn.toString(), via: 'sql' };
}

/**
 * Invites `email` as a member, with the pending server `environmentId` pre-assigned (Administration ›
 * Comptes › « Inviter »). Returns the one-time link.
 */
export async function createInvitation(request: APIRequestContext, state: StackState, input: { email: string; role: 'member' | 'admin'; environmentId: string | null }, log: (line: string) => void): Promise<CreatedInvitation> {
  const answer = await postFirst(request, state.urls.web, ADMIN_INVITATION_ROUTES, { email: input.email, role: input.role, ...(input.environmentId ? { environmentId: input.environmentId } : {}) });
  if (answer) {
    if (answer.status >= 400) throw new Error(`POST ${answer.route} → HTTP ${answer.status} ${describe(answer.body)}`);
    const url = findString(answer.body, ['url', 'link', 'invitationUrl', 'href'], (text) => text.includes('/invitation/'));
    const token = url ? decodeURIComponent(new URL(url, state.urls.web).pathname.split('/').pop() ?? '') : findString(answer.body, ['token'], (text) => text.length >= 32);
    if (!token) throw new Error(`POST ${answer.route} : lien d'invitation introuvable dans la réponse (${describe(answer.body)}).`);
    log(`  invitation de ${input.email} créée par l'administration (${answer.route})`);
    return { url: `${state.urls.web}/invitation/${encodeURIComponent(token)}`, token, via: 'admin' };
  }
  // TODO(admin): fallback for a web without /api/admin/** (same row as the invitation writes).
  log(`  invitation de ${input.email} : aucune route d'administration, invitation écrite en base (repli)`);
  const token = generateLinkToken();
  await withStackDb(state.database.url, (db) =>
    db.insert(invitations).values({
      kind: 'invite',
      email: input.email.toLowerCase(),
      role: input.role,
      environmentId: input.environmentId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 48 * 3600_000),
      createdByUserId: state.owner.userId,
    }),
  );
  return { url: `${state.urls.web}/invitation/${encodeURIComponent(token)}`, token, via: 'sql' };
}
