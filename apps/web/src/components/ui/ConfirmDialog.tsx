'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import { Dialog as RadixDialog } from 'radix-ui';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/icons';
import { Banner } from './Banner';
import { Button } from './Button';
import { Input, Label } from './Field';
import { Pastille } from './Pastille';

export interface Consequence {
  /** `kept` = ✓ what is kept (success check) · `risk` = ⚠ what changes or is lost (warn alert). */
  kind: 'kept' | 'risk';
  text: ReactNode;
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `warn` (arrêter, archiver) or `danger` (supprimer) — tints the head pastille. */
  tone?: 'warn' | 'danger';
  icon: IconName;
  /** The question, naming the object (« Arrêter « Module CRM · pipeline » ? »). */
  title: ReactNode;
  consequences: readonly Consequence[];
  /** Extra content between the consequences and the actions (option row, affected worktrees list). */
  children?: ReactNode;
  /** Names the action (« Arrêter la session », « Archiver », « Supprimer 2 worktrees ») — never « OK ». */
  confirmLabel: string;
  cancelLabel?: string;
  /**
   * May return a promise: the dialog shows a loading state (both buttons disabled) until it settles.
   * The caller closes the dialog on success (`onOpenChange(false)`, then a T3 toast). On a rejection the
   * dialog stays open and shows `error` — or, when the caller passes none, a generic error banner (the
   * rejection is never left unhandled).
   */
  onConfirm: () => void | Promise<void>;
  /** Error shown inside the dialog after a failed confirmation (T8: « show an error banner inside »). */
  error?: ReactNode;
  /**
   * Optional typed confirmation (not designed in T8, keep for irreversible actions only): the confirm
   * button stays disabled until the user types `expected`.
   */
  typedConfirmation?: { expected: string; label: ReactNode };
  /**
   * Lacune 1: confirmations use the Accent Button as designed; `danger` switches to the prepared
   * destructive face once the design decides.
   */
  confirmTone?: 'accent' | 'danger';
  className?: string;
}

/**
 * T8 « Une confirmation liste ce qui change et ce qui est conservé, puis nomme l'action sur son bouton. »
 * 520 wide, radius 28, padding 24, gap 16, Shadow/Float; role="alertdialog"; Esc / Voile cancel;
 * initial focus on « Annuler »; both buttons disabled while the mutation runs.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  tone = 'warn',
  icon,
  title,
  consequences,
  children,
  confirmLabel,
  cancelLabel = 'Annuler',
  onConfirm,
  error,
  typedConfirmation,
  confirmTone = 'accent',
  className,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [typed, setTyped] = useState('');
  // Each opening starts clean, even when the caller closed the dialog itself (adjusting state on a prop change).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setFailed(false);
      setTyped('');
    }
  }
  const cancelRef = useRef<HTMLButtonElement>(null);
  const descriptionId = useId();
  const typedOk = !typedConfirmation || typed.trim() === typedConfirmation.expected;

  const handleOpenChange = (next: boolean) => {
    if (pending) return;
    if (!next) {
      setTyped('');
      setFailed(false);
    }
    onOpenChange(next);
  };

  const confirm = async () => {
    if (!typedOk || pending) return;
    setPending(true);
    setFailed(false);
    try {
      await onConfirm();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  const shownError = error ?? (failed ? "L'action n'a pas abouti. Réessayez dans un instant." : null);

  return (
    <RadixDialog.Root open={open} onOpenChange={handleOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="nu-scrim fixed inset-0 z-50 bg-scrim" />
        <RadixDialog.Content
          role="alertdialog"
          aria-describedby={descriptionId}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelRef.current?.focus();
          }}
          className={cn(
            'nu-dialog fixed z-50 flex flex-col gap-4 bg-bg p-6 text-text shadow-float outline-none',
            'inset-x-0 bottom-0 max-h-[92dvh] overflow-y-auto rounded-t-xl pb-[max(24px,env(safe-area-inset-bottom))]',
            'nav:inset-x-auto nav:bottom-auto nav:top-1/2 nav:left-1/2 nav:w-[min(var(--dialog-confirm-w),calc(100vw-32px))] nav:-translate-x-1/2 nav:-translate-y-1/2 nav:rounded-xl nav:pb-6',
            className,
          )}
        >
          <div className="flex items-center gap-3">
            <Pastille icon={icon} size={40} tone={tone} />
            <RadixDialog.Title className="m-0 min-w-0 flex-1 font-sans text-app-18 font-semibold text-text">{title}</RadixDialog.Title>
          </div>
          <ul id={descriptionId} className="m-0 flex list-none flex-col gap-2 p-0">
            {consequences.map((c, i) => (
              <li key={i} className="flex items-start gap-2 font-sans text-app-13 leading-[18px] text-text">
                <Icon
                  name={c.kind === 'kept' ? 'check' : 'alert'}
                  size={16}
                  className={cn('mt-px', c.kind === 'kept' ? 'text-success' : 'text-warn')}
                />
                <span className="sr-only">{c.kind === 'kept' ? 'Conservé :' : 'Change :'}</span>
                <span className="min-w-0">{c.text}</span>
              </li>
            ))}
          </ul>
          {children}
          {typedConfirmation ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${descriptionId}-typed`}>{typedConfirmation.label}</Label>
              <Input
                id={`${descriptionId}-typed`}
                mono
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                disabled={pending}
              />
            </div>
          ) : null}
          {shownError ? <Banner tone="danger" title={shownError} /> : null}
          <div className="flex flex-col-reverse gap-2.5 nav:flex-row nav:justify-end">
            <Button ref={cancelRef} disabled={pending} onClick={() => handleOpenChange(false)} block className="nav:w-auto">
              {cancelLabel}
            </Button>
            <Button
              variant="accent"
              tone={confirmTone === 'danger' ? 'danger' : undefined}
              loading={pending}
              disabled={!typedOk}
              onClick={confirm}
              block
              className="nav:w-auto"
            >
              {confirmLabel}
            </Button>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
