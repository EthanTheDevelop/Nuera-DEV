import { Icon } from '@/components/icons';
import { cn } from '@/lib/cn';

export interface FavoriteToggleProps {
  favorite: boolean;
  /** Project name, for the accessible label (« Retirer Nuera OS des favoris »). */
  name: string;
  onToggle?: () => void;
  pending?: boolean;
  size?: 16 | 18;
  className?: string;
}

/**
 * `Favori` star of the project rows: outline only, accent when favourite, border grey otherwise
 * (D01, D02, M02). Static (decorative + text) when no handler is given.
 */
export function FavoriteToggle({ favorite, name, onToggle, pending, size = 18, className }: FavoriteToggleProps) {
  const glyph = <Icon name="star" size={size} className={favorite ? 'text-accent' : 'text-border'} />;
  if (!onToggle) {
    return (
      <span className={cn('inline-flex shrink-0', className)}>
        {glyph}
        <span className="sr-only">{favorite ? 'Favori' : 'Pas en favori'}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={pending}
      aria-pressed={favorite}
      aria-label={favorite ? `Retirer ${name} des favoris` : `Ajouter ${name} aux favoris`}
      className={cn(
        'nu-hit relative z-10 inline-flex shrink-0 rounded-sm transition-opacity duration-(--dur-fast) hover:opacity-70 disabled:cursor-progress disabled:opacity-40',
        className,
      )}
    >
      {glyph}
    </button>
  );
}
