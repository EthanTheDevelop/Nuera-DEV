'use client';

import type { ReactNode } from 'react';
import { Select as RadixSelect } from 'radix-ui';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/icons';
import { fieldShellClasses, useFieldControl } from './Field';

export interface SelectOption {
  value: string;
  label: string;
  /** Second line in the list (e.g. the model id the CLI reports). */
  description?: string;
  disabled?: boolean;
}

export interface SelectProps {
  options: readonly SelectOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  /** Prefix printed before the selected label, as in D06 filters (« Projet : tous », « Statut : tous »). */
  prefix?: string;
  /** Leading 16 px icon. */
  icon?: IconName;
  size?: 'md' | 'lg';
  invalid?: boolean;
  disabled?: boolean;
  /** Form field name (a hidden native select is rendered for form posts). */
  name?: string;
  required?: boolean;
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  /** Class of the trigger (width: D08 dropdowns are 140 wide, D06 filters 180/200). */
  className?: string;
  /** Extra content at the end of the list (rare). */
  footer?: ReactNode;
}

/**
 * « Liste déroulante » variant of Dev · Champ: same shell, trailing chevron-down 16 muted.
 * Built on Radix Select (keyboard, typeahead, screen readers).
 */
export function Select({
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder = 'Choisir…',
  prefix,
  icon,
  size = 'md',
  invalid,
  disabled,
  name,
  required,
  id,
  className,
  footer,
  ...aria
}: SelectProps) {
  const control = useFieldControl({ id, invalid, 'aria-describedby': aria['aria-describedby'] });
  return (
    <RadixSelect.Root
      {...(value !== undefined ? { value } : {})}
      {...(defaultValue !== undefined ? { defaultValue } : {})}
      {...(onValueChange ? { onValueChange } : {})}
      disabled={disabled}
      name={name}
      required={required}
    >
      <RadixSelect.Trigger
        id={control.id}
        aria-label={aria['aria-label']}
        aria-describedby={control.describedBy}
        aria-invalid={control.invalid || undefined}
        className={cn(
          fieldShellClasses(control.invalid, size, disabled),
          'cursor-pointer text-left outline-none focus-visible:border-accent focus-visible:shadow-[inset_0_0_0_0.5px_var(--accent)] data-[state=open]:border-accent',
          className,
        )}
      >
        {icon ? <Icon name={icon} size={16} className="text-muted" /> : null}
        <span className="min-w-0 flex-1 truncate data-[placeholder]:text-muted">
          {prefix ? <span>{prefix}</span> : null}
          <RadixSelect.Value placeholder={<span className="text-muted">{placeholder}</span>} />
        </span>
        <RadixSelect.Icon asChild>
          <Icon name="chevron-down" size={16} className="text-muted" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={6}
          collisionPadding={12}
          className="nu-pop z-50 max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) overflow-hidden rounded-md border border-border bg-bg p-1 shadow-float"
        >
          <RadixSelect.Viewport className="flex flex-col gap-0.5">
            {options.map((option) => (
              <RadixSelect.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className="relative flex cursor-pointer flex-col rounded-sm py-2 pr-8 pl-3 font-sans text-app-14 text-text outline-none select-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 data-[highlighted]:bg-hover data-[state=checked]:font-medium"
              >
                <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                {option.description ? (
                  <span className="font-mono text-app-11 text-muted">{option.description}</span>
                ) : null}
                <RadixSelect.ItemIndicator className="absolute top-1/2 right-2 -translate-y-1/2 text-accent">
                  <Icon name="check" size={16} />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
          {footer}
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
