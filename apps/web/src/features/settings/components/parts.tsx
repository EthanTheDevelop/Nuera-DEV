'use client';

import type { ReactNode } from 'react';
import { Icon, type IconName } from '@/components/icons';
import { Badge, StatusDot, type BadgeTone } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { ServiceTone } from '../lib/copy';

/**
 * D08 « settings row »: row, gap 12, centred, py 10, 1 px bottom border except the last row; optional
 * 18 px leading icon (muted) or 8 px status dot; text column (Medium 14 + Regular 12/16 muted, gap 2);
 * trailing control.
 */
export function SettingsRow({
  icon,
  dot,
  title,
  caption,
  control,
  titleId,
  className,
  children,
}: {
  icon?: IconName;
  dot?: ServiceTone;
  title: ReactNode;
  caption?: ReactNode;
  control?: ReactNode;
  titleId?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <li className={cn('flex min-w-0 flex-col gap-2 border-b border-border py-3 last:border-b-0', className)}>
      <div className="flex min-w-0 items-center gap-3">
        {icon ? <Icon name={icon} size={18} className="shrink-0 text-muted" /> : null}
        {dot ? <StatusDot tone={dot === 'neutral' ? 'neutral' : dot} /> : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p id={titleId} className="m-0 font-sans text-app-14 font-medium text-text">
            {title}
          </p>
          {caption ? <div className="m-0 font-sans text-app-12 leading-4 text-muted">{caption}</div> : null}
        </div>
        {control ? <div className="flex shrink-0 items-center gap-2">{control}</div> : null}
      </div>
      {children}
    </li>
  );
}

export function SettingsRows({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <ul aria-label={label} className={cn('m-0 flex list-none flex-col p-0', className)}>
      {children}
    </ul>
  );
}

/** D08 info box (`Journal de sécurité`, `Disponibilité`): surface-raised, 1 px border, radius 12, px 14 py 12. */
export function InfoBox({ children, className, labelledBy }: { children: ReactNode; className?: string; labelledBy?: string }) {
  return (
    <section aria-labelledby={labelledBy} className={cn('flex flex-col gap-1.5 rounded-md border border-border bg-surface-raised px-3.5 py-3', className)}>
      {children}
    </section>
  );
}

/** Inline error under a control (save failed: the previous value is back). */
export function InlineError({ children, id }: { children: ReactNode; id?: string }) {
  if (!children) return null;
  return (
    <p id={id} role="alert" className="m-0 font-sans text-app-12 text-danger">
      {children}
    </p>
  );
}

/** Sober inline state when the runner did not answer (the shell shows T5 itself). */
export function UnavailableNote({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 flex items-start gap-2 font-sans text-app-13 leading-[18px] text-muted">
      <Icon name="wifi-off" size={16} className="mt-px shrink-0 text-danger" />
      <span>{children}</span>
    </p>
  );
}

/** « Aucun serveur ne vous est encore attribué. Un administrateur doit vous en attribuer un. » */
export const NO_SERVER_NOTE = 'Aucun serveur ne vous est encore attribué. Un administrateur doit vous en attribuer un.';

/** Inline state of a section that needs a server while none is assigned (never the T5 copy). */
export function NoServerNote({ children = NO_SERVER_NOTE }: { children?: ReactNode }) {
  return (
    <p className="m-0 flex items-start gap-2 font-sans text-app-13 leading-[18px] text-muted">
      <Icon name="server" size={16} className="mt-px shrink-0 text-accent" />
      <span>{children}</span>
    </p>
  );
}

/** « Réglé par un administrateur. » — caption of a setting this account may read but not change. */
export const ADMIN_SET_NOTE = 'Réglé par un administrateur.';

export function AdminSetNote({ id }: { id?: string }) {
  return (
    <p id={id} className="m-0 flex items-center gap-1.5 font-sans text-app-12 text-muted">
      <Icon name="lock" size={14} className="shrink-0" />
      <span>{ADMIN_SET_NOTE}</span>
    </p>
  );
}

/**
 * M08 settings group (`--bg`, radius lg, px 16, no shadow/border) and its rows: 52 px (60 with a
 * sublabel), gap 12, leading 20 px accent icon, label Outfit Regular 15, sublabel 12 muted, trailing
 * value 14 muted or Badge, chevron 16.
 */
export function MobileGroup({ label, children, footnote }: { label: string; children: ReactNode; footnote?: ReactNode }) {
  const id = `groupe-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="m-0 font-mono text-app-11 tracking-label text-muted uppercase">
        {label}
      </h2>
      <ul className="m-0 flex list-none flex-col rounded-lg bg-bg px-4 py-0">{children}</ul>
      {footnote ? <p className="m-0 font-sans text-app-12 text-muted">{footnote}</p> : null}
    </section>
  );
}

export function MobileRow({
  icon,
  iconTone = 'accent',
  label,
  labelTone = 'text',
  sublabel,
  value,
  badge,
  trailing,
  onClick,
  href,
  disabled,
  chevron = true,
  ariaLabel,
}: {
  icon: IconName;
  iconTone?: 'accent' | 'danger';
  label: string;
  labelTone?: 'text' | 'danger';
  sublabel?: ReactNode;
  value?: ReactNode;
  badge?: { tone: BadgeTone; label: string } | null;
  trailing?: ReactNode;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  chevron?: boolean;
  ariaLabel?: string;
}) {
  const body = (
    <>
      <Icon name={icon} size={20} className={cn('shrink-0', iconTone === 'danger' ? 'text-danger' : 'text-accent')} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className={cn('truncate font-sans text-app-15', labelTone === 'danger' ? 'text-danger' : 'text-text')}>{label}</span>
        {sublabel ? <span className="truncate font-sans text-app-12 text-muted">{sublabel}</span> : null}
      </span>
      {value !== undefined && value !== null ? <span className="shrink-0 truncate font-sans text-app-14 text-muted">{value}</span> : null}
      {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
      {trailing}
      {chevron ? <Icon name="chevron" size={16} className="shrink-0 text-muted" /> : null}
    </>
  );
  const rowClass = cn(
    'flex w-full items-center gap-3 border-b border-border py-2 outline-none',
    sublabel ? 'min-h-[60px]' : 'min-h-[52px]',
    'focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]',
  );
  return (
    <li className="[&:last-child>*]:border-b-0">
      {href ? (
        <a href={href} onClick={onClick ? (event) => { event.preventDefault(); onClick(); } : undefined} aria-label={ariaLabel} className={rowClass}>
          {body}
        </a>
      ) : onClick ? (
        <button type="button" onClick={onClick} disabled={disabled} aria-label={ariaLabel} className={cn(rowClass, 'cursor-pointer disabled:cursor-not-allowed disabled:opacity-60')}>
          {body}
        </button>
      ) : (
        <div className={rowClass}>{body}</div>
      )}
    </li>
  );
}
