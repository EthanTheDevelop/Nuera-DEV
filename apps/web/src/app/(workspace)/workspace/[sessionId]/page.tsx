import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { WorkspaceView } from '@/features/workspace';
import { requireUser } from '@/server/auth/session';
import { getWorkspaceData } from '@/server/workspace';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ sessionId: z.uuid() });

type PageProps = { params: Promise<{ sessionId: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) return { title: 'Session introuvable · Nuera Dev' };
  return { title: 'Workspace · Nuera Dev' };
}

/** A phone browser gets the M05 layout on the first paint (the client re-checks with the media query). */
function looksLikePhone(userAgent: string | null): boolean {
  return Boolean(userAgent && /Mobi|Android|iPhone|iPod/i.test(userAgent) && !/iPad|Tablet/i.test(userAgent));
}

/**
 * Workspace Claude Code — D05 / M05 and the states W1–W7, S1–S4. « Ouvert depuis un projet ou une
 * session, jamais depuis la navigation. » Unknown or archived sessions answer 404.
 */
export default async function WorkspacePage({ params }: PageProps) {
  const user = await requireUser();
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const data = await getWorkspaceData(parsed.data.sessionId, user);
  if (!data) notFound();
  const userAgent = (await headers()).get('user-agent');
  return <WorkspaceView data={data} initialDesktop={!looksLikePhone(userAgent)} />;
}
