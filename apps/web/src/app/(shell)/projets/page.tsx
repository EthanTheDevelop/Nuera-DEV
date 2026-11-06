import type { Metadata } from 'next';
import { ProjectsView } from '@/features/projects/list/ProjectsView';
import { listProjects, listProjectsQuerySchema } from '@/server/projects';
import { requireContext } from '@/server/tenancy/context';

export const metadata: Metadata = { title: 'Projets' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** D02 / M02 — projects of the space, cloned on its server (?q=, ?filtre=tous|favoris|archives, ?tri=activite|nom|ajout). */
export default async function ProjectsPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await requireContext();
  const params = await searchParams;
  const parsed = listProjectsQuerySchema.safeParse({ q: first(params.q), filtre: first(params.filtre), tri: first(params.tri) });
  const query = parsed.success ? parsed.data : {};
  const data = await listProjects(ctx, { q: query.q, filter: query.filtre, sort: query.tri });
  return <ProjectsView data={data} query={{ q: query.q ?? '', filter: query.filtre ?? 'tous', sort: query.tri ?? 'activite' }} />;
}
