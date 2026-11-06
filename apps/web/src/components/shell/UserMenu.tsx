'use client';

import { useTransition, type ReactNode } from 'react';
import { signOutAction } from '@/app/(auth)/deconnexion/actions';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/Menu';
import { announceAccount } from '@/hooks/useLiveEvents';
import { ADMIN_NAV_ITEM, isAdminRole } from './nav-items';
import { useOptionalShellData } from './ShellContext';

export interface UserMenuProps {
  /** The trigger (UserCard button or rail avatar) — rendered with `asChild`. */
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom';
  align?: 'start' | 'end';
}

const FORGET_TIMEOUT_MS = 3_000;

/**
 * Forgets this device's push subscription for the account signing out (docs/MULTICOMPTE.md §9),
 * before the session ends (the route needs it). Best effort, bounded: a failure never blocks the
 * sign-out. The browser subscription itself is kept: another account of this browser may use it.
 */
async function forgetThisDevicePush(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FORGET_TIMEOUT_MS);
  try {
    const registration = await navigator.serviceWorker.getRegistration('/');
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    await fetch('/api/push/subscription', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
      signal: controller.signal,
    });
  } catch {
    // offline, aborted: the session ends anyway (the subscription stays filed under this account)
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Account menu (not drawn in Figma; Nuera OS « Menu du profil » pattern): « Paramètres »,
 * « Administration » (owner and administrators), « Se déconnecter ». Sign-out forgets this device's
 * push subscription for the account, tells the other tabs of the browser, then goes through the auth
 * lot's server action (session deleted, cookies cleared, audited).
 */
export function UserMenu({ children, side = 'top', align = 'start' }: UserMenuProps) {
  const [pending, startTransition] = useTransition();
  const shell = useOptionalShellData();
  const admin = shell ? isAdminRole(shell.user.role) : false;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={align} width={232}>
        <DropdownMenuLinkItem href="/parametres" icon="reglages">
          Paramètres
        </DropdownMenuLinkItem>
        {admin ? (
          <DropdownMenuLinkItem href={ADMIN_NAV_ITEM.href} icon={ADMIN_NAV_ITEM.icon}>
            {ADMIN_NAV_ITEM.label}
          </DropdownMenuLinkItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          icon="arrow-left"
          destructive
          disabled={pending}
          onSelect={(event) => {
            event.preventDefault();
            startTransition(async () => {
              await forgetThisDevicePush();
              if (shell) announceAccount({ type: 'signed-out', userId: shell.user.id });
              await signOutAction();
            });
          }}
        >
          {pending ? 'Déconnexion…' : 'Se déconnecter'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
