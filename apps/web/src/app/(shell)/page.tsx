import type { Metadata } from 'next';
import { Suspense } from 'react';
import { HomeLoadError } from '@/features/home/HomeLoadError';
import { HomeSkeleton } from '@/features/home/HomeSkeleton';
import { HomeView } from '@/features/home/HomeView';
import { requireUser, type CurrentUser } from '@/server/auth/session';
import { getHomeData, type HomeData } from '@/server/home';

export const metadata: Metadata = { title: 'Accueil' };
export const dynamic = 'force-dynamic';

async function HomeContent({ user }: { user: CurrentUser }) {
  let data: HomeData;
  try {
    data = await getHomeData(user);
  } catch (error) {
    console.error('[accueil]', error);
    return <HomeLoadError />;
  }
  return <HomeView data={data} />;
}

/**
 * Accueil — D01 (desktop) / M01 (phone): server and Claude Code tiles, quick resume, live sessions,
 * recent projects, latest Git activity, integrations. T1 skeletons while the data arrives (a
 * Suspense boundary of this page only: the other sections keep their own loading states);
 * every tile degrades on its own; T5 / T6 are rendered by the shell.
 */
export default async function HomePage() {
  const user = await requireUser();
  return (
    <Suspense fallback={<HomeSkeleton />}>
      <HomeContent user={user} />
    </Suspense>
  );
}
