/**
 * TEST-ONLY — the instance administration as the specs drive it (owner / admin request contexts):
 * routes of /api/admin/** and the copy of the screens without Figma (MULTICOMPTE §6, §10), gathered
 * here so that a change of the administration lot is reflected in one place.
 */
import type { APIRequestContext } from '@playwright/test';
import { E2E_BASE_URL } from './env';

export const ADMIN_ROUTES = {
  page: '/administration',
  accounts: '/api/admin/accounts',
  account: (userId: string) => `/api/admin/accounts/${userId}`,
  accountAction: (userId: string, action: 'disable' | 'enable' | 'role' | 'recovery') => `/api/admin/accounts/${userId}/${action}`,
  invitations: '/api/admin/invitations',
  invitation: (id: string) => `/api/admin/invitations/${id}`,
  servers: '/api/admin/servers',
  server: (id: string) => `/api/admin/servers/${id}`,
  serverAction: (id: string, action: 'verify' | 'assign' | 'rotate' | 'retire') => `/api/admin/servers/${id}/${action}`,
  journal: '/api/admin/journal',
} as const;

/** French copy fixed by docs/MULTICOMPTE.md (exact) and patterns for the screens without Figma. */
export const COPY = {
  accountDisabled: 'Ce compte est désactivé. Contactez un administrateur.',
  noServer: /Aucun serveur ne vous est encore attribué/,
  instanceSettingReserved: 'Réglage réservé aux administrateurs.',
  otherAccountSignedIn: 'Vous êtes connecté avec un autre compte : déconnectez-vous pour accepter cette invitation.',
  defaultServerFullDatabase: (name: string) => `Le serveur ${name} accède encore à toute la base de données.`,
  stopSessionsOption: /^Arrêter aussi ses sessions Claude Code en cours/,
  /** An unusable invitation link (unknown, expired, revoked, already used): explained, never the form. */
  invitationUnusable: /(n'est pas valide|n'est plus valide|a expiré|a été annulée?|a déjà servi|déjà été utilisé)/,
  recoveryUnusable: /(n'est pas valide|n'est plus valide|a expiré|a été annulée?|a déjà servi|déjà été utilisé)/,
} as const;

const json = { origin: E2E_BASE_URL, 'content-type': 'application/json' };

export interface AdminAnswer {
  status: number;
  body: Record<string, unknown> | null;
  text: string;
}

export async function adminCall(request: APIRequestContext, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, data?: unknown): Promise<AdminAnswer> {
  const response = await request.fetch(path, { method, headers: json, ...(data === undefined ? {} : { data }), timeout: 120_000 });
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { status: response.status(), body, text };
}

/** First string under one of `keys` in a JSON answer (depth-first). */
export function pick(value: unknown, keys: readonly string[], test?: (text: string) => boolean): string | null {
  if (!value || typeof value !== 'object') return null;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) if (typeof item === 'string' && keys.includes(key) && (!test || test(item))) return item;
  for (const item of Object.values(value as Record<string, unknown>)) {
    const found = pick(item, keys, test);
    if (found) return found;
  }
  return null;
}

export interface Invitation {
  id: string | null;
  url: string;
  token: string;
}

/** Owner / admin invites `email` (Administration › Comptes › « Inviter »), optionally with a pending server. */
export async function invite(request: APIRequestContext, input: { email: string; role?: 'member' | 'admin'; environmentId?: string | null }): Promise<Invitation> {
  const answer = await adminCall(request, 'POST', ADMIN_ROUTES.invitations, { email: input.email, role: input.role ?? 'member', ...(input.environmentId ? { environmentId: input.environmentId } : {}) });
  if (answer.status >= 300) throw new Error(`POST ${ADMIN_ROUTES.invitations} → HTTP ${answer.status} ${answer.text.slice(0, 300)}`);
  const url = pick(answer.body, ['url', 'link', 'invitationUrl', 'href'], (text) => text.includes('/invitation/'));
  const token = url ? decodeURIComponent(new URL(url, E2E_BASE_URL).pathname.split('/').pop()!) : pick(answer.body, ['token'], (text) => text.length >= 32);
  if (!token) throw new Error(`Invitation sans lien : ${answer.text.slice(0, 300)}`);
  const id = pick(answer.body, ['id', 'invitationId'], (text) => /^[0-9a-f-]{36}$/.test(text));
  return { id, url: `${E2E_BASE_URL}/invitation/${encodeURIComponent(token)}`, token };
}

/** Disables then deletes a throwaway account (Administration › Comptes), ignoring what is already done. */
export async function removeAccount(request: APIRequestContext, userId: string): Promise<void> {
  await adminCall(request, 'POST', ADMIN_ROUTES.accountAction(userId, 'disable'), { stopSessions: true }).catch(() => undefined);
  await adminCall(request, 'DELETE', ADMIN_ROUTES.account(userId)).catch(() => undefined);
}
