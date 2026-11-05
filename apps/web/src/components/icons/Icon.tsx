import type { SVGProps } from 'react';
import { cn } from '@/lib/cn';
import { ICON_PATHS, type IconName } from './icon-paths';

/** Sizes used on the Figma instances (24 = master). Any number works; these are the designed ones. */
export type IconSize = 12 | 13 | 14 | 15 | 16 | 18 | 20 | 24 | 26 | 28;

/** Stroke width of every Nuera icon, in screen pixels, whatever the rendered size (Figma keeps it absolute). */
export const ICON_STROKE_PX = 1.8;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'children' | 'stroke' | 'fill'> {
  /** Figma name without the `icon/` prefix (`terminal`, `git-branch`, `worktree`, `projets`, `reglages`…). */
  name: IconName;
  /** Rendered size in px (square). Default 16 (lines and buttons). */
  size?: IconSize | number;
  /**
   * Accessible label. Without it the icon is decorative (`aria-hidden`) — the default, since every
   * Nuera icon sits next to a text label or inside a control that carries an `aria-label`.
   */
  title?: string;
}

/**
 * Nuera icon set (24 px grid, 1.8 px round stroke, `currentColor`).
 * Colour comes from the context: set `className="text-accent"`, `text-muted`, `text-success`…
 * The stroke stays 1.8 px on screen at every size, exactly like the Figma instances.
 */
export function Icon({ name, size = 16, title, className, strokeWidth, ...rest }: IconProps) {
  const paths = ICON_PATHS[name];
  const sw = strokeWidth ?? (ICON_STROKE_PX * 24) / size;
  const labelled = Boolean(title);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      data-icon={name}
      className={cn('inline-block shrink-0', className)}
      {...(labelled ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
      {...rest}
    >
      {labelled ? <title>{title}</title> : null}
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
