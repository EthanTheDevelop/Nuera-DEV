'use client';

import type { ReactNode } from 'react';
import { Tooltip as RadixTooltip } from 'radix-ui';
import { cn } from '@/lib/cn';

/** Mount once near the root (the shells do it). */
export const TooltipProvider = RadixTooltip.Provider;

export interface TooltipProps {
  /** Tooltip text (also the accessible description of the trigger). */
  content: ReactNode;
  /** The trigger — must be a single focusable element (rendered with `asChild`). */
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  delayDuration?: number;
  className?: string;
}

/**
 * Small dark label (not drawn in Figma): near-black, paper text, Outfit 12, radius 8.
 * Used for the rail's labels (« Libellés absents à l'écran ») and per-day uptime bars. Never the only
 * carrier of information: the trigger keeps its aria-label.
 */
export function Tooltip({ content, children, side = 'top', align = 'center', delayDuration = 300, className }: TooltipProps) {
  return (
    <RadixTooltip.Root delayDuration={delayDuration}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={8}
          className={cn(
            'nu-pop z-[60] max-w-64 rounded-sm bg-near-black px-2 py-1 font-sans text-app-12 text-paper shadow-float',
            className,
          )}
        >
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
