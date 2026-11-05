import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type CardVariant = 'tile' | 'card' | 'outline' | 'inset';
export type CardPadding = 'none' | 'sm' | 'md' | 'lg' | 'xl';

const variants: Record<CardVariant, string> = {
  /** Nuera OS tile: radius xl 28, Shadow/Soft — D01 tiles, `Dev · Carte de session`, T2/T5 cards. */
  tile: 'bg-bg rounded-xl shadow-soft',
  /** Card: radius lg 20, Shadow/Soft — phone cards and list cards, menus/panels on light. */
  card: 'bg-bg rounded-lg shadow-soft',
  /** Bordered card without shadow: radius lg 20, 1 px border (T4 « Commande échouée », info cards). */
  outline: 'bg-bg rounded-lg border border-border',
  /** Inset box: surface-raised, 1 px border, radius 12 (« Ce qui est sûr », « Dernière instruction »). */
  inset: 'bg-surface-raised rounded-md border border-border',
};

const paddings: Record<CardPadding, string> = {
  none: 'p-0',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-5',
  xl: 'p-6',
};

const defaultPadding: Record<CardVariant, CardPadding> = { tile: 'lg', card: 'md', outline: 'md', inset: 'sm' };

export interface CardProps extends HTMLAttributes<HTMLElement> {
  variant?: CardVariant;
  padding?: CardPadding;
  as?: 'div' | 'section' | 'article' | 'li' | 'aside';
  children?: ReactNode;
}

/** Surface container. Surfaces are separated by shadows and borders, never by tints (lacune 3). */
export function Card({ variant = 'tile', padding, as: Tag = 'div', className, children, ...rest }: CardProps) {
  return (
    <Tag
      className={cn('flex min-w-0 flex-col', variants[variant], paddings[padding ?? defaultPadding[variant]], className)}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/** Alias kept for readability where the Figma layer is a « Tuile ». */
export function Tile(props: Omit<CardProps, 'variant'>) {
  return <Card variant="tile" {...props} />;
}
