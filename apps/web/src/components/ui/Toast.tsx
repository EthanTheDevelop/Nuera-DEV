'use client';

import Link from 'next/link';
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { Toast as RadixToast } from 'radix-ui';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/icons';

/* -----------------------------------------------------------------------------------------------
   Dev · Toast (203:709) — « Confirmation éphémère d'une opération réussie, en bas à droite (bureau) ou
   au-dessus de la saisie (téléphone). » T3: « le toast disparaît seul après 6 s et reste lisible au
   survol. » Success confirmations only: errors use a Banner or an ErrorPanel (T4).
   ----------------------------------------------------------------------------------------------- */

export const TOAST_DURATION_MS = 6000;

export interface ToastAction {
  label: string;
  /** Internal route or external URL (« Voir sur GitHub »). */
  href?: string;
  external?: boolean;
  onClick?: () => void;
}

export interface ToastInput {
  message: string;
  action?: ToastAction;
  /** Default `check` (success-on-dark). */
  icon?: IconName;
  duration?: number;
}

interface ToastEntry extends ToastInput {
  id: number;
  open: boolean;
}

let entries: ToastEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
/** Stable server snapshot (useSyncExternalStore requires a cached value). */
const NO_TOASTS: ToastEntry[] = [];

const store = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: () => entries,
  getServerSnapshot: () => NO_TOASTS,
};

/** Show a success toast. Returns its id (for `dismissToast`). Safe to call from any client code. */
export function toast(input: ToastInput | string): number {
  const value = typeof input === 'string' ? { message: input } : input;
  const id = nextId++;
  entries = [...entries.slice(-3), { ...value, id, open: true }];
  emit();
  return id;
}

export function dismissToast(id: number) {
  entries = entries.map((e) => (e.id === id ? { ...e, open: false } : e));
  emit();
}

function remove(id: number) {
  entries = entries.filter((e) => e.id !== id);
  emit();
}

/**
 * Lift the toasts above a bottom bar (phone tab bar, composer). The shells set it; the Workspace sets
 * the composer height while mounted.
 */
export function useToastOffset(bottomPx: number | null) {
  useEffect(() => {
    if (bottomPx === null) return;
    const root = document.documentElement;
    const previous = root.style.getPropertyValue('--toast-bottom');
    root.style.setProperty('--toast-bottom', `${bottomPx}px`);
    return () => {
      if (previous) root.style.setProperty('--toast-bottom', previous);
      else root.style.removeProperty('--toast-bottom');
    };
  }, [bottomPx]);
}

function ToastActionNode({ action, close }: { action: ToastAction; close: () => void }) {
  const className =
    'nu-hit shrink-0 font-sans text-app-14 font-semibold text-accent-on-dark underline-offset-4 hover:underline';
  const onClick = () => {
    action.onClick?.();
    close();
  };
  return (
    <RadixToast.Action asChild altText={action.label}>
      {action.href ? (
        action.external || /^[a-z][a-z0-9+.-]*:/i.test(action.href) ? (
          <a href={action.href} target="_blank" rel="noopener noreferrer" className={className} onClick={onClick}>
            {action.label}
          </a>
        ) : (
          <Link href={action.href} className={className} onClick={onClick}>
            {action.label}
          </Link>
        )
      ) : (
        <button type="button" className={className} onClick={onClick}>
          {action.label}
        </button>
      )}
    </RadixToast.Action>
  );
}

/** Mount once (the root providers do). Renders the viewport and the queue fed by `toast()`. */
export function Toaster({ children }: { children?: ReactNode }) {
  const list = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  return (
    <RadixToast.Provider duration={TOAST_DURATION_MS} swipeDirection="right" label="Notifications">
      {children}
      {list.map((t) => (
        <RadixToast.Root
          key={t.id}
          type="background"
          open={t.open}
          duration={t.duration ?? TOAST_DURATION_MS}
          onOpenChange={(open) => {
            if (!open) {
              dismissToast(t.id);
              window.setTimeout(() => remove(t.id), 400);
            }
          }}
          className={cn(
            'nu-toast pointer-events-auto flex w-full items-center gap-3 rounded-md bg-near-black px-4 py-3 shadow-float nav:w-auto nav:max-w-[480px]',
          )}
        >
          <Icon name={t.icon ?? 'check'} size={18} className="text-success-on-dark" />
          <RadixToast.Description className="min-w-0 flex-1 font-sans text-app-14 text-paper">{t.message}</RadixToast.Description>
          {t.action ? <ToastActionNode action={t.action} close={() => dismissToast(t.id)} /> : null}
        </RadixToast.Root>
      ))}
      <RadixToast.Viewport
        className={cn(
          'fixed z-[70] m-0 flex list-none flex-col items-stretch gap-(--toast-gap) p-0 outline-none',
          'inset-x-4 bottom-[calc(var(--toast-bottom,16px)+env(safe-area-inset-bottom))]',
          'nav:inset-x-auto nav:right-6 nav:bottom-6 nav:items-end',
        )}
      />
    </RadixToast.Provider>
  );
}
