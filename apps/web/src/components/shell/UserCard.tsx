'use client';

import { cn } from '@/lib/cn';
import { Avatar } from '@/components/ui/Avatar';
import { roleLine } from './status-text';
import type { ShellRole } from './types';
import { UserMenu } from './UserMenu';

export interface UserCardProps {
  name: string;
  /** Instance role: « Propriétaire » (Figma) · « Administrateur » · « Membre ». The shell always passes it; the gallery shows the Figma frame (owner). */
  role?: ShellRole;
  twoFactorEnabled: boolean;
  className?: string;
}

/**
 * Sidebar « Utilisateur » card: surface-raised-dark, radius 12, padding 8, gap 8 — Avatar 36 + name
 * (Outfit 600 13 paper) / « Propriétaire · double facteur actif » (Outfit 11 accent-on-dark; the role
 * of the signed-in account). Opens the account menu (Paramètres, Administration, Se déconnecter).
 */
export function UserCard({ name, role = 'owner', twoFactorEnabled, className }: UserCardProps) {
  const line = roleLine(role, twoFactorEnabled);
  return (
    <UserMenu side="top" align="start">
      <button
        type="button"
        aria-label={`${name} · menu du compte`}
        className={cn(
          'group flex w-full min-w-0 items-center gap-2 rounded-md bg-surface-raised p-2 text-left',
          'transition-colors duration-(--dur-fast) ease-out hover:bg-hover data-[state=open]:bg-hover',
          className,
        )}
      >
        <Avatar name={name} size={36} />
        {/* As in Figma, the text may run into the card's right padding (the card clips it): the role line
            « Propriétaire · double facteur actif » is ≈ 161 px for 156 px of content box. */}
        <span className="-mr-2 flex min-w-0 flex-1 flex-col">
          <span className="truncate font-sans text-app-13 font-semibold text-text">{name}</span>
          <span className="truncate font-sans text-app-11 text-accent" title={line}>
            {line}
          </span>
        </span>
      </button>
    </UserMenu>
  );
}
