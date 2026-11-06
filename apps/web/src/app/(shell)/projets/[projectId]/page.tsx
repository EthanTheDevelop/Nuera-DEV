import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { z } from 'zod';
import { ProjectDetailView } from '@/features/projects/detail/ProjectDetailView';
import { AppError } from '@/server/errors';
import { findProject, getProjectDetail, markProjectOpened } from '@/server/projects';
import { getRequestContext, requireContext } from '@/server/tenancy/context';

type Params = Promise<{ projectId: string }>;

const idSchema = z.uuid();

/** Title of a project of the signed-in account's space; « Projet » for any other id (never another space's name). */
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { projectId } = await params;
  if (!idSchema.safeParse(projectId).success) return { title: 'Projet' };
  try {
    const ctx = await getRequestContext();
    const row = ctx ? await findProject(ctx, projectId) : null;
    return { title: row?.name ?? 'Projet' };
  } catch {
    return { title: 'Projet' };
  }
}

/**
 * D04 / M04 — project page (?onglet=vue-d-ensemble|branches|environnement|claude-md|outils-mcp|variables|sessions).
 * A project of another space renders the same 404 as an unknown id (nothing read on a runner,
 * nothing written).
 */
export default async function ProjectPage({ params }: { params: Params }) {
  const ctx = await requireContext();
  const { projectId } = await params;
  if (!idSchema.safeParse(projectId).success) notFound();
  let detail;
  try {
    detail = await getProjectDetail(ctx, projectId);
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') notFound();
    throw error;
  }
  await markProjectOpened(ctx, projectId);
  return (
    <Suspense fallback={null}>
      <ProjectDetailView detail={detail} generatedAt={Date.now()} />
    </Suspense>
  );
}
