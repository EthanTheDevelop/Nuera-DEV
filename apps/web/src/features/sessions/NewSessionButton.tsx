'use client';

import { useState, type ReactNode } from 'react';
import { NewSessionCard } from '@/components/dev';
import type { IconName } from '@/components/icons';
import { Button, CompactButton, IconButton, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { CreateSessionResult } from './lib/contract';
import { NewSessionDialog } from './NewSessionDialog';

/**
 * Trigger styles:
 * - `accent` (default) / `default`: site `Button` (D06 header « Nouvelle session », D01, A3);
 * - `principal` / `secondaire` / `discret`: `Bouton compact` (T2 empty state, D04);
 * - `icon`: 44 px accent `+` (M06 header);
 * - `card`: D06 dashed « Démarrer une session » tile;
 * - `bare`: an unstyled button around `children` (custom rows).
 */
export type NewSessionButtonVariant = 'accent' | 'default' | 'principal' | 'secondaire' | 'discret' | 'icon' | 'card' | 'bare';

export interface NewSessionButtonProps {
  /** Preselects the project in the dialog. */
  projectId?: string | null;
  variant?: NewSessionButtonVariant;
  /** `Bouton compact` / icon sizes: `md` (36) or `lg` (44, phone). */
  size?: 'md' | 'lg';
  className?: string;
  /** Label (default « Nouvelle session »; the card variant uses its Figma title). */
  children?: ReactNode;
  /** Leading icon of the compact variants (default `plus`). */
  icon?: IconName;
  /** Capacity reached, runner unavailable…: disabled, the reason shown (tooltip / card text). */
  disabledReason?: string | null;
  /** After creation (default: navigate to the Workspace; return false to stay). */
  onCreated?: (result: CreateSessionResult) => void | boolean;
}

/** Opens the « Nouvelle session » dialog; on success the Workspace of the new session opens. */
export function NewSessionButton({
  projectId,
  variant = 'accent',
  size = 'md',
  className,
  children,
  icon = 'plus',
  disabledReason,
  onCreated,
}: NewSessionButtonProps) {
  const [open, setOpen] = useState(false);
  const disabled = Boolean(disabledReason);
  const label = children ?? 'Nouvelle session';
  const onClick = () => setOpen(true);

  let trigger: ReactNode;
  switch (variant) {
    case 'card':
      trigger = <NewSessionCard onClick={onClick} disabledReason={disabledReason ?? null} className={className} {...(children ? { title: String(children) } : {})} />;
      break;
    case 'icon':
      trigger = (
        <IconButton
          icon={icon}
          label={disabledReason ? `Nouvelle session · ${disabledReason}` : 'Nouvelle session'}
          variant="accent"
          size={size === 'lg' ? 'md' : 'sm'}
          onClick={onClick}
          disabled={disabled}
          className={className}
        />
      );
      break;
    case 'principal':
    case 'secondaire':
    case 'discret':
      trigger = (
        <CompactButton variant={variant} icon={icon} size={size} onClick={onClick} disabled={disabled} className={className}>
          {label}
        </CompactButton>
      );
      break;
    case 'bare':
      trigger = (
        <button type="button" onClick={onClick} disabled={disabled} className={cn('disabled:cursor-not-allowed', className)}>
          {label}
        </button>
      );
      break;
    default:
      trigger = (
        <Button variant={variant} onClick={onClick} disabled={disabled} className={className}>
          {label}
        </Button>
      );
  }

  return (
    <>
      {disabledReason && variant !== 'card' ? (
        <Tooltip content={disabledReason}>
          <span className="inline-flex" title={disabledReason}>
            {trigger}
          </span>
        </Tooltip>
      ) : (
        trigger
      )}
      <NewSessionDialog open={open} onOpenChange={setOpen} defaultProjectId={projectId ?? null} {...(onCreated ? { onCreated } : {})} />
    </>
  );
}
