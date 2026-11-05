import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Desktop actions on the right (bell, Button Default / Accent, gap 12) — hidden on the phone. */
  actions?: ReactNode;
  /** Phone action on the right (one 44 px IconButton: bell on M01, « + » on M02/M06) — hidden on desktop. */
  mobileAction?: ReactNode;
  className?: string;
}

/**
 * Page header of the shell pages (`En-tête`): desktop title Outfit 600 28 + subtitle 14 muted (gap 4), actions
 * on the right; phone large header: title 26 + subtitle 13 (gap 2), one 44 px action. Scrolls with the page.
 */
export function PageHeader({ title, subtitle, actions, mobileAction, className }: PageHeaderProps) {
  return (
    <header className={cn('flex items-center gap-2 nav:gap-3', className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 nav:gap-1">
        <h1 className="m-0 font-sans text-app-26 font-semibold text-text nav:text-app-28">{title}</h1>
        {subtitle ? <p className="m-0 font-sans text-app-13 text-muted nav:text-app-14">{subtitle}</p> : null}
      </div>
      {actions ? <div className="hidden shrink-0 items-center gap-3 nav:flex">{actions}</div> : null}
      {mobileAction ? <div className="flex shrink-0 nav:hidden">{mobileAction}</div> : null}
    </header>
  );
}
