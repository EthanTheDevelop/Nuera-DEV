import type { Metadata } from 'next';
import { requireContext } from '@/server/tenancy/context';
import { toAppError } from '@/server/errors';
import { getCapacity, listSessionProjects, listSessions } from '@/server/sessions';
import { parseHistoryParams, type SessionCapacity, type SessionListPage } from '@/features/sessions/lib/contract';
import { SessionsView, type SectionLoad } from '@/features/sessions/page/SessionsView';

export const metadata: Metadata = { title: 'Sessions' };
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function load<T>(fn: () => Promise<T>): Promise<SectionLoad<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    const appError = toAppError(error);
    if (appError.code === 'INTERNAL') console.error('[sessions] page', error);
    return {
      ok: false,
      error: {
        message: appError.message,
        ...(appError.detail ? { detail: appError.detail } : {}),
        ...(appError.raw ? { raw: appError.raw } : {}),
      },
    };
  }
}

/**
 * Sessions — D06 (desktop) / M06 (phone): capacity, sessions « EN COURS » (live through
 * session.status / session.permission), « HISTORIQUE » with its filters in the URL
 * (?filtre=&periode=&projet=&q=). Every section loads on its own: a failure stays inline (T4).
 */
export default async function SessionsPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await requireContext();
  const filters = parseHistoryParams(await searchParams);
  const [capacity, active, history, projects] = await Promise.all([
    load<SessionCapacity>(() => getCapacity(ctx)),
    load<SessionListPage>(() => listSessions(ctx, { status: 'active' })),
    load<SessionListPage>(() =>
      listSessions(ctx, { status: 'history', filter: filters.filter, period: filters.period, projectId: filters.projectId, q: filters.q }),
    ),
    load(() => listSessionProjects(ctx)),
  ]);
  return (
    <SessionsView
      filters={filters}
      capacity={capacity}
      active={active}
      history={history}
      projects={projects.ok ? projects.data : []}
    />
  );
}
