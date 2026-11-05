import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { renderAction, type ActionElementProps } from './action';
import { Spinner } from './Spinner';

export type ButtonVariant = 'default' | 'accent' | 'on-dark';

interface ButtonOwnProps {
  /**
   * DS « Button » (7:117): `default` = paper face on light neutral, `accent` = page primary action on a light
   * background (inside a dark scope it automatically becomes the « On dark » pairing), `on-dark` = explicit
   * On dark variant for dark sections. Default `default`.
   */
  variant?: ButtonVariant;
  /**
   * Lacune 1: no destructive variant in Figma — confirmations (arrêter, archiver, supprimer) use Accent.
   * `tone="danger"` is wired (danger face, paper label) but must stay unused until the design decides.
   */
  tone?: 'danger';
  /** Full-width (login card, phone footers). */
  block?: boolean;
  /** Shows a spinner, keeps the width, disables the button and sets aria-busy. */
  loading?: boolean;
  /** Spoken label while loading (default « En cours… »). */
  loadingLabel?: string;
  className?: string;
  children: ReactNode;
}

export type ButtonProps = ButtonOwnProps & ActionElementProps;

/**
 * The big 3-D button of the design system: a near-black socle and a face lifted 0.22em above it,
 * 0.38em on hover, 0.04em when pressed (Outfit 700 15/1.25, radius 12, ≈ 54 px tall).
 * Used for page-header primaries (« Nouvelle session », « Ajouter un projet »), dialog footers
 * (« Annuler » + named action) and blocking states (T5 « Réessayer maintenant »).
 */
export function Button({
  variant = 'default',
  tone,
  block,
  loading = false,
  loadingLabel = 'En cours…',
  className,
  children,
  ...props
}: ButtonProps) {
  const classes = cn(
    'nu-btn',
    variant === 'accent' && 'nu-btn--accent',
    variant === 'on-dark' && 'nu-btn--on-dark',
    tone === 'danger' && 'nu-btn--danger',
    block && 'nu-btn--block',
    className,
  );
  return renderAction({
    props,
    className: classes,
    busy: loading,
    children: (
      <span className="nu-btn__face">
        <span className={cn('inline-flex items-center gap-2', loading && 'invisible')}>{children}</span>
        {loading ? (
          <span className="absolute inset-0 flex items-center justify-center">
            <Spinner size={18} />
            <span className="sr-only">{loadingLabel}</span>
          </span>
        ) : null}
      </span>
    ),
  });
}
