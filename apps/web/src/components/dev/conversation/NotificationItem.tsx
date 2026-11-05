import Link from 'next/link';
import type { NotificationKind } from '@nuera/db';
import type { IconName } from '@/components/icons';
import { CompactButton, Pastille, StatusDot, type PastilleTone } from '@/components/ui';
import { cn } from '@/lib/cn';
import { LiveTime, type DateInput } from '../status/LiveTime';

const KIND: Record<NotificationKind, { icon: IconName; tone: PastilleTone }> = {
  permission_request: { icon: 'shield', tone: 'warn' },
  session_finished: { icon: 'check', tone: 'success' },
  session_failed: { icon: 'alert', tone: 'danger' },
  session_interrupted: { icon: 'alert', tone: 'warn' },
  operation_failed: { icon: 'alert', tone: 'danger' },
  operation_succeeded: { icon: 'check', tone: 'success' },
  integration_expiring: { icon: 'plug', tone: 'warn' },
  integration_expired: { icon: 'plug', tone: 'danger' },
  integration_error: { icon: 'plug', tone: 'danger' },
  claude_disconnected: { icon: 'terminal', tone: 'warn' },
  server: { icon: 'server', tone: 'warn' },
  security: { icon: 'lock', tone: 'accent' },
};

export interface NotificationItemProps {
  kind: NotificationKind;
  /** « Tests e2e du devis attend votre accord » (same wording as the Web Push title, S5). */
  title: string;
  /** « npm run test -- e2e · Nuera OS » */
  body?: string | null;
  at: DateInput;
  read?: boolean;
  /** Destination of the notification (Workspace on the request, project, integration…). */
  href?: string | null;
  /** Direct action (« Répondre »); rendered as a Principal compact button. */
  action?: { label: string; href?: string; onClick?: () => void } | null;
  className?: string;
}

/**
 * Entry of the notification centre (panel not designed: built from the S5 push banner — source icon,
 * title Outfit 600 15, body Outfit 13 muted, « maintenant » — and the Nuera list-row pattern).
 */
export function NotificationItem({ kind, title, body, at, read = false, href, action, className }: NotificationItemProps) {
  const spec = KIND[kind];
  const titleClass = 'font-sans text-app-14 font-semibold text-text';
  return (
    <article
      className={cn(
        'relative flex w-full min-w-0 items-start gap-3 rounded-md px-3 py-3',
        href && 'transition-colors duration-(--dur-fast) hover:bg-hover',
        className,
      )}
    >
      <Pastille icon={spec.icon} tone={spec.tone} size={32} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-start gap-2">
          {href ? (
            <Link href={href} className={cn(titleClass, 'min-w-0 flex-1 after:absolute after:inset-0 after:content-[""]')}>
              {title}
            </Link>
          ) : (
            <p className={cn(titleClass, 'm-0 min-w-0 flex-1')}>{title}</p>
          )}
          <LiveTime value={at} format="relative" className="shrink-0 pt-px font-sans text-app-12 text-muted" />
          {!read ? (
            <span className="flex h-[18px] shrink-0 items-center">
              <StatusDot tone="accent" />
              <span className="sr-only">Non lue</span>
            </span>
          ) : null}
        </div>
        {body ? <p className="m-0 font-sans text-app-13 leading-[18px] break-words text-muted">{body}</p> : null}
        {action && (action.href || action.onClick) ? (
          <div className="relative z-10 pt-2">
            {action.href ? (
              <CompactButton variant="principal" href={action.href}>
                {action.label}
              </CompactButton>
            ) : (
              <CompactButton variant="principal" onClick={action.onClick}>
                {action.label}
              </CompactButton>
            )}
          </div>
        ) : null}
      </div>
    </article>
  );
}
