import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import type { IconName } from '@/components/icons';
import { Pastille } from './Pastille';

export interface EmptyStateProps {
  /** The section's own icon (T2: « la pastille reprend l'icône de la section »). */
  icon: IconName;
  title: ReactNode;
  /** Why the list is empty (Outfit 14 / 20 muted, centred). */
  children: ReactNode;
  /** The single useful action (Button, CompactButton…). */
  action?: ReactNode;
  /** `card` (T2 tile: radius 28, padding 32 × 24, Shadow/Soft) or `plain` (inside an existing card). */
  variant?: 'card' | 'plain';
  titleAs?: 'h2' | 'h3' | 'p';
  className?: string;
}

/**
 * T2 « Une liste vide dit pourquoi elle l'est et propose la seule action utile. Jamais d'illustration
 * décorative : la pastille reprend l'icône de la section. »
 */
export function EmptyState({ icon, title, children, action, variant = 'card', titleAs: Title = 'h2', className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-3 text-center',
        variant === 'card' ? 'rounded-xl bg-bg px-6 py-8 shadow-soft' : 'px-4 py-6',
        className,
      )}
    >
      <Pastille icon={icon} size={56} shape="circle" />
      <Title className="m-0 font-sans text-app-18 font-semibold text-text">{title}</Title>
      <div className="max-w-[44ch] font-sans text-app-14 leading-5 text-muted">{children}</div>
      {action ? <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </div>
  );
}
