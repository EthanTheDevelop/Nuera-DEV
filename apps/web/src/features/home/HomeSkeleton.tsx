import { Card, Skeleton, SkeletonList } from '@/components/ui';

function TileSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <Card variant="tile" className={className}>
      <div className="flex items-center gap-2">
        <Skeleton shape="circle" width={28} height={28} />
        <Skeleton width={120} height={12} />
        <span className="flex-1" />
        <Skeleton shape="pill" width={72} height={22} />
      </div>
      <div className="mt-5 flex flex-col gap-4">
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Skeleton width={`${80 - i * 12}%`} height={12} />
            <Skeleton width={`${60 - i * 8}%`} height={10} />
          </div>
        ))}
      </div>
    </Card>
  );
}

/**
 * T1 for the Accueil while `getHomeData` runs: the header and the tiles keep their places
 * (D01 grid / M01 stack), so nothing jumps when the data arrives. Static under reduced motion.
 */
export function HomeSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-5 nav:gap-6">
      <span className="sr-only">Chargement de l'accueil…</span>
      <div className="flex flex-col gap-2">
        <Skeleton width={220} height={26} />
        <Skeleton width={320} height={12} className="max-w-full" />
      </div>
      <div className="hidden flex-col gap-6 nav:flex">
        <div className="grid grid-cols-2 gap-6 xl:grid-cols-3">
          <TileSkeleton />
          <TileSkeleton />
          <TileSkeleton className="col-span-2 xl:col-span-1" />
        </div>
        <div className="grid grid-cols-2 gap-6 xl:grid-cols-[minmax(0,8fr)_minmax(0,8fr)_minmax(0,11fr)]">
          <TileSkeleton lines={2} />
          <TileSkeleton lines={2} />
          <SkeletonList rows={4} className="col-span-2 xl:col-span-1" />
        </div>
        <div className="grid grid-cols-2 gap-6 xl:grid-cols-3">
          <SkeletonList rows={4} className="col-span-2" />
          <SkeletonList rows={3} className="col-span-2 xl:col-span-1" />
        </div>
      </div>
      <div className="flex flex-col gap-5 nav:hidden">
        <div className="flex gap-2">
          <Skeleton shape="pill" width={120} height={27} />
          <Skeleton shape="pill" width={150} height={27} />
        </div>
        <TileSkeleton lines={2} />
        <SkeletonList rows={3} />
      </div>
    </div>
  );
}
