'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { Icon } from '@/components/icons';
import { StatusDot } from '@/components/ui/StatusDot';
import { hidesTabBar, NAV_ITEMS, tabBarActiveKey, type NavKey } from './nav-items';

export interface TabBarProps {
  activeSessions: number;
  serverUnavailable?: boolean;
  /** Draw the 1 px top border (omitted when a page action bar sits right above, as on M04). */
  border?: boolean;
  /** Override of the active entry (default: derived from the pathname). */
  active?: NavKey | null;
  className?: string;
}

/**
 * `Dev · Barre d'onglets` (202:452): « Navigation globale au téléphone, au pouce : les 5 entrées de la barre
 * latérale. Absente du Workspace, qui prend tout l'écran. Cible de 78 × 56 px, au-dessus du minimum de 44. »
 * bg surface, 1 px top border, 56 px row of 5 equal tabs + safe-area-inset-bottom. Icon holder 44 × 24
 * (active accent-pale), icon 20, label Outfit 11 (active SemiBold accent, inactive Medium muted);
 * Sessions counter at (30, −2). Hidden in the Workspace and on /projets/nouveau (M03). Always the 5
 * Figma tabs: /administration highlights « Paramètres » (the phone reaches it from there).
 */
export function TabBar({ activeSessions, serverUnavailable, border = true, active: activeOverride, className }: TabBarProps) {
  const pathname = usePathname();
  if (hidesTabBar(pathname)) return null;
  const active = activeOverride !== undefined ? activeOverride : tabBarActiveKey(pathname);
  return (
    <nav
      aria-label="Navigation principale"
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 bg-bg pb-[env(safe-area-inset-bottom)]',
        border && 'border-t border-border',
        className,
      )}
    >
      <ul className="m-0 flex h-14 list-none p-0">
        {NAV_ITEMS.map((item) => {
          const isActive = item.key === active;
          return (
            <li key={item.key} className="flex flex-1">
              <Link
                href={item.href}
                aria-current={isActive && pathname === item.href ? 'page' : undefined}
                className="flex flex-1 flex-col items-center gap-1 pt-2 pb-1.5 outline-offset-[-2px]"
              >
                <span
                  className={cn(
                    'relative flex h-6 w-11 items-center justify-center rounded-full transition-colors duration-(--dur-fast) ease-out',
                    isActive ? 'bg-accent-pale text-accent' : 'text-muted',
                  )}
                >
                  <Icon name={item.icon} size={20} />
                  {item.key === 'sessions' && activeSessions > 0 ? (
                    <span className="absolute -top-0.5 left-[30px] rounded-full bg-accent px-[5px] py-px font-sans text-app-10 font-semibold text-on-accent">
                      {activeSessions}
                    </span>
                  ) : null}
                  {item.key === 'accueil' && serverUnavailable ? <StatusDot tone="danger" className="absolute -top-0.5 right-1" /> : null}
                </span>
                <span
                  className={cn(
                    'font-sans text-app-11',
                    isActive ? 'font-semibold text-accent' : 'font-medium text-muted',
                  )}
                >
                  {item.label}
                  {item.key === 'sessions' && activeSessions > 0 ? (
                    <span className="sr-only">{` · ${activeSessions} ${activeSessions > 1 ? 'sessions actives' : 'session active'}`}</span>
                  ) : null}
                  {item.key === 'accueil' && serverUnavailable ? <span className="sr-only"> · serveur indisponible</span> : null}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
