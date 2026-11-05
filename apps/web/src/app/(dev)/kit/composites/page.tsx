import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CompositesGallery } from '@/components/dev/gallery/CompositesGallery';

export const metadata: Metadata = {
  title: 'Composants Nuera Dev',
  robots: { index: false, follow: false },
};

// Visibility is decided per request (environment + session), never at build time.
export const dynamic = 'force-dynamic';

/**
 * Reference time of the sample dates, read once per request on the server and handed to the client
 * gallery (stable hydration). Kept out of the component body for the React purity lint.
 */
function requestTime(): number {
  return Date.now();
}

/**
 * /kit/composites — gallery of the Nuera Dev composites (section 04 « CRÉÉS POUR NUERA DEV »).
 * Same rules as /kit: development only, and a signed-in owner unless NUERA_KIT_PUBLIC=1.
 * In production the route does not exist (404).
 */
export default async function CompositesKitPage() {
  if (process.env.NODE_ENV !== 'development') notFound();
  if (process.env.NUERA_KIT_PUBLIC !== '1') {
    const { requireUser } = await import('@/server/auth/session');
    await requireUser();
  }
  return <CompositesGallery now={requestTime()} />;
}
