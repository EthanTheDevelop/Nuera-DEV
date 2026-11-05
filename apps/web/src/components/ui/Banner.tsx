import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/icons';

export type BannerTone = 'info' | 'success' | 'warn' | 'danger';

const tones: Record<BannerTone, { box: string; icon: string; glyph: IconName }> = {
  info: { box: 'bg-accent-pale', icon: 'text-accent', glyph: 'alert' },
  success: { box: 'bg-success-pale', icon: 'text-success', glyph: 'check' },
  warn: { box: 'bg-warn-pale', icon: 'text-warn', glyph: 'alert' },
  danger: { box: 'bg-danger-pale', icon: 'text-danger', glyph: 'alert' },
};

export interface BannerProps {
  tone?: BannerTone;
  title: ReactNode;
  /** Second line (Outfit 13 muted). */
  children?: ReactNode;
  /**
   * Icon override: the Info variant keeps the alert triangle as designed; W7 uses `wifi-off`,
   * T7 « Accès GitHub révoqué » uses the service icon (`github`).
   */
  icon?: IconName;
  /** Trailing actions (usually one CompactButton « Secondaire »: Ouvrir, Renouveler, Réessayer…). */
  action?: ReactNode;
  /** `py 14` rows (D07 « Diagnostic Coolify », T7 « Accès GitHub révoqué »). */
  dense?: false | 'relaxed';
  /** Announce politely as it updates (sync progress, reconnection countdown). */
  live?: boolean;
  className?: string;
  id?: string;
}

/**
 * `Dev · Bandeau` (203:703) — « Message d'état dans une page : chargement, succès, alerte, erreur récupérable
 * avec son action. » Row, padding 12 × 16, radius 12, gap 12, icon 18, title Outfit 600 14 + message 13 muted.
 * T3: « Le bandeau reste dans la page tant qu'il y a une suite à donner » → not auto-dismissed.
 * role="status" for Info/Succès, role="alert" for Alerte/Erreur.
 */
export function Banner({ tone = 'info', title, children, icon, action, dense = false, live, className, id }: BannerProps) {
  const spec = tones[tone];
  const urgent = tone === 'warn' || tone === 'danger';
  return (
    <div
      id={id}
      role={urgent ? 'alert' : 'status'}
      aria-live={live ? 'polite' : undefined}
      className={cn(
        'flex w-full min-w-0 flex-wrap items-center gap-3 rounded-md px-4 nav:flex-nowrap',
        dense === 'relaxed' ? 'py-3.5' : 'py-3',
        spec.box,
        className,
      )}
    >
      <Icon name={icon ?? spec.glyph} size={18} className={cn('self-start nav:self-center', spec.icon)} />
      {/* Phone: the text takes the whole line beside the icon (100 % − icon 18 − gap 12), so the actions wrap
          under it instead of squeezing it to zero width; break-words for long paths or branches. */}
      <div className="flex min-w-0 flex-1 basis-[calc(100%-30px)] flex-col gap-0.5 break-words nav:basis-0">
        <p className="m-0 font-sans text-app-14 font-semibold text-text">{title}</p>
        {children ? <div className="font-sans text-app-13 text-muted">{children}</div> : null}
      </div>
      {action ? <div className="ml-[30px] flex shrink-0 flex-wrap items-center gap-2 nav:ml-0">{action}</div> : null}
    </div>
  );
}
