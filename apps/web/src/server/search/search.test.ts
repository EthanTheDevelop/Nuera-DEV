import { projects, sessions, worktrees } from '@nuera/db/schema';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { actionsFor, matchActions } from '@/features/search/contract';
import { closeHomeTestDb, prepareHomeTestDatabase, resetHomeTables, TEST_ENVIRONMENT_ID, testContext } from '@/server/home/test/db';
import type { RequestContext } from '@/server/tenancy/context';
import { useTestEncryptionKey } from '@/server/tenancy/test/db';
import { createTestAccount } from '@/server/tenancy/test/fixtures';

let ctx: RequestContext;

beforeAll(async () => {
  useTestEncryptionKey();
  await prepareHomeTestDatabase('search');
});
afterAll(async () => {
  await closeHomeTestDb();
});
beforeEach(async () => {
  await resetHomeTables();
  ctx = testContext();
});

async function db() {
  return (await import('@/server/db')).db;
}

async function seed() {
  const d = await db();
  const inSpace = { spaceId: ctx.space.id, environmentId: TEST_ENVIRONMENT_ID };
  const [devis, outils, archived] = await d
    .insert(projects)
    .values([
      { ...inSpace, slug: 'devis-express', name: 'Devis Express', githubFullName: 'atelier-test/devis-express', cloneUrl: 'x', path: '/srv/dev/devis-express', status: 'ready' },
      { ...inSpace, slug: 'outils-cli', name: 'Outils CLI', githubFullName: 'dev-test/outils-cli', cloneUrl: 'y', path: '/srv/dev/outils-cli', status: 'ready' },
      { ...inSpace, slug: 'vieux-devis', name: 'Vieux devis', githubFullName: 'atelier-test/vieux', cloneUrl: 'z', path: '/srv/dev/vieux', status: 'ready', archivedAt: new Date() },
    ])
    .returning();
  const [wt] = await d.insert(worktrees).values({ projectId: outils!.id, environmentId: TEST_ENVIRONMENT_ID, name: 'export', branch: 'feature/export-csv', path: '/srv/dev/outils-wt' }).returning();
  await d.insert(sessions).values([
    { id: '00000000-0000-4000-8000-000000000001', projectId: devis!.id, environmentId: TEST_ENVIRONMENT_ID, title: 'Tests du parcours', status: 'running' },
    { id: '00000000-0000-4000-8000-000000000002', projectId: outils!.id, environmentId: TEST_ENVIRONMENT_ID, worktreeId: wt!.id, title: 'Nettoyage', status: 'finished' },
    { id: '00000000-0000-4000-8000-000000000003', projectId: outils!.id, environmentId: TEST_ENVIRONMENT_ID, title: 'Archivée', status: 'archived', archivedAt: new Date() },
  ]);
  return { devis: devis!, outils: outils!, archived: archived! };
}

describe('recherche globale', () => {
  it('trouve les projets par nom, dépôt ou chemin, les actifs avant les archivés', async () => {
    const { search } = await import('./index');
    const { devis, archived } = await seed();
    const byName = await search(ctx, 'devis');
    expect(byName.projects.map((p) => p.id)).toEqual([devis.id, archived.id]);
    expect(byName.projects[1]?.status).toBe('archived');
    expect(byName.projects[0]?.href).toBe(`/projets/${devis.id}`);
    expect((await search(ctx, 'dev-test/')).projects.map((p) => p.name)).toEqual(['Outils CLI']);
    expect((await search(ctx, '/srv/dev/outils')).projects).toHaveLength(1);
  });

  it('trouve les sessions par titre, projet ou branche, sans les archivées', async () => {
    const { search } = await import('./index');
    await seed();
    expect((await search(ctx, 'parcours')).sessions.map((s) => s.title)).toEqual(['Tests du parcours']);
    const byBranch = await search(ctx, 'export-csv');
    expect(byBranch.sessions.map((s) => [s.title, s.branch, s.href])).toEqual([['Nettoyage', 'feature/export-csv', '/workspace/00000000-0000-4000-8000-000000000002']]);
    expect((await search(ctx, 'outils')).sessions.map((s) => s.title)).toEqual(['Nettoyage']);
  });

  it("traite % et _ comme des caractères et borne les résultats", async () => {
    const { search } = await import('./index');
    await seed();
    expect((await search(ctx, '%')).projects).toHaveLength(0);
    expect((await search(ctx, 'e', 1)).projects).toHaveLength(1);
    expect(await search(ctx, '   ')).toEqual({ query: '', projects: [], sessions: [], actions: [] });
  });

  it('propose les actions de navigation, sans accents requis', async () => {
    expect(matchActions('ajouter').map((a) => a.href)).toEqual(['/projets/nouveau']);
    expect(matchActions('reprise').map((a) => a.id)).toEqual(['sessions-reprise']);
    expect(matchActions('terminees').map((a) => a.id)).toEqual(['sessions-terminees']);
    expect(matchActions('mcp coolify').map((a) => a.id)).toEqual(['serveurs-mcp']);
    expect(matchActions('')).toEqual([]);
    const { search } = await import('./index');
    expect((await search(ctx, 'favori')).actions.map((a) => a.href)).toEqual(['/projets?filtre=favoris']);
  });

  it("ne trouve jamais les projets ni les sessions d'un autre espace", async () => {
    const { search } = await import('./index');
    await seed();
    const other = await createTestAccount({ role: 'member', name: 'Léa Martin', environment: { configSource: 'db', name: 'VPS-4' } });
    const results = await search(other.ctx, 'devis');
    expect(results.projects).toEqual([]);
    expect((await search(other.ctx, 'parcours')).sessions).toEqual([]);
    expect((await search(other.ctx, 'export-csv')).sessions).toEqual([]);
  });

  it("n'offre « Ajouter un projet » qu'à un compte qui a un serveur", async () => {
    const { search } = await import('./index');
    expect(actionsFor({ hasEnvironment: false }).some((a) => a.id === 'ajouter-projet')).toBe(false);
    expect(actionsFor({ hasEnvironment: true }).some((a) => a.id === 'ajouter-projet')).toBe(true);
    const lonely = await createTestAccount({ role: 'member', name: 'Sans Serveur', environment: false });
    expect((await search(lonely.ctx, 'ajouter')).actions).toEqual([]);
    expect((await search(ctx, 'ajouter')).actions.map((a) => a.id)).toEqual(['ajouter-projet']);
  });
});
