'use client';

import { Checkbox as RadixCheckbox } from 'radix-ui';
import { Icon } from '@/components/icons';
import { cn } from '@/lib/cn';

export interface CheckboxProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  /** Form field name (a hidden checkbox is rendered for form posts, value `on` by default). */
  name?: string;
  value?: string;
  id?: string;
  /** Required when no <label htmlFor> names the checkbox. */
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  className?: string;
}

/**
 * W5 `Case` (« Fichier inclus »), also the option row of the T8 confirmations: 18 × 18, `--bg` with a
 * 1 px border when unchecked, `--accent` with a white check 12 when checked; 44 px hit area.
 * role="checkbox" (Radix): Space toggles, a <label htmlFor> names and toggles it.
 */
export function Checkbox({ className, onCheckedChange, ...props }: CheckboxProps) {
  return (
    <RadixCheckbox.Root
      {...props}
      {...(onCheckedChange ? { onCheckedChange: (state) => onCheckedChange(state === true) } : {})}
      className={cn(
        'nu-hit inline-flex size-[18px] shrink-0 items-center justify-center rounded-[6px] border border-border bg-bg text-on-accent',
        'transition-colors duration-(--dur-fast) data-[state=checked]:border-accent data-[state=checked]:bg-accent',
        'disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
    >
      <RadixCheckbox.Indicator className="inline-flex">
        <Icon name="check" size={12} />
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );
}
