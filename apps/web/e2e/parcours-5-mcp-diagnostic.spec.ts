import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Response } from '@playwright/test';
import { createDb } from '@nuera/db';
import { auditLog, mcpServers, notifications, projectMcpServers } from '@nuera/db/schema';
import { and, eq } from 'drizzle-orm';
import { startFakeCoolify, type FakeCoolify } from '../src/server/coolify/test/fake-coolify';
import { startFakeMcp } from '../src/server/mcp/test/fake-mcp';
import { E2E_BASE_URL, E2E_DATABASE_URL, E2E_STACK_DIR, expect, hideNextDevIndicator, stackRunnerApi, test } from './fixtures';

/**
 * PARCOURS 5 — « Configuration MCP / secret → vraie connexion ou « connexion requise » →
 * diagnostic », driven through the UI (desktop D07 / D1 / D2 / D04, phone M07 / M04) against the
 * stack's REAL runner (pty backend, TEST-ONLY fake CLI), a fake Streamable-HTTP MCP server and a
 * fake Coolify started by this file on 127.0.0.1 (no Internet).
 *
 *   E2E_STACK=parcours5 pnpm --filter @nuera/web e2e parcours-5-mcp-diagnostic.spec.ts
 *
 * The session it starts is stopped at the end (the seeds keep 3 CLIs alive, limit 8).
 */
test.describe.configure({ mode: 'serial' });

const database = createDb(E2E_DATABASE_URL, { max: 1, applicationName: 'e2e-parcours-5' });
const created: string[] = [];
const isMobile = () => test.info().project.name === 'mobile';
const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const toast = (page: Page, message: string) => page.getByText(message, { exact: true }).first();
const mutate = (page: Page, method: 'DELETE' | 'POST', url: string) => page.request.fetch(url, { method, headers: { origin: E2E_BASE_URL } });
const CONNECT = fileURLToPath(new URL('./harness/mcp-connect.mjs', import.meta.url));

let coolify: FakeCoolify;

test.beforeAll(async () => {
  coolify = await startFakeCoolify();
  coolify.environments = [{ project: 'Nuera', uuid: 'p1', envs: ['development'] }];
  coolify.tokens.push({ value: '71|jeton-parcours-5', scoped: true, abilities: ['read', 'read:sensitive'] });
});

test.afterAll(async () => {
  const api = await stackRunnerApi();
  while (created.length > 0) {
    const sessionId = created.pop()!;
    const session = await api('getSession', { params: { sessionId } }).catch(() => null);
    if (session?.live) await api('stopSession', { params: { sessionId }, body: { force: true } }).catch(() => undefined);
  }
  await coolify?.close();
  await database.$client.end({ timeout: 5 });
});

async function openIntegrations(page: Page) {
  await page.goto('/integrations');
  await expect(page.getByRole('heading', { name: 'Intégrations', level: 1 })).toBeVisible({ timeout: 120_000 });
  await hideNextDevIndicator(page);
}

async function openServer(page: Page, label: string) {
  if (isMobile()) await page.getByRole('link', { name: label, exact: true }).click();
  else await page.getByRole('article', { name: label }).getByRole('link').click();
  const drawer = page.getByRole('dialog', { name: label });
  await expect(drawer).toBeVisible({ timeout: 60_000 });
  return drawer;
}

/** Every body of the app's API answers, to prove a secret never comes back to the browser. */
function recordApiBodies(page: Page): () => Promise<string> {
  const pending: Array<Promise<string>> = [];
  const listener = (response: Response) => {
    const { pathname } = new URL(response.url());
    // Live streams (SSE) never end: their events carry no secret either, but cannot be awaited.
    if (!pathname.startsWith('/api/') || pathname.startsWith('/api/stream/') || (response.headers()['content-type'] ?? '').includes('event-stream')) return;
    pending.push(response.text().catch(() => ''));
  };
  page.on('response', listener);
  return async () => {
    page.off('response', listener);
    return (await Promise.all(pending)).join('\n');
  };
}

test('Serveur MCP à jeton : connexion réelle, session sans secret, autorisation expirée, remplacement, garde-fous', async ({ page, stack, runnerApi, cli }) => {
  test.setTimeout(8 * 60_000);
  const project = stack.seeded.projects!.outils!;
  const u = unique();
  const variant = isMobile() ? 'mobile' : 'bureau';
  const label = `Docs P5 ${variant}`;
  const name = `docs-p5-${variant}`;
  const secret = `p5-secret-${u}-0123456789`;
  const rotated = `p5-rotated-${u}-0123456789`;
  const fake = await startFakeMcp({ expectedAuthorization: `Bearer ${secret}`, tools: ['search_docs', 'read_doc'], serverName: 'Docs P5' });
  await database.delete(mcpServers).where(eq(mcpServers.name, name));
  await mutate(page, 'DELETE', '/api/integrations/coolify');
  const apiBodies = recordApiBodies(page);
  try {
    // --- 1. Intégrations « Ajouter un serveur MCP » (HTTP, jeton : SecretField, jamais renvoyé).
    await openIntegrations(page);
    await page.getByRole('button', { name: 'Ajouter un serveur MCP' }).last().click();
    const dialog = page.getByRole('dialog', { name: 'Ajouter un serveur MCP' });
    await dialog.getByLabel('Nom', { exact: true }).fill(label);
    await expect(dialog.getByLabel('Identifiant')).toHaveValue(name);
    await dialog.getByLabel('Adresse').fill(fake.url);
    await dialog.getByRole('combobox', { name: 'Authentification' }).click();
    await page.getByRole('option', { name: 'Jeton' }).click();
    const tokenField = dialog.getByLabel('Jeton', { exact: true });
    await expect(tokenField).toHaveAttribute('type', 'password');
    await tokenField.fill(secret);
    await dialog.getByRole('button', { name: 'Ajouter le serveur' }).click();
    await expect(toast(page, `Serveur MCP « ${label} » ajouté`)).toBeVisible({ timeout: 30_000 });
    let drawer = page.getByRole('dialog', { name: label });
    await expect(drawer).toBeVisible({ timeout: 60_000 });
    await expect(drawer.getByText('en-têtes chiffrés · Authorization')).toBeVisible();
    // Real effect: stored encrypted, only the header name in clear.
    const [row] = await database.select().from(mcpServers).where(eq(mcpServers.name, name));
    expect(row).toMatchObject({ transport: 'http', url: fake.url, authKind: 'bearer', secretKeys: ['Authorization'] });
    expect(row!.secretsEncrypted).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(secret);

    // --- 2. « Tester la connexion » → Connecté, outils lus par tools/list (D1).
    await drawer.getByRole('button', { name: 'Tester la connexion' }).click();
    await expect(toast(page, `Connexion à ${label} vérifiée`)).toBeVisible({ timeout: 30_000 });
    // Enabled in no project yet: the badge says « Désactivé », the test line gives the real result.
    await expect(drawer.getByText('manuelle (aucun projet) · OK')).toBeVisible();
    await expect(drawer.getByText('2 outils', { exact: false })).toBeVisible();
    expect((await database.select().from(mcpServers).where(eq(mcpServers.name, name)))[0]!.status).toBe('connected');
    expect(fake.state.methods).toEqual(expect.arrayContaining(['initialize', 'tools/list']));
    expect(fake.state.receivedHeaders.at(-1)?.authorization).toBe(`Bearer ${secret}`);
    expect(await page.content()).not.toContain(secret);
    await drawer.getByRole('button', { name: 'Fermer' }).last().click();
    await expect(page).toHaveURL(/\/integrations$/);

    // --- 3. Coolify connected while its MCP server is unreachable: rights unverified, kept from Claude.
    coolify.mcp.forceStatus = 503;
    drawer = await openServer(page, 'Coolify');
    await drawer.getByLabel('Adresse de Coolify').fill(coolify.url);
    await drawer.getByLabel('Nouveau jeton Coolify').fill('71|jeton-parcours-5');
    await drawer.getByRole('button', { name: 'Reconnecter' }).click();
    await expect(toast(page, 'Coolify connecté')).toBeVisible({ timeout: 30_000 });
    drawer = await openServer(page, 'Coolify');
    await expect(drawer.getByText("Droits du jeton non vérifiés sans le serveur MCP : Claude ne l'utilisera qu'après un test réussi du serveur MCP Coolify.")).toBeVisible();
    await drawer.getByRole('switch', { name: project.name }).click();
    await expect(drawer.getByRole('switch', { name: project.name })).toHaveAttribute('aria-checked', 'true');
    await drawer.getByRole('button', { name: 'Fermer' }).last().click();

    // --- 4. Project page « Outils MCP » (D04 / M04): enable the new server for the project.
    await page.goto(`/projets/${project.id}?onglet=outils-mcp`);
    await expect(page.getByRole('heading', { name: project.name, level: 1 }).filter({ visible: true }).first()).toBeVisible({ timeout: 120_000 });
    await hideNextDevIndicator(page);
    const projectSwitch = page.getByRole('switch', { name: label }).filter({ visible: true }).first();
    await expect(projectSwitch).toHaveAttribute('aria-checked', 'false');
    await projectSwitch.click();
    await expect(projectSwitch).toHaveAttribute('aria-checked', 'true');
    await expect
      .poll(async () => (await database.select().from(projectMcpServers).where(and(eq(projectMcpServers.projectId, project.id), eq(projectMcpServers.mcpServerId, row!.id))))[0]?.enabled)
      .toBe(true);

    // --- 5. New session on that project: its --mcp-config holds the server WITHOUT the secret.
    await page.getByRole('button', { name: 'Actions du projet' }).filter({ visible: true }).first().click();
    if (isMobile()) await page.getByRole('dialog', { name: project.name }).getByRole('button', { name: 'Nouvelle session ici' }).click();
    else await page.getByRole('menuitem', { name: 'Nouvelle session ici' }).click();
    const newSession = page.getByRole('dialog', { name: 'Nouvelle session' });
    await expect(newSession).toBeVisible();
    await newSession.getByLabel('Titre').fill(`Parcours 5 ${u}`);
    await newSession.getByLabel('Nom de la nouvelle branche').fill(`test/parcours-5-${u}`);
    await newSession.getByRole('button', { name: 'Créer la session' }).click();
    await page.waitForURL(/\/workspace\/[0-9a-f-]{36}/, { timeout: 120_000 });
    const sessionId = page.url().split('/workspace/')[1]!.split(/[?#]/)[0]!;
    created.push(sessionId);
    const mcpFile = path.join(E2E_STACK_DIR, 'runner-data', 'sessions', sessionId, 'mcp.json');
    await expect.poll(() => existsSync(mcpFile), { timeout: 60_000 }).toBe(true);
    const mcpText = readFileSync(mcpFile, 'utf8');
    const config = JSON.parse(mcpText) as { mcpServers: Record<string, { type: string; url: string; headers?: unknown; headersHelper?: string }> };
    expect(config.mcpServers[name]).toMatchObject({ type: 'http', url: fake.url });
    expect(config.mcpServers[name]!.headers).toBeUndefined();
    expect(config.mcpServers[name]!.headersHelper).toMatch(/nuera-mcp-headers\.mjs"$/);
    // Coolify, enabled too, is left out: its token rights were never verified (P4).
    expect(Object.keys(config.mcpServers)).not.toContain('coolify');
    expect(mcpText).not.toContain(secret);
    expect(mcpText).not.toContain('jeton-parcours-5');

    // The fake CLI connects the way Claude Code does: headersHelper → runner → web → headers.
    await expect(page.getByRole('heading', { name: /Claude Code est prêt/ })).toBeVisible({ timeout: 60_000 });
    const before = fake.state.receivedHeaders.length;
    const instruction = `${await cli.script(`parcours5-${u}`, {
      description: 'Connexion au serveur MCP de la session',
      steps: [
        { bash: { command: `"${process.execPath}" "${CONNECT}" "${mcpFile}" ${name}`, description: 'Se connecte au serveur MCP.', run: true }, ask: false },
        { final: 'Le serveur MCP de la documentation répond.' },
      ],
    })} Vérifie le serveur MCP de la documentation.`;
    const input = page.getByRole('textbox', { name: 'Instruction pour Claude' });
    await expect(input).not.toHaveAttribute('readonly', '');
    await input.fill(instruction);
    if (isMobile()) await page.getByRole('button', { name: 'Envoyer' }).click();
    else await input.press('Enter');
    await cli.waitForTurn(sessionId, instruction);
    await expect(page.getByRole('log', { name: 'Fil de la session' }).getByText('Le serveur MCP de la documentation répond.')).toBeVisible({ timeout: 60_000 });
    const sessionCalls = fake.state.receivedHeaders.slice(before);
    expect(sessionCalls.at(-1)?.authorization).toBe(`Bearer ${secret}`);
    expect(await page.content()).not.toContain(secret);
    await runnerApi('stopSession', { params: { sessionId }, body: { force: true } });

    // --- 6. The MCP server refuses the token → « Autorisation expirée », diagnostic, notification.
    fake.state.expectedAuthorization = `Bearer ${rotated}`;
    await openIntegrations(page);
    drawer = await openServer(page, label);
    await drawer.getByRole('button', { name: 'Tester la connexion' }).click();
    await expect(drawer.getByText('Autorisation expirée', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await expect(drawer.getByText(`n'ont plus accès au serveur MCP ${label}.`, { exact: false })).toBeVisible();
    await expect(drawer.getByText('Test de connexion : Autorisation expirée')).toBeVisible();
    await expect(drawer.getByText("Aucun réglage n'a été modifié : les projets gardent leur activation.")).toBeVisible();
    await expect
      .poll(async () => (await database.select().from(notifications).where(eq(notifications.dedupKey, `integration:mcp:${name}:expired`))).map((item) => item.title))
      .toEqual([`L'accès ${label} a été retiré`]);
    const [expired] = await database.select().from(mcpServers).where(eq(mcpServers.name, name));
    expect(expired!.status).toBe('expired');

    // --- 7. « Reconnecter » with a new secret (D2) → back to « Connecté », notification resolved.
    const replaceField = drawer.getByLabel(`Nouveau secret de ${label}`);
    await expect(replaceField).toHaveAttribute('type', 'password');
    await replaceField.fill(rotated);
    await drawer.getByRole('button', { name: 'Reconnecter' }).click();
    await expect(toast(page, `${label} reconnecté`)).toBeVisible({ timeout: 30_000 });
    await expect(drawer.getByText('Connecté', { exact: true }).first()).toBeVisible();
    expect(fake.state.receivedHeaders.at(-1)?.authorization).toBe(`Bearer ${rotated}`);
    const [fixed] = await database.select().from(mcpServers).where(eq(mcpServers.name, name));
    expect(fixed!.status).toBe('connected');
    expect(await page.content()).not.toContain(rotated);
    const audits = (await database.select().from(auditLog).where(eq(auditLog.targetId, row!.id))).map((item) => item.action);
    expect(audits).toEqual(expect.arrayContaining(['integration.mcp.created', 'integration.mcp.checked', 'integration.mcp.credentials_updated']));

    // --- 8. Guardrail « Désactiver partout » (T8) → no project offers it any more.
    await drawer.getByRole('button', { name: 'Désactiver partout' }).click();
    const confirm = page.getByRole('alertdialog', { name: `Désactiver ${label} partout ?` });
    await expect(confirm.getByText('Les sessions déjà en cours gardent leur configuration actuelle.')).toBeVisible();
    await confirm.getByRole('button', { name: 'Désactiver partout' }).click();
    await expect(toast(page, `${label} désactivé dans 1 projet`)).toBeVisible({ timeout: 30_000 });
    await expect(drawer.getByRole('switch', { name: project.name })).toHaveAttribute('aria-checked', 'false');
    const activations = await database.select().from(projectMcpServers).where(eq(projectMcpServers.mcpServerId, row!.id));
    expect(activations.every((item) => !item.enabled)).toBe(true);

    // The browser never received any secret from the app's API.
    const bodies = await apiBodies();
    for (const value of [secret, rotated, '71|jeton-parcours-5']) expect(bodies).not.toContain(value);
  } finally {
    await Promise.race([apiBodies(), new Promise((resolve) => setTimeout(resolve, 2_000))]).catch(() => '');
    await fake.close();
    coolify.mcp.forceStatus = null;
    await mutate(page, 'DELETE', '/api/integrations/coolify').catch(() => undefined);
    await database.delete(projectMcpServers).where(eq(projectMcpServers.projectId, project.id));
    await database.delete(mcpServers).where(eq(mcpServers.name, name));
  }
});
