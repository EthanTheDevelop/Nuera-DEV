/**
 * TEST-ONLY — connects the stack's GitHub App through the REAL web routes, against the fake GitHub:
 *   POST /api/integrations/github/manifest  → page that posts the manifest to « github.com »
 *   fake github.com « Create GitHub App »    → /api/integrations/github/callback?code&state
 *   callback (manifest conversion, credentials stored encrypted) → installation page
 *   installation page (one per test account) → /api/integrations/github/setup?installation_id&state
 *   second account: GET /api/integrations/github/install (fresh signed state) → same steps.
 * The integration rows are therefore the genuine ones (the same code as the owner's clicks).
 */
import type { APIRequestContext } from '@playwright/test';
import type { StackState } from './state';

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
  status: string;
  accounts: string[];
  repoCount: number | null;
}

interface GithubStatusBody {
  mode?: string;
  status?: string;
  app?: { slug: string } | null;
  accounts?: Array<{ login: string }>;
  repoCount?: number | null;
}

async function githubStatus(request: APIRequestContext, web: string): Promise<GithubStatusBody> {
  const response = await request.get(`${web}/api/integrations/github`);
  if (!response.ok()) throw new Error(`GET /api/integrations/github → HTTP ${response.status()}`);
  return (await response.json()) as GithubStatusBody;
}

/** Follows the fake installation pages for one account and returns the outcome given by the setup route. */
async function installOn(request: APIRequestContext, state: StackState, installUrl: string, account: StackState['github']['accounts'][number]): Promise<string> {
  const web = state.urls.web;
  const pick = new URL(installUrl);
  pick.searchParams.set('target_id', String(account.id));
  const permissions = location(await request.get(pick.toString(), { maxRedirects: 0 }), state.urls.githubWeb, `installation sur ${account.login}`);
  const setup = location(await request.get(permissions, { maxRedirects: 0 }), state.urls.githubWeb, `autorisation sur ${account.login}`);
  if (!setup.startsWith(`${web}/api/integrations/github/setup`)) throw new Error(`Retour d'installation inattendu : ${setup}`);
  const back = location(await request.get(setup, { maxRedirects: 0 }), web, 'retour de GitHub (setup)');
  return new URL(back).searchParams.get('github') ?? 'inconnu';
}

export async function connectGithubApp(request: APIRequestContext, state: StackState, log: (line: string) => void): Promise<GithubConnection> {
  const web = state.urls.web;
  let current = await githubStatus(request, web);
  const wanted = state.github.accounts;
  const installed = new Set((current.accounts ?? []).map((account) => account.login));

  if (current.mode !== 'app' || !current.app) {
    log('  GitHub : création de l’application (manifest)…');
    const appOwner = wanted[0]!;
    const page = await request.post(`${web}/api/integrations/github/manifest`, {
      form: { organization: appOwner.type === 'Organization' ? appOwner.login : '', public: 'true' },
      headers: { origin: web },
      maxRedirects: 0,
    });
    if (!page.ok()) throw new Error(`POST /api/integrations/github/manifest → HTTP ${page.status()} ${(await page.text()).slice(0, 300)}`);
    const form = parseManifestForm(await page.text());
    if (!form.action.startsWith(state.urls.githubWeb)) throw new Error(`Le manifest part vers ${form.action} au lieu du faux GitHub (${state.urls.githubWeb}).`);
    const callback = location(await request.post(form.action, { form: { manifest: form.manifest }, maxRedirects: 0 }), state.urls.githubWeb, 'création de l’application');
    const install = location(await request.get(callback, { maxRedirects: 0 }), web, 'retour de GitHub (callback)');
    if (!install.startsWith(state.urls.githubWeb)) throw new Error(`Conversion du manifest refusée : ${install}`);
    const outcome = await installOn(request, state, install, appOwner);
    log(`  GitHub : application installée sur ${appOwner.login} (${outcome})`);
    installed.add(appOwner.login);
  }

  for (const account of wanted) {
    if (installed.has(account.login)) continue;
    const install = location(await request.get(`${web}/api/integrations/github/install`, { maxRedirects: 0 }), web, 'installation sur un autre compte');
    const outcome = await installOn(request, state, install, account);
    log(`  GitHub : application installée sur ${account.login} (${outcome})`);
  }

  current = await githubStatus(request, web);
  if (current.status !== 'connected') {
    const check = await request.post(`${web}/api/integrations/github/check`, { headers: { origin: web } });
    if (!check.ok()) throw new Error(`Vérification GitHub → HTTP ${check.status()} ${(await check.text()).slice(0, 300)}`);
    current = await githubStatus(request, web);
  }
  return { status: current.status ?? 'inconnu', accounts: (current.accounts ?? []).map((account) => account.login), repoCount: current.repoCount ?? null };
}
