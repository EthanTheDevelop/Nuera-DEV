'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { Icon } from '@/components/icons';
import { LogoNueraDev } from '@/components/brand';
import { StatusDot } from '@/components/ui/StatusDot';
import { useShortcutLabel } from '@/hooks/usePlatform';
import { activeNavKey, NAV_ITEMS, type NavItem, type NavKey } from './nav-items';
import { ServerCard, type ServerCardProps } from './ServerCard';
import { UserCard } from './UserCard';

export interface SidebarProps {
  /** Active sessions (count pill on « Sessions », hidden at 0). */
  activeSessions: number;
  /** T5: the Accueil entry turns red while the server does not answer. */
  serverUnavailable?: boolean;
  server: Omit<ServerCardProps, 'className'>;
  user: { name: string; twoFactorEnabled: boolean };
  /** Opens the command palette (« Rechercher… ⌘K »). */
  onOpenSearch: () => void;
  /** Override of the active entry (default: derived from the pathname). */
  active?: NavKey | null;
  className?: string;
}

const GROUPS = ['ESPACE', 'CONFIGURATION'] as const;

/**
 * `Dev · Barre latérale` (201:732): 248 px, full height, near-black, padding 20 16 16, gap 16 —
 * logo, search trigger, ESPACE / CONFIGURATION, flexible space, server card, user card.
 * Dark scope (`data-tone="dark"`): every role flips (accent = #a6b9dd, text = paper).
 */
export function Sidebar({ activeSessions, serverUnavailable, server, user, onOpenSearch, active: activeOverride, className }: SidebarProps) {
  const pathname = usePathname();
  const active = activeOverride !== undefined ? activeOverride : activeNavKey(pathname);
  const shortcut = useShortcutLabel();

  const renderItem = (item: NavItem) => {
    const isActive = item.key === active;
    const exactPage = isActive && pathname === item.href;
    return (
      <li key={item.key}>
        <Link
          href={item.href}
          aria-current={exactPage ? 'page' : undefined}
          className={cn(
            'flex min-h-[34px] items-center gap-3 rounded-sm px-3 py-2 font-sans text-app-14',
            'transition-colors duration-(--dur-fast) ease-out',
            isActive ? 'bg-hairline-on-dark font-semibold text-text' : 'font-medium text-accent hover:bg-hover hover:text-text',
          )}
        >
          <Icon name={item.icon} size={18} />
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {item.key === 'accueil' && serverUnavailable ? (
            <>
              <StatusDot tone="danger" />
              <span className="sr-only">serveur indisponible</span>
            </>
          ) : null}
          {item.key === 'sessions' && activeSessions > 0 ? (
            <span className="rounded-full bg-accent-on-light px-1 py-px font-sans text-app-11 font-semibold text-paper">
              {activeSessions}
              <span className="sr-only"> {activeSessions > 1 ? 'sessions actives' : 'session active'}</span>
            </span>
          ) : null}
        </Link>
      </li>
    );
  };

  return (
    <aside
      data-tone="dark"
      aria-label="Navigation principale"
      className={cn(
        'sticky top-0 flex h-dvh w-(--app-sidebar-w) shrink-0 flex-col gap-4 bg-near-black px-4 pt-5 pb-4 text-text',
        className,
      )}
    >
      <Link href="/" aria-label="Nuera Dev · Accueil" className="flex self-start rounded-sm pl-2">
        <LogoNueraDev />
      </Link>

      <button
        type="button"
        onClick={onOpenSearch}
        aria-keyshortcuts="Meta+K Control+K"
        className="flex h-8 w-full items-center gap-2 rounded-sm bg-surface-raised px-3 py-2 text-left text-accent transition-colors duration-(--dur-fast) ease-out hover:bg-hover"
      >
        <Icon name="search" size={16} />
        <span className="min-w-0 flex-1 truncate font-sans text-app-13">Rechercher…</span>
        <kbd className="font-mono text-app-11 font-medium" suppressHydrationWarning>
          {shortcut}
        </kbd>
      </button>

      <nav aria-label="Sections" className="-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1">
        {GROUPS.map((group) => (
          <div key={group} className="flex flex-col">
            <p className="m-0 pb-2 pl-3 font-mono text-app-10 font-medium text-accent opacity-60">{group}</p>
            <ul className="m-0 flex list-none flex-col p-0">{NAV_ITEMS.filter((i) => i.group === group).map(renderItem)}</ul>
          </div>
        ))}
      </nav>

      <ServerCard {...server} />
      <UserCard name={user.name} twoFactorEnabled={user.twoFactorEnabled} />
    </aside>
  );
}
