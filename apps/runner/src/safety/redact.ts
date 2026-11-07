/**
 * Best-effort redaction of credentials in text that leaves the runner: the patterns live in
 * `@nuera/shared/runner` (the web applies the same ones to a dev server output it hands to Claude).
 */
export { redactSecrets } from '@nuera/shared/runner';

/** Keeps the head and the tail of a long text (UTF-16 length based). */
export function capText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  return { text: `${text.slice(0, head)}\n…\n${text.slice(text.length - tail)}`, truncated: true };
}

/** Keeps only the tail of a text (logs). */
export function tailText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}
