import { Skeleton, SkeletonList } from '@/components/ui';

/** T1 · project page loading: header, tabs and the two tile columns as silhouettes. */
export default function ProjectLoading() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true">
      <div className="flex flex-col gap-2">
        <Skeleton width={140} height={12} />
        <Skeleton width={240} height={28} />
        <Skeleton width={420} height={14} />
      </div>
      <Skeleton width={520} height={22} shape="pill" />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex flex-col gap-5">
          <SkeletonList rows={4} label="Chargement du projet" card />
          <SkeletonList rows={3} card />
        </div>
        <div className="flex flex-col gap-5">
          <SkeletonList rows={3} card />
          <SkeletonList rows={3} card />
        </div>
      </div>
    </div>
  );
}
