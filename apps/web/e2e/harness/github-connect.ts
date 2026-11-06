/**
 * TEST-ONLY — connects a GitHub source of an account's space through the REAL web routes, against
 * the fake GitHub (which serves several apps, see github-front.ts):
 *   POST /api/integrations/github/manifest  → page that posts the manifest to « github.com »
 *        (a second source of the same space: POST /api/integrations/github/sources, when it exists)
 *   fake github.com « Create GitHub App »    → binds app `appKey` → /api/integrations/github/callback?code&state
 *   callback (manifest conversion, credentials stored encrypted) → installation page of that app
 *   installation page (one per installation of the app) → /api/integrations/github/setup?installation_id&state
 *   other accounts: GET /api/integrations/github/install[?source=<id>] (fresh signed state) → same steps.
 * The rows are therefore the genuine ones (the same code as the account's clicks), in its own space.
 */
import type { APIRequestContext } from '@playwright/test';
import { githubSources } from '@nuera/db';
import { and, eq } from 'drizzle-orm';
import type { StackKey } from './config';
import { withStackDb } from './db';
import { accountOf, githubAppOf, type StackGithubApp, type StackState } from './state';

const unescapeHtml = (value: string) => value.replace(/&(amp|lt|gt|quot|#39);/g, (_m, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[entity]!);

/** `action` and `manifest` of the self-submitting page returned by the manifest route. Exported for tests. */
export function parseManifestForm(html: string): { action: string; manifest: string } {
  const action = /<form[^>]*\baction="([^"]+)"/i.exec(html)?.[1];
  const manifest = /<input[^>]*\bname="manifest"[^>]*\bvalue="([^"]*)"/i.exec(html)?.[1];
  if (!action || manifest === undefined) throw new Error('Page du manifest GitHub inattendue (formulaire introuvable).');
  return { action: unescapeHtml(action), manifest: unescapeHtml(manifest) };
}

function location(response: { status(): number; headers(): Record<string, string> }, base: string, step: string): string {
  const value = response.headers().location;
  if (response.status() < 300 || response.status() >= 400 || !value) {
    throw new Error(`${step} : redirection attendue, HTTP ${response.status()}.`);
  }
  return new URL(value, base).toString();
}

export interface GithubConnection {
  sourceId: string | null;
  status: string;
  accounts: string[];
  repoCount: number | null;
}

interface SourceView {
  id: string | null;
  slug: string | null;
  status: string | null;
  accounts: string[];
  repoCount: number | null;
}

/** Sources of the space as GET /api/integrations/github lists them (`sources[]`, or the legacy single-app body). Exported for tests. */
export function sourcesOf(body: unknown): SourceView[] {
  const value = (body ?? {}) as Record<string, unknown>;
  const accountsOf = (list: unknown) => (Array.isArray(list) ? list.map((item) => (typeof item === 'string' ? item : String((item as { login?: string }).login ?? ''))).filter(Boolean) : []);
  if (Array.isArray(value.sources)) {
    return value.sources.map((raw) => {
      const item = raw as Record<string, unknown>;
      const app = (item.app ?? null) as { slug?: string } | null;
      return {
        id: typeof item.id === 'string' ? item.id : null,
        slug: app?.slug ?? (typeof item.slug === 'string' ? item.slug : null),
        status: typeof item.status === 'string' ? item.status : null,
        accounts: accountsOf(item.accounts),
        repoCount: typeof item.repoCount === 'number' ? item.repoCount : null,
      };
    });
  }
  const app = (value.app ?? null) as { slug?: string } | null;
  if (value.mode === 'app' && app?.slug) {
    return [{ id: typeof value.sourceId === 'string' ? value.sourceId : null, slug: app.slug, status: typeof value.status === 'string' ? value.status : null, accounts: accountsOf(value.accounts), repoCount: typeof value.repoCount === 'number' ? value.repoCount : null }];
  }
  return [];
}

async function githubStatus(request: APIRequestContext, web: string): Promise<unknown> {
  const response = await request.get(`${web}/api/integrations/github`);
  if (!response.ok()) throw new Error(`GET /api/integrations/github → HTTP ${response.status()}`);
  return response.json();
}

/** Source row of app `app` in the account's space (read-only lookup). */
async function sourceRow(state: StackState, spaceId: string, app: StackGithubApp): Promise<{ id: string; status: string } | null> {
  return withStackDb(state.database.url, async (db) => {
    const [row] = await db
      .select({ id: githubSources.id, status: githubSources.status })
      .from(githubSources)
      .where(and(eq(githubSources.spaceId, spaceId), eq(githubSources.appId, app.appId)))
      .limit(1);
    return row ?? null;
  });
}

async function controlFake(state: StackState, input: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${state.urls.githubWeb}/__harness/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  if (!response.ok) throw new Error(`Faux GitHub : HTTP ${response.status} ${await response.text()}`);
}

/** Follows the fake installation pages for one account and returns the outcome given by the setup route. */
async function installOn(request: APIRequestContext, state: StackState, installUrl: string, account: { login: string; id: number }): Promise<string> {
  const web = state.urls.web;
  const pick = new URL(installUrl);
  pick.searchParams.set('target_id', String(account.id));
  const permissions = location(await request.get(pick.toString(), { maxRedirects: 0 }), state.urls.githubWeb, `installation sur ${account.login}`);
  const setup = location(await request.get(permissions, { maxRedirects: 0 }), state.urls.githubWeb, `autorisation sur ${account.login}`);
  if (!setup.startsWith(`${web}/api/integrations/github/setup`)) throw new Error(`Retour d'installation inattendu : ${setup}`);
  const back = location(await request.get(setup, { maxRedirects: 0 }), web, 'retour de GitHub (setup)');
  return new URL(back).searchParams.get('github') ?? 'inconnu';
}

const FIXTURE_IDS: Record<string, number> = { 'atelier-test': 5101, 'dev-test': 5202, 'hugo-test': 5303 };

/**
 * Connects (or completes) the GitHub source of `accountKey`'s space backed by app `appKey` of the fake
 * GitHub: creation through the manifest when the space has no source for that app, installation on
 * every account of the app, then a check. `request` is signed in as that account.
 */
export async function connectGithubSource(request: APIRequestContext, state: StackState, accountKey: StackKey, appKey: string, log: (line: string) => void): Promise<GithubConnection> {
  const web = state.urls.web;
  const account = accountOf(state, accountKey);
  if (!account.spaceId) throw new Error(`GitHub : l'espace du compte ${accountKey} est inconnu.`);
  const app = githubAppOf(state, appKey);
  const wanted = app.installations.map((item) => item.account);
  const before = sourcesOf(await githubStatus(request, web));
  let row = await sourceRow(state, account.spaceId, app);
  let view = before.find((item) => item.slug === app.slug) ?? null;
  const installed = new Set(view?.accounts ?? []);

  if (!row) {
    log(`  GitHub (${account.name}) : création de l'application ${app.slug} (manifest)…`);
    await controlFake(state, { bindNext: app.key });
    const form = { organization: app.owner.type === 'Organization' ? app.owner.login : '', public: 'true' };
    const routes = before.length > 0 ? ['/api/integrations/github/sources', '/api/integrations/github/manifest'] : ['/api/integrations/github/manifest'];
    let html: string | null = null;
    for (const route of routes) {
      const response = await request.post(`${web}${route}`, { form, headers: { origin: web }, maxRedirects: 0 });
      if (response.status() === 404 || response.status() === 405) continue;
      if (!response.ok()) throw new Error(`POST ${route} → HTTP ${response.status()} ${(await response.text()).slice(0, 300)}`);
      html = await response.text();
      break;
    }
    if (html === null) throw new Error('GitHub : aucune route de création de source (manifest) sur le web.');
    const manifest = parseManifestForm(html);
    if (!manifest.action.startsWith(state.urls.githubWeb)) throw new Error(`Le manifest part vers ${manifest.action} au lieu du faux GitHub (${state.urls.githubWeb}).`);
    const created = await request.post(manifest.action, { form: { manifest: manifest.manifest }, maxRedirects: 0 });
    if (created.status() === 422) throw new Error(`Faux GitHub : application refusée (${(await created.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)}).`);
    const callback = location(created, state.urls.githubWeb, "création de l'application");
    const install = location(await request.get(callback, { maxRedirects: 0 }), web, 'retour de GitHub (callback)');
    if (!install.startsWith(state.urls.githubWeb)) throw new Error(`Conversion du manifest refusée : ${install}`);
    const outcome = await installOn(request, state, install, { login: app.owner.login, id: app.owner.id });
    log(`  GitHub (${account.name}) : ${app.slug} installée sur ${app.owner.login} (${outcome})`);
    installed.add(app.owner.login);
    row = await sourceRow(state, account.spaceId, app);
    if (!row) throw new Error(`GitHub : la source de l'application ${app.slug} est absente de l'espace du compte ${accountKey} après la création.`);
  }

  for (const login of wanted) {
    if (installed.has(login)) continue;
    const id = FIXTURE_IDS[login];
    if (!id) throw new Error(`Compte GitHub de test inconnu : ${login}`);
    let response = await request.get(`${web}/api/integrations/github/install?source=${encodeURIComponent(row.id)}`, { maxRedirects: 0 });
    if (response.status() === 400 || response.status() === 404) response = await request.get(`${web}/api/integrations/github/install`, { maxRedirects: 0 });
    const install = location(response, web, `installation sur ${login}`);
    const outcome = await installOn(request, state, install, { login, id });
    log(`  GitHub (${account.name}) : ${app.slug} installée sur ${login} (${outcome})`);
  }

  row = await sourceRow(state, account.spaceId, app);
  if (row?.status !== 'connected') {
    const routes = [`/api/integrations/github/sources/${row?.id ?? ''}/check`, '/api/integrations/github/check'];
    for (const route of routes) {
      const check = await request.post(`${web}${route}`, { headers: { origin: web } });
      if (check.status() === 404 || check.status() === 405) continue;
      if (!check.ok()) throw new Error(`Vérification GitHub (${route}) → HTTP ${check.status()} ${(await check.text()).slice(0, 300)}`);
      break;
    }
    row = await sourceRow(state, account.spaceId, app);
  }
  view = sourcesOf(await githubStatus(request, web)).find((item) => item.slug === app.slug || (row && item.id === row.id)) ?? null;
  return { sourceId: row?.id ?? null, status: row?.status ?? view?.status ?? 'inconnu', accounts: view?.accounts.length ? view.accounts : wanted, repoCount: view?.repoCount ?? null };
}
