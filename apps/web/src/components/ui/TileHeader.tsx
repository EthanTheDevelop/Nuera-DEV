import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import type { IconName } from '@/components/icons';
import { Pastille } from './Pastille';

export interface TileHeaderProps {
  /** Section glyph shown in the 28 px accent pastille (server, terminal, history, projets, git-commit, plug…). */
  icon: IconName;
  title: ReactNode;
  /** Right side: a LinkButton (« Toutes les sessions », « Gérer »), a Badge or a CompactButton. */
  action?: ReactNode;
  /** Heading level of the title (default h2 — tiles are sections of the page). */
  titleAs?: 'h2' | 'h3' | 'h4' | 'p';
  className?: string;
}

/**
 * Nuera OS « En-tête de tuile » (57:130): 28 px pastille (accent-pale, radius 8, 16 px accent icon) +
 * title Outfit 600 14, gap 8, height 28 (36 when the action is a compact button).
 */
export function TileHeader({ icon, title, action, titleAs: Title = 'h2', className }: TileHeaderProps) {
  return (
    <div className={cn('flex min-h-7 w-full items-center gap-2', className)}>
      <Pastille icon={icon} size={28} />
      <Title className="min-w-0 flex-1 truncate font-sans text-app-14 font-semibold text-text">{title}</Title>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}
