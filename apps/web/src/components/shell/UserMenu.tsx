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

export interface UserMenuProps {
  /** The trigger (UserCard button or rail avatar) — rendered with `asChild`. */
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom';
  align?: 'start' | 'end';
}

/**
 * Account menu (not drawn in Figma; Nuera OS « Menu du profil » pattern): « Paramètres », « Se déconnecter ».
 * Sign-out goes through the auth lot's server action (session deleted, cookies cleared, audited).
 */
export function UserMenu({ children, side = 'top', align = 'start' }: UserMenuProps) {
  const [pending, startTransition] = useTransition();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={align} width={232}>
        <DropdownMenuLinkItem href="/parametres" icon="reglages">
          Paramètres
        </DropdownMenuLinkItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          icon="arrow-left"
          destructive
          disabled={pending}
          onSelect={(event) => {
            event.preventDefault();
            startTransition(async () => {
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
