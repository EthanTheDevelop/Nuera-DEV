import { Skeleton, SkeletonList } from '@/components/ui';

/** T1 while the Workspace data is read (session, thread, worktree changes). */
export default function WorkspaceLoading() {
  return (
    <div role="status" aria-busy="true" className="flex h-dvh w-full flex-col bg-surface-raised">
      <span className="sr-only">Chargement de la session…</span>
      <div className="flex min-h-[81px] items-center gap-3 border-b border-border bg-bg px-6 py-3.5">
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton width="40%" height={18} />
          <Skeleton width="60%" height={12} />
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex flex-1 flex-col items-center justify-end gap-4 px-8 py-5">
          <div className="w-full max-w-[720px]">
            <SkeletonList rows={6} card={false} label="Chargement du fil de la session" />
          </div>
        </div>
        <div className="hidden w-[460px] shrink-0 border-l border-border bg-bg p-4 nav:block">
          <SkeletonList rows={8} card={false} label="Chargement des modifications" />
        </div>
      </div>
    </div>
  );
}
