'use client';

import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Dialog as RadixDialog, VisuallyHidden } from 'radix-ui';
import { cn } from '@/lib/cn';
import { useReturnFocus } from './return-focus';

/**
 * Phone bottom sheet (S4 `Feuille · Sessions de Nuera OS`): bg surface, top corners radius 28, Shadow/Float,
 * padding 8 16 0, grab handle 36 × 5, over the 55 % near-black Voile. Closes on scrim tap, Esc, system back
 * (Radix) and a downward drag of the handle. role="dialog" + aria-modal + focus trap.
 * The pattern for every phone picker / overflow menu (session switcher, branch picker, « Plus »…).
 */
export const Sheet = RadixDialog.Root;
export const SheetTrigger = RadixDialog.Trigger;
export const SheetClose = RadixDialog.Close;

export interface SheetContentProps {
  /** Title row (Outfit 600 18). Required for accessibility; use `hideTitle` to keep it for screen readers only. */
  title: ReactNode;
  hideTitle?: boolean;
  /** Right meta of the title row (JetBrains Mono 12 muted), e.g. « 2 / 4 ». */
  meta?: ReactNode;
  description?: ReactNode;
  className?: string;
  children?: ReactNode;
}

const DISMISS_DISTANCE = 96;
const DISMISS_VELOCITY = 0.6; // px per ms

export function SheetContent({ title, hideTitle, meta, description, className, children }: SheetContentProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useReturnFocus();
  const drag = useRef<{ y: number; t: number; pointer: number } | null>(null);
  const [offset, setOffset] = useState(0);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag.current = { y: e.clientY, t: performance.now(), pointer: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointer !== e.pointerId) return;
    setOffset(Math.max(0, e.clientY - drag.current.y));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    drag.current = null;
    if (!start) return;
    const dy = Math.max(0, e.clientY - start.y);
    const velocity = dy / Math.max(1, performance.now() - start.t);
    if (dy > DISMISS_DISTANCE || velocity > DISMISS_VELOCITY) closeRef.current?.click();
    setOffset(0);
  };

  const titleNode = (
    <RadixDialog.Title className="m-0 min-w-0 flex-1 truncate font-sans text-app-18 font-semibold text-text">{title}</RadixDialog.Title>
  );

  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="nu-scrim fixed inset-0 z-50 bg-scrim" />
      <RadixDialog.Content
        {...returnFocus}
        {...(description ? {} : { 'aria-describedby': undefined })}
        style={offset ? { transform: `translateY(${offset}px)`, transition: 'none' } : undefined}
        className={cn(
          'nu-sheet fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col gap-1 rounded-t-xl bg-bg px-4 pt-2 text-text shadow-float outline-none',
          'pb-[env(safe-area-inset-bottom)] transition-transform duration-(--dur-fast) ease-out',
          className,
        )}
      >
        <div
          className="-mx-4 -mt-2 flex cursor-grab touch-none flex-col items-center px-4 pt-2 pb-2 active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <span aria-hidden className="h-[5px] w-(--sheet-handle-w) rounded-[3px] bg-border" />
        </div>
        {hideTitle ? (
          <VisuallyHidden.Root>{titleNode}</VisuallyHidden.Root>
        ) : (
          <div className="flex items-center gap-3 pt-1 pb-2">
            {titleNode}
            {meta ? <span className="shrink-0 font-mono text-app-12 text-muted">{meta}</span> : null}
          </div>
        )}
        {description ? (
          <RadixDialog.Description className="m-0 font-sans text-app-13 text-muted">{description}</RadixDialog.Description>
        ) : null}
        <div className="-mx-4 min-h-0 flex-1 overflow-y-auto px-4 pb-4">{children}</div>
        <RadixDialog.Close ref={closeRef} className="sr-only" tabIndex={-1} aria-hidden>
          Fermer
        </RadixDialog.Close>
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
