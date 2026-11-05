import { IconButton } from '@/components/ui';
import { cn } from '@/lib/cn';

/** Mask of a secret value, exactly as drawn in D04 (12 × U+2022). */
export const SECRET_MASK = '•'.repeat(12);

export interface EnvVarRowProps {
  /** Variable name (`DATABASE_URL`). */
  name: string;
  /** Secret values are never sent to the browser: shown masked. */
  secret: boolean;
  /** Plain value of a non-secret variable (or a revealed one, when the page allows it). */
  value?: string | null;
  /** The value is currently shown in clear. */
  revealed?: boolean;
  /** Reveal / hide (eye). Only offered by the page for variables it may show (docs/ARCHITECTURE.md §9). */
  onReveal?: () => void;
  onHide?: () => void;
  /** Edit or replace the value (pencil). */
  onEdit?: () => void;
  pending?: boolean;
  className?: string;
}

/**
 * D04 `Tuile · Variables d'environnement` row: key (mono 500 12, 170 px) · value (masked
 * `••••••••••••` for secrets) · eye (reveal) or pencil (edit).
 */
export function EnvVarRow({ name, secret, value, revealed, onReveal, onHide, onEdit, pending, className }: EnvVarRowProps) {
  const masked = secret && !revealed;
  const shown = masked ? SECRET_MASK : (value ?? '');
  // D04 draws a bare 16 px icon in a 37 px row: 28 px visual box, the 44 px hit area comes from `nu-hit`.
  const iconButton = { size: 'sm', iconSize: 16, className: 'size-7', loading: pending } as const;
  return (
    <div className={cn('flex min-h-[37px] min-w-0 items-center gap-3 border-b border-border py-1 last:border-b-0', className)}>
      <p className="m-0 w-[170px] shrink-0 truncate font-mono text-app-12 font-medium text-text" title={name}>
        {name}
      </p>
      <p className="m-0 min-w-0 flex-1 truncate font-mono text-app-12 text-muted" title={masked ? undefined : shown}>
        {masked ? (
          <>
            <span aria-hidden>{shown}</span>
            <span className="sr-only">Valeur secrète masquée</span>
          </>
        ) : (
          shown
        )}
      </p>
      {revealed && onHide ? (
        <IconButton {...iconButton} icon="eye" label={`Masquer la valeur de ${name}`} iconClassName="text-accent" onClick={onHide} />
      ) : masked && onReveal ? (
        <IconButton {...iconButton} icon="eye" label={`Afficher la valeur de ${name}`} iconClassName="text-muted" onClick={onReveal} />
      ) : onEdit ? (
        <IconButton {...iconButton} icon="edit" label={`Modifier ${name}`} iconClassName="text-muted" onClick={onEdit} />
      ) : null}
    </div>
  );
}
