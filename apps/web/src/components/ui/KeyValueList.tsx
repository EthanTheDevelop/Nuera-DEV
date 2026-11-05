import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface KeyValueItem {
  /** Stable key (defaults to the label when it is a string). */
  key?: string;
  label: ReactNode;
  value: ReactNode;
  /** Value in JetBrains Mono 12 (default true: paths, versions, transports). */
  mono?: boolean;
}

export interface KeyValueListProps {
  items: readonly KeyValueItem[];
  className?: string;
}

/**
 * Drawer key/value rows (D1 « ÉTAT », « CONFIGURATION »): padding 9 × 0, 1 px border bottom except the
 * last row, gap 12, label Outfit 400 14, value JetBrains Mono 12 right-aligned. Semantic <dl>.
 */
export function KeyValueList({ items, className }: KeyValueListProps) {
  return (
    <dl className={cn('m-0 flex flex-col', className)}>
      {items.map((item, i) => (
        <div
          key={item.key ?? (typeof item.label === 'string' ? item.label : i)}
          className="flex items-baseline justify-between gap-3 border-b border-border py-[9px] last:border-b-0"
        >
          <dt className="min-w-0 font-sans text-app-14 text-text">{item.label}</dt>
          <dd className={cn('m-0 min-w-0 text-right break-words text-text', item.mono === false ? 'font-sans text-app-14' : 'font-mono text-app-12')}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
