import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { requireUser } from '@/server/auth/session';

export const metadata: Metadata = { title: 'Kit', robots: { index: false, follow: false } };

/**
 * Developer-only pages (component gallery /kit and /kit/composites).
 * - Never in production builds (404).
 * - Signed-in owner only, except with NUERA_KIT_PUBLIC=1 in `next dev` (visual checks / screenshots).
 */
export default async function DevLayout({ children }: { children: ReactNode }) {
  if (process.env.NODE_ENV === 'production') notFound();
  const kitPublic = process.env.NODE_ENV === 'development' && process.env.NUERA_KIT_PUBLIC === '1';
  if (!kitPublic) await requireUser();
  return <div className="min-h-dvh bg-surface-raised">{children}</div>;
}
