import Link from 'next/link';
import { Icon, type IconName } from '@/components/icons';
import { Badge, Pastille } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { StatusBadge } from '../lib/integrations';

export interface IntegrationRowProps {
  /** `GitHub`, `Figma`, `Coolify`… */
  name: string;
  icon: IconName;
  /** « 12 dépôts accessibles », « serveur MCP · développement » */
  detail?: string | null;
  /** From `integrationStatusBadge(…)` or `mcpStatusBadge(…, 'short')`. */
  badge: StatusBadge;
  /** Integration / server page; the row becomes a link. */
  href?: string;
  /** `desktop` = D01 `Tuile · Intégrations` row (pastille 28) · `phone` = M07 list row (tile 36, chevron). */
  variant?: 'desktop' | 'phone';
  className?: string;
}

/** D01 `Tuile · Intégrations` / M07 `Serveurs MCP` row: pastille · name / detail · status badge. */
export function IntegrationRow({ name, icon, detail, badge, href, variant = 'desktop', className }: IntegrationRowProps) {
  const phone = variant === 'phone';
  const nameClass = cn('truncate font-sans font-semibold text-text', phone ? 'text-app-15' : 'text-app-14');
  return (
    <div
      className={cn(
        'relative flex min-w-0 items-center gap-3 border-b border-border',
        phone ? 'py-3 last:border-b-0' : 'py-2.5',
        href && 'transition-colors duration-(--dur-fast) hover:bg-hover',
        className,
      )}
    >
      <Pastille icon={icon} size={phone ? 32 : 28} className={phone ? 'size-9 rounded-sm' : undefined} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {href ? (
          <Link href={href} className={cn(nameClass, "after:absolute after:inset-0 after:content-['']")}>
            {name}
          </Link>
        ) : (
          <p className={cn(nameClass, 'm-0')}>{name}</p>
        )}
        {detail ? <p className="m-0 truncate font-sans text-app-12 text-muted">{detail}</p> : null}
      </div>
      <Badge tone={badge.tone}>{badge.label}</Badge>
      {phone && href ? <Icon name="chevron" size={18} className="text-muted" /> : null}
    </div>
  );
}
