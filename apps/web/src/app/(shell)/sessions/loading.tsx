import { PageHeader } from '@/components/shell/PageHeader';
import { Skeleton, SkeletonList } from '@/components/ui';

/** T1 while the server reads the sessions (silhouettes matching D06 / M06, no shimmer in reduced motion). */
export default function SessionsLoading() {
  return (
    <div className="flex min-w-0 flex-col gap-4 nav:gap-6" aria-busy="true">
      <PageHeader title="Sessions" subtitle={<Skeleton height={14} width={320} className="max-w-full" />} />
      <Skeleton height={68} className="rounded-xl" />
      <div className="flex gap-3 overflow-hidden nav:gap-6">
        <Skeleton height={203} width={340} className="max-w-[290px] rounded-xl nav:max-w-none" />
        <Skeleton height={203} width={340} className="hidden rounded-xl nav:block" />
        <Skeleton height={203} className="hidden flex-1 rounded-xl nav:block" />
      </div>
      <SkeletonList rows={4} card label="Chargement de l'historique des sessions" />
    </div>
  );
}
