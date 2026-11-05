import { Skeleton, SkeletonList } from '@/components/ui';

/** T1 · first load of Intégrations: header placeholders, the GitHub tile and the MCP grid skeletons. */
export default function IntegrationsLoading() {
  return (
    <div className="flex flex-col gap-4 nav:gap-6" aria-busy="true">
      <div className="flex flex-col gap-2">
        <Skeleton width={180} height={28} />
        <Skeleton width={360} height={14} />
      </div>
      <SkeletonList rows={3} label="Chargement des intégrations" card />
      <SkeletonList rows={4} label="Chargement des serveurs MCP" card />
    </div>
  );
}
