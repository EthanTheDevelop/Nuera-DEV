/**
 * Self-contained design-system pieces for the auth pages (tokens via Tailwind classes only).
 * Button = DS « Bouton » (socle near-black + face levée 0.22em, survol 0.38em, clic 0.04em, Outfit 700 15,
 * rayon 12) · Field = « Dev · Champ » (bordure border, focus 1.5 accent, erreur 1.5 danger) ·
 * FormAlert = « Dev · Bandeau » (Info / Succès / Erreur) · compact buttons = « Bouton compact ».
 */
import type { ButtonHTMLAttributes, CSSProperties, InputHTMLAttributes, ReactNode } from 'react';
import { AuthIcon, type AuthIconName } from './icons';

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

type ButtonVariant = 'accent' | 'default';

export interface DsButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  icon?: AuthIconName;
  /** Full width on phones (thumb reach), hugging its label from `sm` up. */
  block?: boolean;
  pending?: boolean;
  children: ReactNode;
}

export function DsButton({ variant = 'accent', icon, block = true, pending = false, disabled, className, children, ...props }: DsButtonProps) {
  const inactive = disabled || pending;
  return (
    <button
      {...props}
      disabled={inactive}
      aria-busy={pending || undefined}
      className={cx(
        'group relative inline-flex min-h-11 rounded-md bg-btn-edge text-ui font-bold',
        'mt-(--btn-lift-hover) cursor-pointer select-none [-webkit-tap-highlight-color:transparent]',
        'disabled:cursor-not-allowed',
        block && 'w-full sm:w-auto',
        className,
      )}
    >
      <span
        className={cx(
          'inline-flex w-full items-center justify-center gap-2 whitespace-nowrap rounded-md border-(length:--btn-border-w) border-btn-edge px-6.5 py-3.25',
          'transition-transform duration-(--dur-fast) ease-out motion-reduce:transition-none',
          inactive
            ? 'translate-y-0 bg-surface-raised text-muted'
            : cx(
                '-translate-y-(--btn-lift-rest) group-hover:-translate-y-(--btn-lift-hover) group-active:-translate-y-(--btn-lift-pressed) group-active:duration-(--dur-instant)',
                variant === 'accent' ? 'bg-accent text-paper' : 'bg-paper text-btn-edge',
              ),
        )}
      >
        {icon ? <AuthIcon name={icon} size={18} /> : null}
        {children}
      </span>
    </button>
  );
}

type CompactVariant = 'principal' | 'secondaire' | 'discret';

export interface CompactButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: CompactVariant;
  icon?: AuthIconName;
}

export function CompactButton({ variant = 'secondaire', icon, className, children, ...props }: CompactButtonProps) {
  return (
    <button
      {...props}
      className={cx(
        'relative inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-md text-app-14 font-medium',
        'after:absolute after:inset-x-0 after:-inset-y-1 after:content-[""] disabled:cursor-not-allowed disabled:opacity-60',
        variant === 'principal' && 'bg-accent pr-3.5 pl-3 text-paper',
        variant === 'secondaire' && 'border border-border bg-paper pr-3.5 pl-3 text-ink',
        variant === 'discret' && 'bg-transparent p-0 text-accent underline-offset-4 hover:underline',
        className,
      )}
    >
      {icon ? <AuthIcon name={icon} size={16} /> : null}
      {children}
    </button>
  );
}

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  name: string;
  hint?: ReactNode;
  error?: string | null;
  mono?: boolean;
}

export function Field({ label, name, hint, error, mono = false, className, id, ...props }: FieldProps) {
  const inputId = id ?? `champ-${name}`;
  const hintId = hint && !error ? `${inputId}-aide` : undefined;
  const errorId = error ? `${inputId}-erreur` : undefined;
  return (
    <div className="flex w-full flex-col gap-2">
      <label htmlFor={inputId} className="text-app-13 font-medium text-text">
        {label}
      </label>
      <input
        {...props}
        id={inputId}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={[errorId, hintId].filter(Boolean).join(' ') || undefined}
        className={cx(
          'h-11 w-full rounded-md border bg-surface px-3 text-base text-text placeholder:text-muted md:text-app-14',
          'outline-none transition-[border-color,box-shadow] duration-(--dur-fast)',
          error
            ? 'border-danger shadow-[inset_0_0_0_0.5px_var(--danger)]'
            : 'border-border focus:border-accent focus:shadow-[inset_0_0_0_0.5px_var(--accent)]',
          mono && 'font-mono tracking-(--tracking-label)',
          className,
        )}
      />
      {error ? (
        <p id={errorId} className="text-app-12 text-danger">
          {error.charAt(0).toUpperCase() + error.slice(1)}
        </p>
      ) : null}
      {hint && !error ? (
        <p id={hintId} className="text-app-12 leading-4 text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

const ALERT_TONES = {
  error: { box: 'bg-danger-pale', icon: 'text-danger', iconName: 'alert' },
  success: { box: 'bg-success-pale', icon: 'text-success', iconName: 'check' },
  info: { box: 'bg-accent-pale', icon: 'text-accent', iconName: 'shield' },
} as const;

export function FormAlert({ tone, title, children }: { tone: keyof typeof ALERT_TONES; title: string; children?: ReactNode }) {
  const style = ALERT_TONES[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cx('flex w-full items-start gap-3 rounded-md px-4 py-3.5', style.box)}>
      <AuthIcon name={style.iconName} size={18} className={cx('mt-px shrink-0', style.icon)} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-app-14 font-semibold text-text">{title}</p>
        {children ? <div className="text-app-13 leading-4.5 text-muted">{children}</div> : null}
      </div>
    </div>
  );
}

export const SETUP_STEPS = ['Compte', 'Double authentification', 'Codes de secours', "Clé d'accès"] as const;

/** « Progression » bar of M03 (4 px segments) with the step label. */
export function SetupProgress({ current }: { current: 1 | 2 | 3 | 4 }) {
  return (
    <div className="flex w-full flex-col gap-2">
      <p className="font-mono text-app-11 tracking-(--tracking-label) text-muted uppercase">
        Étape {current} sur {SETUP_STEPS.length} · {SETUP_STEPS[current - 1]}
      </p>
      <ol className="grid grid-cols-4 gap-1" aria-label="Étapes de la configuration">
        {SETUP_STEPS.map((label, index) => (
          <li
            key={label}
            aria-current={index + 1 === current ? 'step' : undefined}
            className={cx('h-1 rounded-full', index + 1 <= current ? 'bg-accent' : 'bg-border')}
          >
            <span className="sr-only">
              {label}
              {index + 1 < current ? ' (terminée)' : index + 1 === current ? ' (en cours)' : ''}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * The form card stays a paper card whatever the theme preference (`data-theme="dark"` flips the
 * role tokens app-wide): the light roles are re-declared on the card from the brand primitives.
 */
const LIGHT_ROLES = {
  '--bg': 'var(--paper)',
  '--text': 'var(--ink)',
  '--accent': 'var(--accent-on-light)',
  '--muted': 'var(--muted-on-light)',
  '--border': 'var(--border-on-light)',
  '--surface': 'var(--paper)',
  '--surface-raised': 'var(--paper)',
  colorScheme: 'light',
} as CSSProperties;

export function AuthCard({
  title,
  description,
  children,
  header,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  header?: ReactNode;
}) {
  return (
    <section
      aria-labelledby="auth-card-title"
      style={LIGHT_ROLES}
      className="flex w-full flex-col gap-5 rounded-lg bg-bg p-5 text-text shadow-float sm:p-6 lg:p-8"
    >
      {header}
      <div className="flex flex-col gap-2">
        <h1 id="auth-card-title" className="text-app-22 font-semibold text-ink">
          {title}
        </h1>
        {description ? <div className="text-app-14 leading-5 text-muted">{description}</div> : null}
      </div>
      {children}
    </section>
  );
}
