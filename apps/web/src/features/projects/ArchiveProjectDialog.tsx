'use client';

import { useEffect, useState } from 'react';
import { plural } from '@nuera/shared/format';
import { ConfirmDialog, toast, type Consequence } from '@/components/ui';
import { failureOf, projectsApi } from './api';
import type { ArchivePreviewView } from '@/server/projects/types';
import { useServerName } from './hooks';

export interface ArchiveProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: { id: string; name: string } | null;
  onArchived?: () => void;
}

/** T8 « Archiver … ? »: what is kept (list « Archivés », GitHub repository) and what changes (sessions). */
export function ArchiveProjectDialog({ open, onOpenChange, project, onArchived }: ArchiveProjectDialogProps) {
  const serverName = useServerName();
  const [preview, setPreview] = useState<ArchivePreviewView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !project) return;
    // eslint-disable-next-line react/set-state-in-effect -- reset on opening, before the async load the effect starts
    setPreview(null);
    setError(null);
    let cancelled = false;
    projectsApi
      .archivePreview(project.id)
      .then((value) => !cancelled && setPreview(value))
      .catch((e: unknown) => !cancelled && setError(failureOf(e, 'Impossible de lire les sessions du projet.').message));
    return () => {
      cancelled = true;
    };
  }, [open, project]);

  if (!project) return null;
  const consequences: Consequence[] = [
    { kind: 'kept', text: 'Le projet quitte la liste ; il reste dans Archivés.' },
    { kind: 'kept', text: "Le dépôt GitHub n'est jamais touché." },
    { kind: 'kept', text: `Le clone reste sur ${serverName} : rien n'est supprimé du disque.` },
  ];
  if (preview && preview.endedSessions > 0) {
    consequences.push({
      kind: 'risk',
      text: `${plural(preview.endedSessions, 'session terminée', 'sessions terminées')} ${preview.endedSessions >= 2 ? 'seront archivées' : 'sera archivée'} avec lui.`,
    });
  }
  const blocked = preview && preview.liveSessions > 0;
  if (blocked) {
    consequences.push({
      kind: 'risk',
      text: `${plural(preview.liveSessions, 'session est active', 'sessions sont actives')} : arrêtez-${preview.liveSessions >= 2 ? 'les' : 'la'} avant d'archiver.`,
    });
  }
  const blockedReason = blocked ? "Archiver reste indisponible tant qu'une session du projet est active." : undefined;

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      tone="warn"
      icon="archive"
      title={`Archiver ${project.name} ?`}
      consequences={consequences}
      confirmLabel="Archiver"
      error={error ?? undefined}
      confirmDisabled={blockedReason}
      onConfirm={async () => {
        if (blocked) {
          setError("Arrêtez d'abord les sessions actives : le projet n'a pas été archivé.");
          throw new Error('sessions actives');
        }
        try {
          await projectsApi.archive(project.id);
        } catch (e) {
          const failure = failureOf(e, "Le projet n'a pas pu être archivé.");
          setError([failure.message, failure.untouched].filter(Boolean).join(' '));
          throw e;
        }
        onOpenChange(false);
        toast({ message: `${project.name} archivé`, action: { label: 'Voir les archives', href: '/projets?filtre=archives' } });
        onArchived?.();
      }}
    />
  );
}
