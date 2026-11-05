'use client';

import { createContext, useContext, type ComponentProps, type ReactNode } from 'react';
import { Tabs as RadixTabs } from 'radix-ui';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/icons';

/**
 * Tabs (Radix: roving focus, role="tablist"/"tab"/"tabpanel").
 * - `pill` (default): Badge-styled tabs as in D04 / D08 and the Workspace context panel — active = Badge
 *   Accent, others = Badge Neutre, gap 4; on narrow screens the row scrolls horizontally (M04).
 * - `segmented`: the phone Workspace tabs (M05) — 44 px track, surface-raised + 1 px border, radius 12,
 *   padding 3, gap 2; equal tabs, active = accent-pale / accent SemiBold 13, inactive = muted Medium 13.
 */
export const Tabs = RadixTabs.Root;

type TabsVariant = 'pill' | 'segmented';
const VariantContext = createContext<TabsVariant>('pill');

export interface TabsListProps extends ComponentProps<typeof RadixTabs.List> {
  variant?: TabsVariant;
}

export function TabsList({ variant = 'pill', className, ...props }: TabsListProps) {
  return (
    <VariantContext.Provider value={variant}>
      <RadixTabs.List
        className={cn(
          variant === 'pill'
            ? // -my/py: room inside the scroll container for the 44 px hit areas of the 23 px pills
              'nu-scroll-x -my-2.5 flex max-w-full items-center gap-1 py-2.5'
            : 'flex h-11 w-full items-stretch gap-0.5 rounded-md border border-border bg-surface-raised p-[3px]',
          className,
        )}
        {...props}
      />
    </VariantContext.Provider>
  );
}

export interface TabsTriggerProps extends Omit<ComponentProps<typeof RadixTabs.Trigger>, 'children'> {
  children: ReactNode;
  /** Appended as « · N » when defined and > 0 (« Modifications · 4 », « Diff · 4 »). */
  count?: number;
  icon?: IconName;
}

const triggerVariants: Record<TabsVariant, string> = {
  pill: cn(
    'rounded-full px-2 py-1 text-app-12 font-medium bg-surface-raised text-muted hover:text-text',
    'data-[state=active]:bg-accent-pale data-[state=active]:text-accent',
  ),
  segmented: cn(
    'flex-1 rounded-sm px-2 text-app-13 font-medium text-muted hover:text-text',
    'data-[state=active]:bg-accent-pale data-[state=active]:font-semibold data-[state=active]:text-accent',
  ),
};

export function TabsTrigger({ className, children, count, icon, ...props }: TabsTriggerProps) {
  const variant = useContext(VariantContext);
  return (
    <RadixTabs.Trigger
      className={cn(
        'nu-hit inline-flex shrink-0 items-center justify-center gap-1.5 font-sans whitespace-nowrap select-none',
        'transition-colors duration-(--dur-fast) ease-out disabled:cursor-not-allowed disabled:opacity-40',
        triggerVariants[variant],
        className,
      )}
      {...props}
    >
      {icon ? <Icon name={icon} size={14} /> : null}
      <span className="truncate">
        {children}
        {count !== undefined && count > 0 ? ` · ${count}` : null}
      </span>
    </RadixTabs.Trigger>
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof RadixTabs.Content>) {
  return <RadixTabs.Content className={cn('outline-none', className)} {...props} />;
}
