/**
 * Small text builders shared by the Nuera Dev composites. Every number goes through
 * `@nuera/shared/format` (fr-FR, regular spaces as in Figma).
 *
 * Copy rules (Figma, verbatim): deletions use the minus sign U+2212 (`+46 −12`), separators are
 * ` · ` (U+00B7 with regular spaces).
 */
import { formatNumber, plural } from '@nuera/shared/format';

/** U+2212 MINUS SIGN — the deletion sign everywhere in the mockups (never a hyphen). */
export const MINUS = '−';

/** U+00B7 MIDDLE DOT surrounded by regular spaces. */
export const SEP = ' · ';

/** Joins non-empty parts with ` · `. */
export function joinParts(...parts: Array<string | null | undefined | false>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(SEP);
}

/** « +46 » */
export function formatAdditions(count: number): string {
  return `+${formatNumber(count)}`;
}

/** « −12 » (U+2212) */
export function formatDeletions(count: number): string {
  return `${MINUS}${formatNumber(count)}`;
}

/**
 * Line delta as written on tool lines and file rows: « +46 −12 », « +38 », « −64 ».
 * Zero parts are omitted (Figma: `Ajouté` shows only `+38`); returns '' when both are zero/absent.
 */
export function formatLineDelta(additions?: number | null, deletions?: number | null): string {
  const parts: string[] = [];
  if (additions && additions > 0) parts.push(formatAdditions(additions));
  if (deletions && deletions > 0) parts.push(formatDeletions(deletions));
  return parts.join(' ');
}

/** « 1 bloc », « 2 blocs » (diff hunks). */
export function formatHunkCount(count: number): string {
  return plural(count, 'bloc');
}

/** « 1 fichier », « 4 fichiers » */
export function formatFileCount(count: number): string {
  return plural(count, 'fichier');
}

/** « 1 sur 4 » (pager position). */
export function formatPosition(index: number, total: number): string {
  return `${formatNumber(index)} sur ${formatNumber(total)}`;
}

/** « 3 / 5 » (plan progress, capacity). */
export function formatRatio(done: number, total: number): string {
  return `${formatNumber(done)} / ${formatNumber(total)}`;
}

/** Last path segment: « src/modules/crm/PipelineBoard.tsx » → « PipelineBoard.tsx ». */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
