import { projects, sessions, worktrees } from '@nuera/db/schema';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { matchActions } from '@/features/search/contract';
import { closeHomeTestDb, prepareHomeTestDatabase, resetHomeTables } from '@/server/home/test/db';

beforeAll(async () => {
  await prepareHomeTestDatabase('search');
});
afterAll(async () => {
  await closeHomeTestDb();
});
beforeEach(async () => {
  await resetHomeTables();
});

async function db() {
  return (await import('@/server/db')).db;
}

async function seed() {
  const d = await db();
  const [devis, outils, archived] = await d
    .insert(projects)
    .values([
      { slug: 'devis-express', name: 'Devis Express', githubFullName: 'atelier-test/devis-express', cloneUrl: 'x', path: '/srv/dev/devis-express', status: 'ready' },
      { slug: 'outils-cli', name: 'Outils CLI', githubFullName: 'dev-test/outils-cli', cloneUrl: 'y', path: '/srv/dev/outils-cli', status: 'ready' },
      { slug: 'vieux-devis', name: 'Vieux devis', githubFullName: 'atelier-test/vieux', cloneUrl: 'z', path: '/srv/dev/vieux', status: 'ready', archivedAt: new Date() },
    ])
    .returning();
  const [wt] = await d.insert(worktrees).values({ projectId: outils!.id, name: 'export', branch: 'feature/export-csv', path: '/srv/dev/outils-wt' }).returning();
  await d.insert(sessions).values([
    { id: '00000000-0000-4000-8000-000000000001', projectId: devis!.id, title: 'Tests du parcours', status: 'running' },
    { id: '00000000-0000-4000-8000-000000000002', projectId: outils!.id, worktreeId: wt!.id, title: 'Nettoyage', status: 'finished' },
    { id: '00000000-0000-4000-8000-000000000003', projectId: outils!.id, title: 'Archivée', status: 'archived', archivedAt: new Date() },
  ]);
  return { devis: devis!, outils: outils!, archived: archived! };
}

describe('recherche globale', () => {
  it('trouve les projets par nom, dépôt ou chemin, les actifs avant les archivés', async () => {
    const { search } = await import('./index');
    const { devis, archived } = await seed();
    const byName = await search('devis');
    expect(byName.projects.map((p) => p.id)).toEqual([devis.id, archived.id]);
    expect(byName.projects[1]?.status).toBe('archived');
    expect(byName.projects[0]?.href).toBe(`/projets/${devis.id}`);
    expect((await search('dev-test/')).projects.map((p) => p.name)).toEqual(['Outils CLI']);
    expect((await search('/srv/dev/outils')).projects).toHaveLength(1);
  });

  it('trouve les sessions par titre, projet ou branche, sans les archivées', async () => {
    const { search } = await import('./index');
    await seed();
    expect((await search('parcours')).sessions.map((s) => s.title)).toEqual(['Tests du parcours']);
    const byBranch = await search('export-csv');
    expect(byBranch.sessions.map((s) => [s.title, s.branch, s.href])).toEqual([['Nettoyage', 'feature/export-csv', '/workspace/00000000-0000-4000-8000-000000000002']]);
    expect((await search('outils')).sessions.map((s) => s.title)).toEqual(['Nettoyage']);
  });

  it("traite % et _ comme des caractères et borne les résultats", async () => {
    const { search } = await import('./index');
    await seed();
    expect((await search('%')).projects).toHaveLength(0);
    expect((await search('e', 1)).projects).toHaveLength(1);
    expect(await search('   ')).toEqual({ query: '', projects: [], sessions: [], actions: [] });
  });

  it('propose les actions de navigation, sans accents requis', async () => {
    expect(matchActions('ajouter').map((a) => a.href)).toEqual(['/projets/nouveau']);
    expect(matchActions('reprise').map((a) => a.id)).toEqual(['sessions-reprise']);
    expect(matchActions('terminees').map((a) => a.id)).toEqual(['sessions-terminees']);
    expect(matchActions('mcp coolify').map((a) => a.id)).toEqual(['serveurs-mcp']);
    expect(matchActions('')).toEqual([]);
    const { search } = await import('./index');
    expect((await search('favori')).actions.map((a) => a.href)).toEqual(['/projets?filtre=favoris']);
  });
});
