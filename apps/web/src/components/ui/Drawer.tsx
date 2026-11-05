'use client';

import type { ReactNode } from 'react';
import { Dialog as RadixDialog } from 'radix-ui';
import { cn } from '@/lib/cn';
import { useReturnFocus } from './return-focus';
import type { IconName } from '@/components/icons';
import { IconButton } from './IconButton';
import { Pastille } from './Pastille';

/**
 * Right drawer « Tiroir » (D1 / D2): 480 px, full height, Shadow/Float, over the 55 % near-black Voile
 * (which also covers the sidebar). role="dialog" + aria-modal + focus trap + Esc. Full width on the phone.
 */
export const Drawer = RadixDialog.Root;
export const DrawerTrigger = RadixDialog.Trigger;
export const DrawerClose = RadixDialog.Close;

export interface DrawerContentProps {
  title: ReactNode;
  /** Sub-line under the name (Outfit 13 muted), e.g. « serveur MCP · HTTP distant ». */
  description?: ReactNode;
  /** Service icon in a 40 px accent pastille. */
  icon?: IconName;
  /** Status Badge, on its own line under the title row. */
  status?: ReactNode;
  /** Footer actions, right-aligned. */
  footer?: ReactNode;
  className?: string;
  children?: ReactNode;
}

export function DrawerContent({ title, description, icon, status, footer, className, children }: DrawerContentProps) {
  const returnFocus = useReturnFocus();
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="nu-scrim fixed inset-0 z-50 bg-scrim" />
      <RadixDialog.Content
        {...returnFocus}
        {...(description ? {} : { 'aria-describedby': undefined })}
        className={cn(
          'nu-drawer fixed inset-y-0 right-0 z-50 flex h-dvh w-full flex-col bg-bg text-text shadow-float outline-none',
          'nav:w-[min(var(--drawer-w),100vw)]',
          className,
        )}
      >
        <div className="flex flex-col gap-1.5 border-b border-border px-6 pt-[max(24px,env(safe-area-inset-top))] pb-5">
          <div className="flex items-center gap-3">
            {icon ? <Pastille icon={icon} size={40} /> : null}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <RadixDialog.Title className="m-0 truncate font-sans text-app-20 font-semibold text-text">{title}</RadixDialog.Title>
              {description ? (
                <RadixDialog.Description className="m-0 font-sans text-app-13 text-muted">{description}</RadixDialog.Description>
              ) : null}
            </div>
            <RadixDialog.Close asChild>
              <IconButton icon="x" label="Fermer" size="sm" iconClassName="text-muted" />
            </RadixDialog.Close>
          </div>
          {status ? <div className="flex">{status}</div> : null}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">{children}</div>
        {footer ? (
          <div className="flex items-center justify-end gap-2.5 border-t border-border px-6 pt-4 pb-[max(16px,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        ) : null}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
