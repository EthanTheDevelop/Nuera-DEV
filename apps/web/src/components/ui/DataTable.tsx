import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface DataTableColumn<Row> {
  key: string;
  /** Header copy as written in Figma (« SESSION », « DÉBUT · DURÉE ») — rendered as a mono overline. */
  header: string;
  /** Fixed width in px (D06: 140, 170, 160, 200, 120); omit for the flexible first column. */
  width?: number;
  align?: 'left' | 'right';
  cell: (row: Row) => ReactNode;
  /** Hide the column below the `lg` breakpoint (tablet). */
  hideBelowLg?: boolean;
  className?: string;
}

export interface DataTableProps<Row> {
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  getRowKey: (row: Row) => string;
  /** Visually hidden caption (the visible title is the page's SectionLabel). */
  caption: string;
  /** Rendered in place of the body when `rows` is empty (an EmptyState variant="plain"). */
  empty?: ReactNode;
  /** Wrap in the D06 table tile (radius 28, Shadow/Soft, padding 8 × 20). Default true. */
  card?: boolean;
  className?: string;
}

/**
 * D06 `Tableau de l'historique` / D02 project table: header row (py 10, gap 16, bottom border) with
 * JetBrains Mono 11 caps 0.08em muted labels; rows py 12, bottom border except the last.
 * A real <table> (table-fixed) so screen readers get the column headers.
 */
export function DataTable<Row>({ columns, rows, getRowKey, caption, empty, card = true, className }: DataTableProps<Row>) {
  return (
    <div className={cn(card && 'rounded-xl bg-bg px-5 py-2 shadow-soft', 'w-full overflow-x-auto', className)}>
      <table className="w-full table-fixed border-collapse text-left">
        <caption className="sr-only">{caption}</caption>
        <colgroup>
          {columns.map((c) => (
            <col key={c.key} style={c.width ? { width: c.width } : undefined} className={cn(c.hideBelowLg && 'max-lg:hidden')} />
          ))}
        </colgroup>
        <thead>
          <tr className="border-b border-border">
            {columns.map((c, i) => (
              <th
                key={c.key}
                scope="col"
                className={cn(
                  'py-2.5 font-mono text-app-11 font-normal tracking-label whitespace-nowrap text-muted uppercase',
                  i > 0 && 'pl-4',
                  c.align === 'right' && 'text-right',
                  c.hideBelowLg && 'max-lg:hidden',
                )}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && empty ? (
            <tr>
              <td colSpan={columns.length}>{empty}</td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={getRowKey(row)} className="border-b border-border last:border-b-0">
                {columns.map((c, i) => (
                  <td
                    key={c.key}
                    className={cn(
                      'py-3 align-middle font-sans text-app-13 text-text',
                      i > 0 && 'pl-4',
                      c.align === 'right' && 'text-right',
                      c.hideBelowLg && 'max-lg:hidden',
                      c.className,
                    )}
                  >
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
