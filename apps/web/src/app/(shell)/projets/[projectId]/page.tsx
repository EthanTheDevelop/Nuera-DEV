import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { z } from 'zod';
import { ProjectDetailView } from '@/features/projects/detail/ProjectDetailView';
import { requireUser } from '@/server/auth/session';
import { AppError } from '@/server/errors';
import { getProjectDetail, markProjectOpened, requireProjectRow } from '@/server/projects';

type Params = Promise<{ projectId: string }>;

const idSchema = z.uuid();

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { projectId } = await params;
  if (!idSchema.safeParse(projectId).success) return { title: 'Projet' };
  try {
    const row = await requireProjectRow(projectId);
    return { title: row.name };
  } catch {
    return { title: 'Projet' };
  }
}

/** D04 / M04 — project page (?onglet=vue-d-ensemble|branches|environnement|claude-md|outils-mcp|variables|sessions). */
export default async function ProjectPage({ params }: { params: Params }) {
  await requireUser();
  const { projectId } = await params;
  if (!idSchema.safeParse(projectId).success) notFound();
  let detail;
  try {
    detail = await getProjectDetail(projectId);
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') notFound();
    throw error;
  }
  await markProjectOpened(projectId);
  return (
    <Suspense fallback={null}>
      <ProjectDetailView detail={detail} generatedAt={Date.now()} />
    </Suspense>
  );
}
