'use client';

import {
  createContext,
  useContext,
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/icons';
import { Kbd } from './Kbd';

/* -----------------------------------------------------------------------------------------------
   Field context: <Field label hint error> wires ids, aria-describedby and aria-invalid into the
   control placed inside it (Input, Textarea, SearchField, SecretField, Select).
   ----------------------------------------------------------------------------------------------- */

interface FieldContextValue {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

export function useFieldControl(props: { id?: string; invalid?: boolean; 'aria-describedby'?: string }) {
  const ctx = useContext(FieldContext);
  return {
    id: props.id ?? ctx?.id,
    invalid: props.invalid ?? ctx?.invalid ?? false,
    describedBy: [props['aria-describedby'], ctx?.describedBy].filter(Boolean).join(' ') || undefined,
  };
}

export interface FieldProps {
  label?: ReactNode;
  /** Helper below the control (Outfit 12 / 16 muted), e.g. free space on VPS-3. */
  hint?: ReactNode;
  /** Error message (danger, announced). Also switches the control to the `Erreur` state. */
  error?: ReactNode;
  /** Right side of the label row (« Proposé par Claude » badge, a link…). */
  labelAside?: ReactNode;
  id?: string;
  className?: string;
  children: ReactNode;
}

/** Label + control + hint/error stack (gap 6), as in D03 « Branche de départ ». */
export function Field({ label, hint, error, labelAside, id, className, children }: FieldProps) {
  const autoId = useId();
  const controlId = id ?? `field-${autoId}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const value: FieldContextValue = {
    id: controlId,
    describedBy: [errorId, hintId].filter(Boolean).join(' ') || undefined,
    invalid: Boolean(error),
  };
  return (
    <FieldContext.Provider value={value}>
      <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
        {label || labelAside ? (
          <div className="flex items-center justify-between gap-2">
            {label ? <Label htmlFor={controlId}>{label}</Label> : <span />}
            {labelAside}
          </div>
        ) : null}
        {children}
        {error ? <FieldError id={errorId}>{error}</FieldError> : null}
        {hint ? <FieldHint id={hintId}>{hint}</FieldHint> : null}
      </div>
    </FieldContext.Provider>
  );
}

export function Label({ htmlFor, className, children }: { htmlFor?: string; className?: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className={cn('font-sans text-app-13 font-medium text-text', className)}>
      {children}
    </label>
  );
}

export function FieldHint({ id, className, children }: { id?: string; className?: string; children: ReactNode }) {
  return (
    <p id={id} className={cn('m-0 font-sans text-app-12 leading-4 text-muted', className)}>
      {children}
    </p>
  );
}

export function FieldError({ id, className, children }: { id?: string; className?: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className={cn('m-0 font-sans text-app-12 leading-4 text-danger', className)}>
      {children}
    </p>
  );
}

/* -----------------------------------------------------------------------------------------------
   Dev · Champ (202:503) — États Repos / Focus / Erreur.
   h 40 (44 on the phone), bg surface, 1 px border, radius 12, px 12 py 8, gap 8, Outfit 14.
   Focus = 1.5 px accent border, Erreur = 1.5 px danger border (drawn as border + 0.5 px inset ring
   so the text never shifts).
   ----------------------------------------------------------------------------------------------- */

export const fieldShellClasses = (invalid: boolean, size: 'md' | 'lg', disabled?: boolean) =>
  cn(
    'flex w-full min-w-0 items-center gap-2 rounded-md border bg-bg px-3 font-sans text-app-14 text-text',
    'transition-[border-color,box-shadow] duration-(--dur-fast) ease-out',
    size === 'md' ? 'h-10' : 'h-11',
    invalid
      ? 'border-danger shadow-[inset_0_0_0_0.5px_var(--danger)]'
      : 'border-border focus-within:border-accent focus-within:shadow-[inset_0_0_0_0.5px_var(--accent)]',
    disabled && 'cursor-not-allowed opacity-60',
  );

const inputClasses =
  'h-full min-w-0 flex-1 bg-transparent font-sans text-app-14 text-text placeholder:text-muted outline-none disabled:cursor-not-allowed';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** `md` = 40 px (desktop), `lg` = 44 px (phone). */
  size?: 'md' | 'lg';
  /** Leading 16 px icon in `--muted` (search, folder, git-branch, key…). */
  leadingIcon?: IconName;
  /** Trailing slot (unit, button, shortcut). */
  trailing?: ReactNode;
  invalid?: boolean;
  /** JetBrains Mono 14 for machine values (branches, paths, tokens). */
  mono?: boolean;
  /** Class of the visual shell (width…). `className` goes to the <input>. */
  shellClassName?: string;
  ref?: Ref<HTMLInputElement>;
}

export function Input({
  size = 'md',
  leadingIcon,
  trailing,
  invalid,
  mono,
  shellClassName,
  className,
  disabled,
  ref,
  ...rest
}: InputProps) {
  const control = useFieldControl({ id: rest.id, invalid, 'aria-describedby': rest['aria-describedby'] });
  return (
    <div className={cn(fieldShellClasses(control.invalid, size, disabled), shellClassName)}>
      {leadingIcon ? <Icon name={leadingIcon} size={16} className="text-muted" /> : null}
      <input
        ref={ref}
        {...rest}
        id={control.id}
        disabled={disabled}
        aria-invalid={control.invalid || undefined}
        aria-describedby={control.describedBy}
        className={cn(inputClasses, mono && 'font-mono', className)}
      />
      {trailing}
    </div>
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  mono?: boolean;
  shellClassName?: string;
  ref?: Ref<HTMLTextAreaElement>;
}

/** Multi-line Dev · Champ (commit message: JetBrains Mono 13 / 19, radius 12, padding 10 × 12). */
export function Textarea({ invalid, mono, shellClassName, className, disabled, rows = 3, ref, ...rest }: TextareaProps) {
  const control = useFieldControl({ id: rest.id, invalid, 'aria-describedby': rest['aria-describedby'] });
  return (
    <div
      className={cn(
        fieldShellClasses(control.invalid, 'md', disabled),
        'h-auto items-stretch px-3 py-2.5',
        shellClassName,
      )}
    >
      <textarea
        ref={ref}
        rows={rows}
        {...rest}
        id={control.id}
        disabled={disabled}
        aria-invalid={control.invalid || undefined}
        aria-describedby={control.describedBy}
        className={cn(
          'min-h-0 w-full flex-1 resize-y bg-transparent text-text placeholder:text-muted outline-none',
          mono ? 'font-mono text-app-13 leading-[19px]' : 'font-sans text-app-14 leading-5',
          className,
        )}
      />
    </div>
  );
}

export interface SearchFieldProps extends Omit<InputProps, 'leadingIcon' | 'type'> {
  /** Shortcut hint printed at the right (« ⌘K »). */
  shortcut?: string;
}

/** Dev · Champ with the search icon (« Rechercher… »). The borderless dark variant is the sidebar's. */
export function SearchField({ shortcut, placeholder = 'Rechercher…', trailing, ...rest }: SearchFieldProps) {
  return (
    <Input
      type="search"
      leadingIcon="search"
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={false}
      trailing={
        <>
          {trailing}
          {shortcut ? <Kbd className="text-muted">{shortcut}</Kbd> : null}
        </>
      }
      {...rest}
    />
  );
}

export interface SecretFieldProps extends Omit<InputProps, 'type' | 'trailing'> {
  /** Allow the eye toggle (default true). Stored secrets are never sent back: the field starts empty. */
  revealable?: boolean;
}

/**
 * Masked input for a NEW secret (D2 « nouveau jeton » field). Secrets saved on the server are never
 * rendered back into it (rule: secrets never return to the browser) — show « Enregistré » elsewhere.
 */
export function SecretField({ revealable = true, mono = true, ...rest }: SecretFieldProps) {
  const [visible, setVisible] = useState(false);
  return (
    <Input
      type={visible ? 'text' : 'password'}
      autoComplete="off"
      spellCheck={false}
      autoCapitalize="off"
      mono={mono}
      trailing={
        revealable ? (
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            aria-pressed={visible}
            aria-label={visible ? 'Masquer la valeur' : 'Afficher la valeur'}
            className="nu-hit -mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-muted hover:bg-hover hover:text-text"
          >
            <Icon name={visible ? 'lock' : 'eye'} size={16} />
          </button>
        ) : null
      }
      {...rest}
    />
  );
}
