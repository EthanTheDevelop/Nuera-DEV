/**
 * Tones used by the composites — the same unions as the UI kit primitives:
 * - `Badge` « Ton » : Accent · Succes · Alerte · Danger · Neutre (`BadgeTone`)
 * - `Dev · Point de statut` « Ton » : Succès · En cours · Alerte · Danger · Neutre · Accent (`StatusTone`)
 * Type-only re-exports: this module stays importable from plain unit tests.
 */
export type { BadgeTone, StatusTone as DotTone } from '@/components/ui';

/** Text colour utility for a tone (labels drawn next to a status dot, coloured meta). */
export const TONE_TEXT = {
  accent: 'text-accent',
  success: 'text-success',
  warn: 'text-warn',
  danger: 'text-danger',
  neutral: 'text-muted',
  running: 'text-en-cours',
} as const;
