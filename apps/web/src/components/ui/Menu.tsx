'use client';

import type { ComponentProps, ReactNode } from 'react';
import Link from 'next/link';
import { DropdownMenu as RadixMenu, Popover as RadixPopover } from 'radix-ui';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/icons';

/* -----------------------------------------------------------------------------------------------
   DropdownMenu — D02 row menu `Menu · Atelier Lune` and the account menu.
   Panel: bg surface, 1 px border, radius 12, padding 6, gap 2, Shadow/Float, anchored bottom-end
   with an 8 px offset. Option: padding 8 × 10, gap 10, radius 8, icon 16 + Outfit 400 14;
   highlighted = accent-pale; destructive = danger icon and label.
   ----------------------------------------------------------------------------------------------- */

export const DropdownMenu = RadixMenu.Root;
export const DropdownMenuTrigger = RadixMenu.Trigger;
export const DropdownMenuGroup = RadixMenu.Group;

export interface DropdownMenuContentProps extends ComponentProps<typeof RadixMenu.Content> {
  /** Panel width (D02: 248). */
  width?: number;
}

export function DropdownMenuContent({
  className,
  align = 'end',
  side = 'bottom',
  sideOffset = 8,
  width = 248,
  style,
  ...props
}: DropdownMenuContentProps) {
  return (
    <RadixMenu.Portal>
      <RadixMenu.Content
        align={align}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={12}
        style={{ width, ...style }}
        className={cn(
          'nu-pop z-50 flex max-w-[calc(100vw-24px)] flex-col gap-0.5 rounded-md border border-border bg-bg p-1.5 text-text shadow-float outline-none',
          className,
        )}
        {...props}
      />
    </RadixMenu.Portal>
  );
}

export interface DropdownMenuItemProps extends Omit<ComponentProps<typeof RadixMenu.Item>, 'children'> {
  icon?: IconName;
  /** Destructive option (« Archiver le projet… », « Se déconnecter »). */
  destructive?: boolean;
  /** Right side (Badge, shortcut). */
  aside?: ReactNode;
  children: ReactNode;
}

const itemClasses = cn(
  'relative flex min-h-11 nav:min-h-9 cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-2 font-sans text-app-14 text-text outline-none select-none',
  'data-[highlighted]:bg-accent-pale data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40',
);

export function DropdownMenuItem({ icon, destructive, aside, className, children, ...props }: DropdownMenuItemProps) {
  return (
    <RadixMenu.Item className={cn(itemClasses, destructive && 'text-danger', className)} {...props}>
      {icon ? <Icon name={icon} size={16} className={destructive ? 'text-danger' : 'text-text'} /> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {aside}
    </RadixMenu.Item>
  );
}

export interface DropdownMenuLinkItemProps extends Omit<DropdownMenuItemProps, 'asChild' | 'onSelect'> {
  href: string;
  /** Opens in a new tab (GitHub…). */
  external?: boolean;
}

/** Menu option that navigates. */
export function DropdownMenuLinkItem({
  href,
  external,
  icon,
  destructive,
  aside,
  className,
  children,
  ...props
}: DropdownMenuLinkItemProps) {
  const content = (
    <>
      {icon ? <Icon name={icon} size={16} className={destructive ? 'text-danger' : 'text-text'} /> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {aside}
    </>
  );
  return (
    <RadixMenu.Item asChild className={cn(itemClasses, destructive && 'text-danger', className)} {...props}>
      {external ? (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {content}
        </a>
      ) : (
        <Link href={href}>{content}</Link>
      )}
    </RadixMenu.Item>
  );
}

export function DropdownMenuSeparator({ className }: { className?: string }) {
  return <RadixMenu.Separator className={cn('mx-1 my-1 h-px bg-border', className)} />;
}

export function DropdownMenuLabel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <RadixMenu.Label className={cn('px-2.5 pt-1.5 pb-1 font-mono text-app-11 tracking-label text-muted uppercase', className)}>
      {children}
    </RadixMenu.Label>
  );
}

/* -----------------------------------------------------------------------------------------------
   Popover — floating panel on light pages (W6 session selector, notification panel).
   bg surface, 1 px border, radius 20, Shadow/Float.
   ----------------------------------------------------------------------------------------------- */

export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverClose = RadixPopover.Close;
export const PopoverAnchor = RadixPopover.Anchor;

export interface PopoverContentProps extends ComponentProps<typeof RadixPopover.Content> {
  width?: number;
}

export function PopoverContent({
  className,
  align = 'end',
  sideOffset = 8,
  width = 400,
  style,
  ...props
}: PopoverContentProps) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={12}
        style={{ width, ...style }}
        className={cn(
          'nu-pop z-50 flex max-w-[calc(100vw-24px)] flex-col rounded-lg border border-border bg-bg text-text shadow-float outline-none',
          className,
        )}
        {...props}
      />
    </RadixPopover.Portal>
  );
}
