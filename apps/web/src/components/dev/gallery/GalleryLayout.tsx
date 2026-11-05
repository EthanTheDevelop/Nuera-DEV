/**
 * DEV-ONLY layout helpers of the /kit/composites gallery (labelled specimens, phone frame).
 * Not exported from ../index.ts.
 */
import type { ReactNode } from 'react';
import { SectionLabel } from '@/components/ui';
import { cn } from '@/lib/cn';

export function GallerySection({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex scroll-mt-6 flex-col gap-6">
      <div className="flex flex-col gap-1 border-b border-border pb-3">
        <SectionLabel as="h2" id={`${id}-title`} tone="text">
          {title}
        </SectionLabel>
        {note ? <p className="m-0 font-sans text-app-13 text-muted">{note}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** One labelled specimen: `Composant · Variante` above the rendered component. */
export function Specimen({
  label,
  figma,
  children,
  className,
  surface = 'plain',
}: {
  label: string;
  /** Figma node / frame the specimen reproduces. */
  figma?: string;
  children: ReactNode;
  className?: string;
  /** `plain` = page background · `tile` = white tile on the raised page (lists drawn inside tiles). */
  surface?: 'plain' | 'tile';
}) {
  return (
    <figure className={cn('m-0 flex min-w-0 flex-col gap-2', className)}>
      <figcaption className="flex flex-wrap items-baseline gap-x-2 font-mono text-app-11 tracking-label text-muted">
        <span>{label}</span>
        {figma ? <span className="text-accent">{figma}</span> : null}
      </figcaption>
      {surface === 'tile' ? (
        <div className="overflow-x-auto rounded-xl bg-bg shadow-soft">
          <div className="flex min-w-[1040px] flex-col px-5 py-2">{children}</div>
        </div>
      ) : (
        children
      )}
    </figure>
  );
}

/** 390 px phone column (no OS chrome): what S1–S5 / M01–M08 draw inside the status bar and home indicator. */
export function PhoneFrame({ children, className, label }: { children: ReactNode; className?: string; label: string }) {
  return (
    <div
      aria-label={label}
      role="group"
      className={cn('flex w-[390px] max-w-full shrink-0 flex-col overflow-hidden rounded-[28px] border border-border bg-surface-raised', className)}
    >
      {children}
    </div>
  );
}

export function Grid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid min-w-0 gap-6', className)}>{children}</div>;
}
