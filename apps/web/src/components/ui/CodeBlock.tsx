import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface CodeBlockProps {
  /** Command line, printed as `$ <command>` in text colour (white on ink). */
  command?: string;
  /** Raw output, printed exactly as received (whitespace preserved, never reformatted). */
  children?: ReactNode;
  /**
   * `md` = `Dev · Sortie de commande` (padding 12 × 16, JetBrains Mono 12 / 18) ·
   * `sm` = the command box of a permission request (padding 10 × 12, JetBrains Mono 13).
   */
  size?: 'sm' | 'md';
  /** `error` prints the output in danger-on-dark (lacune 2: terminal errors use danger-pale). */
  tone?: 'default' | 'error';
  /** Wrap long lines instead of scrolling horizontally (phone excerpts). Default false. */
  wrap?: boolean;
  /** Accessible name of the block (e.g. « Sortie de npm run build »). */
  label?: string;
  className?: string;
}

/**
 * Dark terminal block on the Dark mode of the Color collection (`data-tone="dark"` scope: ink background,
 * white command, 62 % white output). « Texte exact du terminal, jamais reformulé. »
 */
export function CodeBlock({ command, children, size = 'md', tone = 'default', wrap = false, label, className }: CodeBlockProps) {
  const hasOutput = children !== undefined && children !== null && children !== '';
  return (
    <div
      data-tone="dark"
      role={label ? 'region' : undefined}
      aria-label={label}
      className={cn(
        'flex min-w-0 flex-col gap-0.5 rounded-md bg-bg font-mono text-text',
        size === 'md' ? 'px-4 py-3' : 'px-3 py-2.5',
        className,
      )}
    >
      {command ? (
        <code className={cn('block min-w-0 text-text', size === 'md' ? 'text-app-12' : 'text-app-13', wrap ? 'break-all whitespace-pre-wrap' : 'truncate whitespace-pre')}>
          {`$ ${command}`}
        </code>
      ) : null}
      {hasOutput ? (
        <pre
          className={cn(
            'm-0 min-w-0 font-mono text-app-12 leading-[18px]',
            tone === 'error' ? 'text-danger-on-dark' : 'text-muted',
            wrap ? 'break-words whitespace-pre-wrap' : 'overflow-x-auto whitespace-pre',
          )}
        >
          {children}
        </pre>
      ) : null}
    </div>
  );
}
