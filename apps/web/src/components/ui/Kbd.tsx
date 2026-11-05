import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface KbdProps {
  children: ReactNode;
  /** `plain` = mono text only, as « ⌘K » in the sidebar search; `boxed` = bordered key cap. */
  variant?: 'plain' | 'boxed';
  className?: string;
}

/** Keyboard shortcut, JetBrains Mono 500 11 (« ⌘K », « Échap »). */
export function Kbd({ children, variant = 'plain', className }: KbdProps) {
  return (
    <kbd
      className={cn(
        'inline-flex items-center font-mono text-app-11 font-medium',
        variant === 'boxed' && 'rounded-sm border border-border px-1.5 py-0.5 text-muted',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
