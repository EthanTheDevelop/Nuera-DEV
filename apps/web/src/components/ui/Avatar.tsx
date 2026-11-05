import { initials as toInitials } from '@nuera/shared/format';
import { cn } from '@/lib/cn';

export type AvatarSize = 24 | 28 | 32 | 36 | 40;

const sizes: Record<AvatarSize, string> = {
  24: 'size-6 text-app-10',
  28: 'size-7 text-app-11',
  32: 'size-8 text-app-12',
  36: 'size-9 text-app-13',
  40: 'size-10 text-app-14',
};

export interface AvatarProps {
  /** Person name; initials are computed with @nuera/shared/format (« Nezar » → « NZ »). */
  name: string;
  /** 36 = sidebar card / rail (default); 24–40 are the sizes used in Nuera OS. */
  size?: AvatarSize;
  /** Expose the name to assistive tech (default: decorative, the name is printed next to it). */
  labelled?: boolean;
  className?: string;
}

/** Nuera OS `Avatar` (57:125): circle, accent-pale fill, initials Outfit 600 in ink. No photos in the app. */
export function Avatar({ name, size = 36, labelled = false, className }: AvatarProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-accent-pale font-sans font-semibold text-on-pale select-none',
        sizes[size],
        className,
      )}
      {...(labelled ? { role: 'img', 'aria-label': name } : { 'aria-hidden': true })}
    >
      {toInitials(name)}
    </span>
  );
}
