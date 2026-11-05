import { PageHeader } from '@/components/shell/PageHeader';
import { Skeleton, SkeletonList } from '@/components/ui';

/** T1 while the server reads the settings (silhouettes of the D08 grid / M08 groups). */
export default function SettingsLoading() {
  return (
    <div className="flex min-w-0 flex-col gap-3 nav:gap-5" aria-busy="true">
      <PageHeader title="Paramètres" subtitle={<Skeleton height={14} width={420} className="max-w-full" />} />
      <Skeleton height={23} width={460} className="hidden max-w-full rounded-full nav:block" />
      <div className="hidden grid-cols-2 items-start gap-5 nav:grid">
        <div className="flex flex-col gap-5">
          <Skeleton height={412} className="rounded-xl" />
          <Skeleton height={457} className="rounded-xl" />
        </div>
        <div className="flex flex-col gap-5">
          <Skeleton height={433} className="rounded-xl" />
          <Skeleton height={250} className="rounded-xl" />
          <Skeleton height={258} className="rounded-xl" />
        </div>
      </div>
      <div className="flex flex-col gap-3 nav:hidden">
        <SkeletonList rows={4} card label="Chargement des paramètres" />
        <SkeletonList rows={3} card />
      </div>
    </div>
  );
}
