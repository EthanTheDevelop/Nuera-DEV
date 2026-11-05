import { Skeleton, SkeletonList } from '@/components/ui';

/** T1 · first load of Projets: header placeholders + the skeleton table (same metrics as the rows). */
export default function ProjectsLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <div className="flex flex-col gap-2">
        <Skeleton width={160} height={28} />
        <Skeleton width={320} height={14} />
      </div>
      <SkeletonList rows={4} label="Chargement des projets" card />
    </div>
  );
}
