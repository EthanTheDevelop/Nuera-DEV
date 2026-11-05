'use client';

import { Switch as RadixSwitch } from 'radix-ui';
import { cn } from '@/lib/cn';

export interface SwitchProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  /** Form field name (a hidden checkbox is rendered for form posts). */
  name?: string;
  value?: string;
  id?: string;
  /** Required when no <label htmlFor> names the switch. */
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  className?: string;
}

/**
 * `Dev · Interrupteur` (202:459): 36 × 20 pill, 16 px knob; Oui = accent track, Non = border track.
 * « Même dessin que l'interrupteur de Nuera OS (Réglages · Connexions), passé à l'accent : le vert ChatGPT y
 * est réservé à ChatGPT. Zone tactile de 44 px à prévoir autour. » → role="switch", 44 px hit area.
 */
export function Switch({ className, ...props }: SwitchProps) {
  return (
    <RadixSwitch.Root
      {...props}
      className={cn(
        'nu-hit relative inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5',
        'bg-border transition-colors duration-(--dur-fast) ease-out data-[state=checked]:bg-accent',
        'disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
    >
      <RadixSwitch.Thumb
        className={cn(
          'block size-4 rounded-full bg-paper',
          'translate-x-0 transition-transform duration-(--dur-fast) ease-out data-[state=checked]:translate-x-4',
        )}
      />
    </RadixSwitch.Root>
  );
}
