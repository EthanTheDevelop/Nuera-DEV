'use client';

import { ToggleGroup } from 'radix-ui';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/icons';
import { badgeToneClasses } from './Badge';

export interface SegmentedItem<V extends string = string> {
  value: V;
  label: string;
  icon?: IconName;
  disabled?: boolean;
}

export interface SegmentedControlProps<V extends string = string> {
  items: readonly SegmentedItem<V>[];
  value: V;
  onValueChange: (value: V) => void;
  /** Accessible name of the group (e.g. « Vue »). */
  'aria-label': string;
  className?: string;
}

/**
 * Single-choice segmented control — D05 `Barre de vue` « Conversation / Terminal brut »:
 * bg surface, 1 px border, radius 12, padding 3, gap 2; item padding 5 × 10, radius 8, 14 px icon + Outfit 13;
 * active = accent-pale / accent SemiBold, inactive = muted Medium. Radix ToggleGroup (radio semantics).
 * For tab panels with role="tabpanel" use `Tabs` + `TabsList variant="segmented"` instead.
 */
export function SegmentedControl<V extends string = string>({
  items,
  value,
  onValueChange,
  className,
  ...aria
}: SegmentedControlProps<V>) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onValueChange(next as V); // a segmented control can never be empty
      }}
      aria-label={aria['aria-label']}
      className={cn('inline-flex items-center gap-0.5 rounded-md border border-border bg-bg p-[3px]', className)}
    >
      {items.map((item) => (
        <ToggleGroup.Item
          key={item.value}
          value={item.value}
          disabled={item.disabled}
          className={cn(
            'nu-hit inline-flex items-center gap-1.5 rounded-sm px-2.5 py-[5px] font-sans text-app-13 font-medium whitespace-nowrap text-muted',
            'transition-colors duration-(--dur-fast) ease-out hover:text-text disabled:cursor-not-allowed disabled:opacity-40',
            'data-[state=on]:bg-accent-pale data-[state=on]:font-semibold data-[state=on]:text-accent',
          )}
        >
          {item.icon ? <Icon name={item.icon} size={14} /> : null}
          {item.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}

export interface ChipGroupProps<V extends string = string> {
  items: readonly { value: V; label: string; disabled?: boolean }[];
  value: V;
  onValueChange: (value: V) => void;
  'aria-label': string;
  className?: string;
}

/**
 * Filter chips (D02 / M02 / D06 « Toutes », « Favoris »…): Badges in a row, selected = Accent,
 * others = Neutre, single select. Scrolls horizontally on the phone.
 */
export function ChipGroup<V extends string = string>({ items, value, onValueChange, className, ...aria }: ChipGroupProps<V>) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onValueChange(next as V);
      }}
      aria-label={aria['aria-label']}
      className={cn('nu-scroll-x -my-2.5 flex max-w-full items-center gap-1.5 py-2.5', className)}
    >
      {items.map((item) => (
        <ToggleGroup.Item
          key={item.value}
          value={item.value}
          disabled={item.disabled}
          className={cn(
            'nu-hit inline-flex shrink-0 items-center rounded-full px-2 py-1 font-sans text-app-12 font-medium whitespace-nowrap',
            'transition-colors duration-(--dur-fast) ease-out disabled:cursor-not-allowed disabled:opacity-40',
            badgeToneClasses.neutral,
            'hover:text-text data-[state=on]:bg-accent-pale data-[state=on]:text-accent',
          )}
        >
          {item.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
