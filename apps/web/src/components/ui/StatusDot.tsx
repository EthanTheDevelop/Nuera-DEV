import { cn } from '@/lib/cn';

/** `Dev · Point de statut` tones: Succès, En cours, Alerte, Danger, Neutre, Accent. */
export type StatusTone = 'success' | 'running' | 'warn' | 'danger' | 'neutral' | 'accent';

/** Inside dark scopes (sidebar, toast) success/alert switch to their on-dark values (#5fc48b, #f2c14e). */
const tones: Record<StatusTone, string> = {
  success: 'bg-success tone-dark:bg-success-on-dark',
  running: 'bg-en-cours',
  warn: 'bg-warn tone-dark:bg-warn-on-dark',
  danger: 'bg-danger',
  neutral: 'bg-muted',
  accent: 'bg-accent',
};

export interface StatusDotProps {
  tone: StatusTone;
  className?: string;
}

/**
 * « Pastille de 8 px qui précède un libellé d'état. Ne porte jamais seule l'information : toujours avec
 * un texte. » → decorative (`aria-hidden`); the adjacent text carries the state.
 */
export function StatusDot({ tone, className }: StatusDotProps) {
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', tones[tone], className)} />;
}
