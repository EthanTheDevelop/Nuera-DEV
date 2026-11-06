import type { Metadata } from 'next';
import { Suspense } from 'react';
import { HomeLoadError } from '@/features/home/HomeLoadError';
import { HomeSkeleton } from '@/features/home/HomeSkeleton';
import { HomeView } from '@/features/home/HomeView';
import { getHomeData, type HomeData } from '@/server/home';
import { requireContext, type RequestContext } from '@/server/tenancy/context';

export const metadata: Metadata = { title: 'Accueil' };
export const dynamic = 'force-dynamic';

async function HomeContent({ ctx }: { ctx: RequestContext }) {
  let data: HomeData;
  try {
    data = await getHomeData(ctx);
  } catch (error) {
    console.error('[accueil]', error);
    return <HomeLoadError />;
  }
  return <HomeView data={data} />;
}

/**
 * Accueil — D01 (desktop) / M01 (phone) of the signed-in account's space: « Premiers pas » until
 * Claude Code, GitHub and a first project are set up, server and Claude Code tiles (or « Aucun
 * serveur attribué »), quick resume, live sessions,
 * recent projects, latest Git activity, integrations. T1 skeletons while the data arrives (a
 * Suspense boundary of this page only: the other sections keep their own loading states);
 * every tile degrades on its own; T5 / T6 are rendered by the shell.
 */
export default async function HomePage() {
  const ctx = await requireContext();
  return (
    <Suspense fallback={<HomeSkeleton />}>
      <HomeContent ctx={ctx} />
    </Suspense>
  );
}
