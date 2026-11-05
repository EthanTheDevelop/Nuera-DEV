import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge must know the project's custom font-size utilities (text-app-28 … text-app-10, text-ui,
 * text-script): otherwise `text-app-14 text-muted` would be seen as two conflicting `text-*` colour
 * classes and the size would be dropped.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        { 'text-app': ['28', '26', '22', '20', '18', '16', '15', '14', '13', '12', '11', '10'] },
        'text-ui',
        'text-script',
      ],
      tracking: ['tracking-hero', 'tracking-display', 'tracking-title', 'tracking-script', 'tracking-eyebrow', 'tracking-label'],
      leading: ['leading-display', 'leading-subtitle', 'leading-body'],
      shadow: ['shadow-soft', 'shadow-float'],
    },
  },
});

/** Merge class names (clsx syntax) and resolve Tailwind conflicts, last one wins. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
