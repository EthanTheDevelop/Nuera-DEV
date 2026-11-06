import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { buildZip } from '../src/server/claude-config/test/zip';
import { adminCall, expect, hideNextDevIndicator, requireAccounts, stackRunnerApi, stackRunnerOf, test, type StackFixtures, type StackKey } from './fixtures';

/**
 * Configuration Claude commune (lot K1), two accounts and two runners: the owner (A) writes a rule in
 * Administration › Claude and imports a skill (.zip) there; an administrators-only MCP server, an
 * « Imposé » rule and an « Imposé » permission are added through the routes. A new session of each
 * account, created through the web (its launch options), starts the fake CLI of its server, which
 * records what a real CLI would load (`nuera-fake-launch/<session>.json`: flags, settings, MCP
 * servers, appended system prompt, user-level rules and skills of its Claude folder):
 *   - A (owner) receives everything, the administrators-only server included;
 *   - B (member) receives the rule, the skill and the permission, NEVER the administrators-only server.
 * Phone: the member reads what applies to them in Paramètres › Claude Code; the owner sees the rule.
 *
 *   node apps/web/e2e/harness/stack.mjs up --name config --web-port 3660 --accounts 2
 *   node apps/web/e2e/harness/stack.mjs seed --name config projects && … --as b projects
 *   node apps/web/e2e/harness/stack.mjs e2e --name config -- configuration-commune.spec.ts
 */
test.describe.configure({ mode: 'serial' });
requireAccounts(2);

const isMobile = () => test.info().project.name === 'mobile';
const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const RULE_TITLE = `Messages de commit ${tag}`;
const RULE_BODY = `Messages conventionnels sobres, marqueur ${tag}.`;
const LOCKED_TITLE = `Secrets ${tag}`;
const SKILL_NAME = `revue-${tag}`;
const MCP_NAME = `docs-admin-${tag}`.slice(0, 40);
const DENY_RULE = `Bash(rm -rf /tmp/${tag}*)`;

const created = { rules: [] as string[], skills: [] as string[], mcp: [] as string[], sessions: [] as Array<{ key: StackKey; id: string }> };

async function json(request: APIRequestContext, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, data?: unknown) {
  const answer = await adminCall(request, method, url, data);
  expect(answer.status, answer.text).toBeLessThan(300);
  return answer.body as Record<string, any>;
}

/** Session created by the web (`POST /api/sessions`, launch options of the account) and started by its first instruction. */
async function startSession(request: APIRequestContext, key: StackKey, projectId: string): Promise<string> {
  const body = await json(request, 'POST', '/api/sessions', {
    projectId,
    title: `Configuration commune ${tag} ${key}`,
    branch: { mode: 'new', branch: `config-${tag}-${key}` },
    permissionMode: 'manual',
    instruction: 'Bonjour',
  });
  const sessionId = String(body.sessionId);
  created.sessions.push({ key, id: sessionId });
  return sessionId;
}

/** What the fake CLI of that server received at launch (TEST-ONLY file of apps/runner/test/fixtures/fake-claude.mjs). */
async function launchRecord(key: StackKey, sessionId: string) {
  const runner = await stackRunnerOf(key);
  const file = path.join(runner.paths.claudeConfig, 'nuera-fake-launch', `${sessionId}.json`);
  await expect.poll(() => existsSync(file), { timeout: 120_000, message: `lancement du CLI de ${sessionId}` }).toBe(true);
  return JSON.parse(readFileSync(file, 'utf8')) as {
    argv: string[];
    permissions: { allow?: string[]; ask?: string[]; deny?: string[] };
    mcpServers: string[];
    appendSystemPrompt: string | null;
    userRules: string | null;
    skills: Array<{ name: string; common: boolean }>;
  };
}

/** Removes what this spec created (as the owner): the next run starts from the same state. */
async function cleanup(request: APIRequestContext): Promise<void> {
  for (const id of created.rules.splice(0)) await adminCall(request, 'DELETE', `/api/admin/claude/rules/${id}`);
  for (const id of created.skills.splice(0)) await adminCall(request, 'DELETE', `/api/admin/claude/skills/${id}`);
  for (const id of created.mcp.splice(0)) await adminCall(request, 'DELETE', `/api/admin/claude/mcp/${id}`);
  const overview = (await adminCall(request, 'GET', '/api/admin/claude')).body as { rows?: { policy?: { deny: Array<{ rule: string }>; version: number } } } | null;
  const policy = overview?.rows?.policy;
  if (policy?.deny.some((entry) => entry.rule === DENY_RULE)) {
    await adminCall(request, 'PATCH', '/api/admin/claude/policy', { deny: policy.deny.filter((entry) => entry.rule !== DENY_RULE), expectedVersion: policy.version });
  }
}

async function projectOf(key: StackKey): Promise<string> {
  const { stackState } = await import('./fixtures');
  const { seededOf } = await import('./harness/state');
  const project = seededOf(await stackState(), key).projects?.devis;
  if (!project) throw new Error(`projet « devis » absent du compte ${key} : lancez seed projects`);
  return project.id;
}

test.afterAll(async () => {
  for (const { key, id } of created.sessions.splice(0)) {
    const api = await stackRunnerApi(key);
    const session = await api('getSession', { params: { sessionId: id } }).catch(() => null);
    if (session?.live) await api('stopSession', { params: { sessionId: id }, body: { force: true } }).catch(() => undefined);
  }
});

test.describe('configuration commune', () => {
  test.beforeAll(async ({ seed }) => {
    await seed('projects');
    await seed('projects', { account: 'b' });
  });

  test("bureau : l'administration écrit une règle et importe un skill ; chaque session reçoit ce qui lui revient", async ({ page, as }) => {
    test.skip(isMobile(), 'Parcours bureau ; le téléphone est vérifié par le test suivant.');
    test.setTimeout(360_000);
    try {
      await desktopRun(page, as);
    } finally {
      await cleanup(page.request);
    }
  });

  test("téléphone : le membre lit la configuration qui s'applique à lui, le propriétaire voit la règle", async ({ page, as }) => {
    test.skip(!isMobile(), 'Vérifié au téléphone.');
    test.setTimeout(240_000);
    try {
      await phoneRun(page, as);
    } finally {
      await cleanup(page.request);
    }
  });
});

type As = StackFixtures['as'];

async function desktopRun(page: Page, as: As): Promise<void> {
  // 1. Rule written in the UI (« Par défaut »).
  await page.goto('/administration?onglet=claude');
  await hideNextDevIndicator(page);
  await expect(page.getByRole('heading', { name: 'Configuration Claude commune' })).toBeVisible({ timeout: 120_000 });
  await page.getByRole('button', { name: 'Nouvelle règle' }).first().click();
  const ruleDialog = page.getByRole('dialog', { name: 'Nouvelle règle' });
  await ruleDialog.getByRole('textbox', { name: 'Titre' }).fill(RULE_TITLE);
  await ruleDialog.getByRole('textbox', { name: 'Texte' }).fill(RULE_BODY);
  await ruleDialog.getByRole('button', { name: 'Ajouter la règle' }).click();
  await expect(page.getByText(`Règle « ${RULE_TITLE} » ajoutée`, { exact: true })).toBeVisible();
  await expect(page.getByText(RULE_TITLE, { exact: true })).toBeVisible();

  // 2. Skill imported from a .zip in the UI: scripts refused, then accepted once allowed.
  await page.getByRole('tab', { name: 'Skills' }).click();
  await page.getByRole('button', { name: 'Importer un skill (.zip)' }).first().click();
  const importDialog = page.getByRole('dialog', { name: 'Importer un skill (.zip)' });
  const zip = buildZip([
    { name: `${SKILL_NAME}/SKILL.md`, content: `---\nname: ${SKILL_NAME}\ndescription: Relecture de test ${tag}.\n---\n\n# Relecture\n` },
    { name: `${SKILL_NAME}/references/liste.md`, content: '- tests\n' },
    { name: `${SKILL_NAME}/scripts/verifier.sh`, content: '#!/bin/sh\necho ok\n' },
  ]);
  await importDialog.getByLabel('Archive .zip').setInputFiles({ name: `${SKILL_NAME}.zip`, mimeType: 'application/zip', buffer: zip });
  await importDialog.getByRole('button', { name: 'Importer' }).click();
  await expect(importDialog.getByRole('alert')).toContainText('Ce skill contient un script : scripts/verifier.sh.');
  await importDialog.getByRole('checkbox', { name: 'Autoriser les scripts' }).click();
  await expect(importDialog.getByText('Scripts exécutables sur chaque serveur')).toBeVisible();
  await importDialog.getByRole('button', { name: 'Importer' }).click();
  await expect(page.getByText(`Skill importé : « ${SKILL_NAME} » (version 1) · 1 script`, { exact: true })).toBeVisible();
  await expect(page.getByText(`/${SKILL_NAME}`, { exact: true })).toBeVisible();

  // 3. Through the routes: an « Imposé » rule, an administrators-only MCP server, an « Imposé » deny rule.
  const overview = await json(page.request, 'GET', '/api/admin/claude');
  created.rules.push(...(overview.rows.rules as Array<{ id: string; title: string }>).filter((rule) => rule.title === RULE_TITLE).map((rule) => rule.id));
  created.skills.push(...(overview.rows.skills as Array<{ id: string; name: string }>).filter((skill) => skill.name === SKILL_NAME).map((skill) => skill.id));
  const locked = await json(page.request, 'POST', '/api/admin/claude/rules', { title: LOCKED_TITLE, body: `Jamais de secret ${tag}.`, enforcement: 'locked' });
  created.rules.push(locked.rule.id);
  const mcp = await json(page.request, 'POST', '/api/admin/claude/mcp', { kind: 'custom', name: MCP_NAME, label: 'Docs (administrateurs)', transport: 'http', url: 'https://docs.example.test/mcp', audience: 'admins' });
  created.mcp.push(mcp.server.id);
  const policy = overview.rows.policy as { deny: Array<{ id: string; rule: string; enforcement: string }>; version: number };
  await json(page.request, 'PATCH', '/api/admin/claude/policy', { deny: [...policy.deny, { rule: DENY_RULE, enforcement: 'locked' }], expectedVersion: policy.version });

  // 4. A new session of the owner: everything, the administrators-only server included.
  const ownerSession = await startSession(page.request, 'a', await projectOf('a'));
  const owner = await launchRecord('a', ownerSession);
  expect(owner.userRules).toContain(RULE_BODY);
  expect(owner.appendSystemPrompt).toContain(`## ${LOCKED_TITLE}`);
  expect(owner.argv).toContain('--append-system-prompt-file');
  expect(owner.skills).toContainEqual({ name: SKILL_NAME, common: true });
  expect(owner.mcpServers).toContain(MCP_NAME);
  expect(owner.permissions.deny).toContain(DENY_RULE);
  const runnerA = await stackRunnerOf('a');
  const script = path.join(runnerA.paths.claudeConfig, 'skills', SKILL_NAME, 'scripts', 'verifier.sh');
  expect(existsSync(script)).toBe(true);
  expect(existsSync(path.join(runnerA.paths.claudeConfig, '.credentials.json'))).toBe(false);

  // The Workspace shows what the session received.
  await page.goto(`/workspace/${ownerSession}`);
  await hideNextDevIndicator(page);
  const chip = page.getByTestId('configuration-commune');
  await expect(chip).toContainText('Configuration commune', { timeout: 120_000 });
  await chip.click();
  const sheet = page.getByRole('dialog', { name: 'Configuration commune de la session' });
  await expect(sheet.getByText(LOCKED_TITLE, { exact: true })).toBeVisible();
  await expect(sheet.getByText(`/${SKILL_NAME}`, { exact: true })).toBeVisible();
  await expect(sheet.getByText('Docs (administrateurs)', { exact: true })).toBeVisible();

  // 5. A new session of the member (its own server): rules, skill, permission — never the administrators-only server.
  const b = await as('b');
  const memberSession = await startSession(b.context.request, 'b', await projectOf('b'));
  const member = await launchRecord('b', memberSession);
  expect(member.userRules).toContain(RULE_BODY);
  expect(member.appendSystemPrompt).toContain(`## ${LOCKED_TITLE}`);
  expect(member.skills).toContainEqual({ name: SKILL_NAME, common: true });
  expect(member.permissions.deny).toContain(DENY_RULE);
  expect(member.mcpServers).not.toContain(MCP_NAME);
  expect(JSON.stringify(member)).not.toContain(MCP_NAME);
  // And the member's routes refuse the administration.
  expect((await adminCall(b.context.request, 'GET', '/api/admin/claude')).status).toBe(403);
  const mine = await json(b.context.request, 'GET', '/api/claude/config');
  expect(JSON.stringify(mine)).not.toContain(MCP_NAME);
}

async function phoneRun(page: Page, as: As): Promise<void> {
  // State of the desktop run (serial, same stack): created again when this project runs alone.
  const overview = await json(page.request, 'GET', '/api/admin/claude');
  if (!(overview.rows.rules as Array<{ title: string }>).some((rule) => rule.title === RULE_TITLE)) {
    const rule = await json(page.request, 'POST', '/api/admin/claude/rules', { title: RULE_TITLE, body: RULE_BODY });
    created.rules.push(rule.rule.id);
    const mcp = await json(page.request, 'POST', '/api/admin/claude/mcp', { kind: 'custom', name: MCP_NAME, label: 'Docs (administrateurs)', transport: 'http', url: 'https://docs.example.test/mcp', audience: 'admins' });
    created.mcp.push(mcp.server.id);
  }

  await page.goto('/administration?onglet=claude');
  await hideNextDevIndicator(page);
  await expect(page.getByText(RULE_TITLE, { exact: true })).toBeVisible({ timeout: 120_000 });

  const b = await as('b', { mobile: true });
  await b.page.goto('/parametres?onglet=claude-code');
  await hideNextDevIndicator(b.page);
  const card = b.page.getByRole('region', { name: 'Configuration commune' });
  await expect(card).toBeVisible({ timeout: 120_000 });
  await card.getByRole('button', { name: 'Voir le détail' }).click();
  const details = b.page.getByRole('dialog', { name: 'Configuration commune' });
  await expect(details.getByText(RULE_TITLE, { exact: true })).toBeVisible();
  await expect(details.getByText('Docs (administrateurs)')).toHaveCount(0);
  await details.getByRole('button', { name: 'Fermer' }).first().click();
}

