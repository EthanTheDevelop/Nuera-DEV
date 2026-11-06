import { PageHeader } from '@/components/shell/PageHeader';
import { Skeleton, SkeletonList } from '@/components/ui';

/** T1 while the server reads the administration (silhouettes of the tabs and the table). */
export default function AdministrationLoading() {
  return (
    <div className="flex min-w-0 flex-col gap-3 nav:gap-5" aria-busy="true">
      <PageHeader title="Administration" subtitle={<Skeleton height={14} width={320} className="max-w-full" />} />
      <Skeleton height={23} width={320} className="max-w-full rounded-full" />
      <Skeleton height={420} className="hidden rounded-xl nav:block" />
      <div className="flex flex-col gap-3 nav:hidden">
        <SkeletonList rows={4} card label="Chargement de l'administration" />
      </div>
    </div>
  );
}
