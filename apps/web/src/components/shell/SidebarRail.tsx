'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { Icon } from '@/components/icons';
import { DevBadge } from '@/components/brand';
import { Avatar } from '@/components/ui/Avatar';
import { StatusDot } from '@/components/ui/StatusDot';
import { Tooltip } from '@/components/ui/Tooltip';
import { activeNavKey, NAV_ITEMS, type NavItem, type NavKey } from './nav-items';
import { UserMenu } from './UserMenu';

export interface SidebarRailProps {
  userName: string;
  /** T5: the Accueil entry turns red while the server does not answer. */
  serverUnavailable?: boolean;
  /** Override of the active entry (default: derived from the pathname — « Sessions » in the Workspace). */
  active?: NavKey | null;
  className?: string;
}

/**
 * `Dev · Barre latérale repliée` (201:893): « Rail de 72 px pour le Workspace : la navigation globale
 * reste à un clic, la session prend la place. Libellés absents à l'écran, à porter en aria-label. »
 * near-black, padding 20 12 16, gap 8, items centred: DEV pill, 16 px spacer, 48 × 40 entries (icon 20),
 * 32 × 1 separator, flexible space, Avatar 36 (account menu). Labels are aria-labels + tooltips.
 */
export function SidebarRail({ userName, serverUnavailable, active: activeOverride, className }: SidebarRailProps) {
  const pathname = usePathname();
  const active = activeOverride !== undefined ? activeOverride : activeNavKey(pathname);

  const renderItem = (item: NavItem) => {
    const isActive = item.key === active;
    return (
      <li key={item.key}>
        <Tooltip content={item.label} side="right">
          <Link
            href={item.href}
            aria-label={serverUnavailable && item.key === 'accueil' ? `${item.label} · serveur indisponible` : item.label}
            aria-current={isActive && pathname === item.href ? 'page' : undefined}
            className={cn(
              'relative flex h-10 w-12 items-center justify-center rounded-sm transition-colors duration-(--dur-fast) ease-out',
              isActive ? 'bg-hairline-on-dark text-text' : 'text-accent hover:bg-hover hover:text-text',
            )}
          >
            <Icon name={item.icon} size={20} />
            {item.key === 'accueil' && serverUnavailable ? <StatusDot tone="danger" className="absolute top-1.5 right-2" /> : null}
          </Link>
        </Tooltip>
      </li>
    );
  };

  return (
    <aside
      data-tone="dark"
      aria-label="Navigation principale"
      className={cn(
        'sticky top-0 flex h-dvh w-(--app-sidebar-collapsed-w) shrink-0 flex-col items-center gap-2 bg-near-black px-3 pt-5 pb-4 text-text',
        className,
      )}
    >
      <Link href="/" aria-label="Nuera Dev · Accueil" className="flex rounded-sm">
        <DevBadge />
      </Link>
      <span aria-hidden className="h-4 w-2 shrink-0" />
      <nav aria-label="Sections" className="flex flex-col items-center gap-2">
        <ul className="m-0 flex list-none flex-col gap-2 p-0">{NAV_ITEMS.filter((i) => i.group === 'ESPACE').map(renderItem)}</ul>
        <span aria-hidden className="h-px w-8 bg-hairline-on-dark" />
        <ul className="m-0 flex list-none flex-col gap-2 p-0">{NAV_ITEMS.filter((i) => i.group === 'CONFIGURATION').map(renderItem)}</ul>
      </nav>
      <span className="flex-1" />
      <UserMenu side="right" align="end">
        <button type="button" aria-label={`${userName} · menu du compte`} className="rounded-full">
          <Avatar name={userName} size={36} />
        </button>
      </UserMenu>
    </aside>
  );
}
