'use client';

import type { ReactNode } from 'react';
import { Dialog as RadixDialog } from 'radix-ui';
import { cn } from '@/lib/cn';
import { IconButton } from './IconButton';

/**
 * Modal window (« Fenêtre » + « Voile »): Radix Dialog — focus trap, Esc and scrim click close,
 * aria-labelledby/-describedby. Desktop = centred card (640 = D03/A1–A4, 520 = T8); below the `nav`
 * breakpoint it docks to the bottom edge, full width, like the phone sheets.
 */
export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

export interface DialogContentProps {
  title: ReactNode;
  /** Sub-line under the title (Outfit 14 muted). */
  description?: ReactNode;
  /** Extra header content under the title row (the 3-step stepper of « Ajouter un projet »). */
  header?: ReactNode;
  /** Footer actions, right-aligned (Button Default « Annuler » + Button Accent named action). */
  footer?: ReactNode;
  /** Helper text on the left of the footer (Outfit 12 muted). */
  footerNote?: ReactNode;
  /** `md` = 640 (default) · `sm` = 520 (confirmations) · `lg` = 680 (W5 commit). */
  size?: 'sm' | 'md' | 'lg';
  /** Hide the « Fermer » icon button (the footer then must offer a way out). */
  hideClose?: boolean;
  /** `alertdialog` for confirmations (T8). */
  role?: 'dialog' | 'alertdialog';
  /** Prevent closing on outside click / Esc while a mutation runs. */
  dismissible?: boolean;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}

const widths = { sm: 'nav:w-[min(var(--dialog-confirm-w),calc(100vw-32px))]', md: 'nav:w-[min(var(--dialog-w),calc(100vw-32px))]', lg: 'nav:w-[min(680px,calc(100vw-32px))]' } as const;

export function DialogContent({
  title,
  description,
  header,
  footer,
  footerNote,
  size = 'md',
  hideClose = false,
  role = 'dialog',
  dismissible = true,
  className,
  bodyClassName,
  children,
}: DialogContentProps) {
  const block = (event: Event) => {
    if (!dismissible) event.preventDefault();
  };
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="nu-scrim fixed inset-0 z-50 bg-scrim" />
      <RadixDialog.Content
        role={role}
        onEscapeKeyDown={block}
        onPointerDownOutside={block}
        onInteractOutside={block}
        {...(description ? {} : { 'aria-describedby': undefined })}
        className={cn(
          'nu-dialog fixed z-50 flex flex-col overflow-hidden bg-bg text-text shadow-float outline-none',
          // phone: docked sheet
          'inset-x-0 bottom-0 max-h-[92dvh] w-full rounded-t-xl pb-[env(safe-area-inset-bottom)]',
          // desktop: centred window
          'nav:inset-x-auto nav:bottom-auto nav:top-1/2 nav:left-1/2 nav:max-h-[calc(100dvh-48px)] nav:-translate-x-1/2 nav:-translate-y-1/2 nav:rounded-xl nav:pb-0',
          widths[size],
          className,
        )}
      >
        <div className="flex flex-col gap-4 border-b border-border px-5 pt-6 pb-5 nav:px-7">
          <div className="flex items-start gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <RadixDialog.Title className="m-0 font-sans text-app-22 font-semibold text-text">{title}</RadixDialog.Title>
              {description ? (
                <RadixDialog.Description className="m-0 font-sans text-app-14 text-muted">{description}</RadixDialog.Description>
              ) : null}
            </div>
            {hideClose ? null : (
              <RadixDialog.Close asChild>
                <IconButton icon="x" label="Fermer" size="sm" iconClassName="text-muted" disabled={!dismissible} />
              </RadixDialog.Close>
            )}
          </div>
          {header}
        </div>
        <div className={cn('flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-6 nav:px-7', bodyClassName)}>{children}</div>
        {footer || footerNote ? (
          <div className="flex flex-col-reverse gap-3 border-t border-border px-5 py-4 nav:flex-row nav:items-center nav:px-7">
            {footerNote ? <p className="m-0 min-w-0 flex-1 font-sans text-app-12 text-muted">{footerNote}</p> : <span className="hidden flex-1 nav:block" />}
            {footer ? <div className="flex flex-wrap items-center justify-end gap-3">{footer}</div> : null}
          </div>
        ) : null}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
