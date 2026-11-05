import type { IconName } from '@/components/icons';
import { CompactButton, type CompactButtonVariant } from '@/components/ui';
import type { SessionActionVariant } from '../lib/session-status';

/** Action of a card or row. Without `href` nor `onClick` nothing is rendered (no dead button). */
export interface RowAction {
  label: string;
  href?: string;
  /** Opens in a new tab (GitHub…). */
  external?: boolean;
  onClick?: () => void;
  variant?: CompactButtonVariant;
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  /** Why the action is unavailable (tooltip + accessible description). */
  disabledReason?: string;
}

/** Session presets (`primary` / `secondary` / `quiet`) → `Bouton compact` styles. */
export const ACTION_VARIANT: Record<SessionActionVariant, CompactButtonVariant> = {
  primary: 'principal',
  secondary: 'secondaire',
  quiet: 'discret',
};

export interface RowActionButtonProps {
  action: RowAction;
  size?: 'md' | 'lg';
  block?: boolean;
  className?: string;
}

export function RowActionButton({ action, size = 'md', block, className }: RowActionButtonProps) {
  const variant = action.variant ?? 'secondaire';
  if (action.href && !action.disabled) {
    return (
      <CompactButton
        variant={variant}
        icon={action.icon}
        size={size}
        block={block}
        href={action.href}
        external={action.external}
        className={className}
      >
        {action.label}
      </CompactButton>
    );
  }
  if (!action.onClick && !action.disabled) return null;
  return (
    <CompactButton
      variant={variant}
      icon={action.icon}
      size={size}
      block={block}
      loading={action.loading}
      disabled={action.disabled}
      title={action.disabled ? action.disabledReason : undefined}
      onClick={action.onClick}
      className={className}
    >
      {action.label}
    </CompactButton>
  );
}
