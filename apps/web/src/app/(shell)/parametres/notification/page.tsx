import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Button, EmptyState } from '@/components/ui';
import { requireContext } from '@/server/tenancy/context';
import { OTHER_ACCOUNT_NOTIFICATION, resolveNotificationClick } from '@/server/shell/notification-guard';
import { guardSignOutHref } from './sign-out-href';

export const metadata: Metadata = { title: 'Notification' };
export const dynamic = 'force-dynamic';

/**
 * Click guard of push notifications (public/sw.js): opens the notification's page when it is meant
 * for the signed-in account, otherwise says it concerns another Nuera Dev account (never which one).
 * Signed out: the proxy sends the browser to /connexion, which comes back here after the sign-in.
 * « Se déconnecter » does the same: /deconnexion then /connexion?suivant=<this guard>.
 */
export default async function NotificationGuardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireContext();
  const params = await searchParams;
  const click = resolveNotificationClick(ctx.user.id, { vers: params.vers, compte: params.compte });
  if (click.kind === 'open') redirect(click.href);
  return (
    <div className="flex flex-1 items-start justify-center">
      <EmptyState
        icon="bell"
        title="Notification d'un autre compte"
        className="mt-0 w-full max-w-[560px] nav:mt-10"
        action={
          <>
            <Button href={guardSignOutHref({ vers: params.vers, compte: params.compte })}>Se déconnecter</Button>
            <Button href="/" variant="accent">
              Revenir à l'accueil
            </Button>
          </>
        }
      >
        {OTHER_ACCOUNT_NOTIFICATION}
      </EmptyState>
    </div>
  );
}
