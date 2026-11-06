import { createDb } from '@nuera/db';
import { commandRuns, environments, githubSources, mcpServers, notifications, projects, sessions, spaceMembers, spaces, uptimeDaily, user, worktrees } from '@nuera/db/schema';
import { hashToken } from '@nuera/shared/tokens';
import { eq, ne, sql } from 'drizzle-orm';
import { E2E_DATABASE_URL, expect, test } from './fixtures';

/**
 * MISE À NIVEAU SANS INTERVENTION (MULTICOMPTE §1 invariant 4, §3.3, §12) — run ONLY with
 * E2E_UPGRADE=1 on a stack created BEFORE the multi-account rework (state.json version 1, database
 * at migration 0000 filled by the real seeds), then brought up with the current code: `up` applies
 * 0001 → 0004 to its database in place, exactly like `migrate` in production. Checks that nothing was
 * lost and that the single account of yesterday is the owner of today, on the default server
 * « VPS-3 », with its data, its GitHub source (same installations, no reconnection) and its history.
 *
 *   # on a stack seeded at the previous commit (here « ancienne », web 3951):
 *   node apps/web/e2e/harness/stack.mjs up --name ancienne --accounts 1
 *   node apps/web/e2e/harness/stack.mjs e2e --name ancienne -- --project mise-a-niveau   (E2E_UPGRADE=1)
 *
 * Every count is read from the database: the spec holds for any seeded stack.
 */
test.skip(process.env.E2E_UPGRADE !== '1', 'répétition de mise à niveau : E2E_UPGRADE=1 sur une pile créée avant la refonte');

const database = createDb(E2E_DATABASE_URL, { max: 2, applicationName: 'e2e-mise-a-niveau' });
test.afterAll(async () => {
  await database.$client.end({ timeout: 5 });
});

test("le compte d'hier est le propriétaire d'aujourd'hui, sur « VPS-3 », avec toutes ses données", async ({ page, stack }) => {
  const [owner] = await database.select().from(user).where(eq(user.email, stack.owner.email));
  expect(owner).toMatchObject({ role: 'owner', twoFactorEnabled: true, disabledAt: null });
  const personal = await database.select().from(spaces).where(eq(spaces.ownerUserId, owner!.id));
  expect(personal).toHaveLength(1);
  const [member] = await database.select().from(spaceMembers).where(eq(spaceMembers.userId, owner!.id));
  expect(member).toMatchObject({ spaceId: personal[0]!.id, role: 'owner' });

  const [server] = await database.select().from(environments).where(eq(environments.isDefault, true));
  expect(server).toMatchObject({ name: 'VPS-3', configSource: 'env', status: 'active', spaceId: personal[0]!.id, tokenHash: hashToken(stack.secrets.runnerToken) });

  // Every row of yesterday is attached to that space and that server.
  const detached = await database.select({ id: projects.id }).from(projects).where(sql`${projects.spaceId} <> ${personal[0]!.id} or ${projects.environmentId} <> ${server!.id}`);
  expect(detached).toEqual([]);
  for (const [label, table] of [
    ['worktrees', worktrees],
    ['sessions', sessions],
    ['command_runs', commandRuns],
  ] as const) {
    const foreign = await database.select({ id: table.id }).from(table).where(ne(table.environmentId, server!.id));
    expect(foreign, label).toEqual([]);
  }
  const orphanNotifications = await database.select({ id: notifications.id }).from(notifications).where(ne(notifications.userId, owner!.id));
  expect(orphanNotifications).toEqual([]);
  const orphanMcp = await database.select({ id: mcpServers.id }).from(mcpServers).where(ne(mcpServers.spaceId, personal[0]!.id));
  expect(orphanMcp).toEqual([]);

  // Seeded projects and sessions are all still there, sessions keep their state (resumable ones too).
  for (const project of Object.values(stack.seeded.projects ?? {})) {
    const [row] = await database.select({ id: projects.id, status: projects.status, githubSourceId: projects.githubSourceId }).from(projects).where(eq(projects.id, project.id));
    expect(row, project.fullName).toMatchObject({ status: 'ready' });
    expect(row!.githubSourceId, `${project.fullName} : source GitHub rattachée`).toBeTruthy();
  }
  const interrupted = stack.seeded.sessions?.interrupted;
  if (interrupted) {
    const [row] = await database.select({ status: sessions.status }).from(sessions).where(eq(sessions.id, interrupted.id));
    expect(row!.status).toBe('interrupted');
  }

  // The GitHub App became the space's source: same app, same installations, still connected.
  const [source] = await database.select().from(githubSources).where(eq(githubSources.spaceId, personal[0]!.id));
  expect(source).toMatchObject({ appId: stack.github.appId, status: 'connected' });
  expect(JSON.stringify(source!.config)).toContain(String(stack.github.accounts[0]!.installationId));

  // Availability history of the default server is kept under its historical key.
  const uptime = await database.select({ day: uptimeDaily.day }).from(uptimeDaily).where(eq(uptimeDaily.service, 'runner')).limit(1);
  expect(uptime.length).toBeGreaterThan(0);

  // The interface is the one of yesterday for this account.
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Bonjour ${stack.owner.name.split(' ')[0]}`, { timeout: 120_000 });
  await expect(page.getByText(/VPS-3/).first()).toBeVisible();
  const list = (await (await page.request.get('/api/projects')).json()) as { items: Array<{ id: string }> };
  for (const project of Object.values(stack.seeded.projects ?? {})) expect(list.items.map((item) => item.id)).toContain(project.id);
  const github = (await (await page.request.get('/api/integrations/github')).json()) as { status: string };
  expect(github.status).toBe('connected');
});
