'use client';

import { useEffect, useState } from 'react';
import { formatBytes, plural } from '@nuera/shared/format';
import { ConfirmDialog, toast, type Consequence } from '@/components/ui';
import { failureOf, projectsApi } from './api';
import type { ArchivePreviewView } from '@/server/projects/types';
import { useServerName } from './hooks';
import { cn } from '@/lib/cn';

export interface ArchiveProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: { id: string; name: string } | null;
  onArchived?: () => void;
  /** Server holding the project (default: the server of the space). */
  serverName?: string | null;
}

/** T8 « Archiver … ? »: what is kept (list « Archivés », GitHub repository) and what changes (sessions). */
export function ArchiveProjectDialog({ open, onOpenChange, project, onArchived, serverName: known }: ArchiveProjectDialogProps) {
  const serverName = useServerName(known);
  const [preview, setPreview] = useState<ArchivePreviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removeClone, setRemoveClone] = useState(false);

  useEffect(() => {
    if (!open || !project) return;
    // eslint-disable-next-line react/set-state-in-effect -- reset on opening, before the async load the effect starts
    setPreview(null);
    setError(null);
    setRemoveClone(false);
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
    removeClone
      ? { kind: 'risk', text: `Le clone et ses worktrees seront supprimés de ${serverName}, sauf si du travail n'existe que là.` }
      : { kind: 'kept', text: `Le clone reste sur ${serverName} : rien n'est supprimé du disque.` },
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
  // T8 option « Supprimer aussi le clone de VPS-3 (2,1 Go) » (size measured by the runner, else omitted).
  const cloneOnDisk = preview?.clone.onDisk ?? null;
  const cloneSize = preview?.clone.sizeBytes ?? null;
  const optionLabel = `Supprimer aussi le clone de ${serverName}${cloneSize !== null ? ` (${formatBytes(cloneSize)})` : ''}`;
  const optionReason =
    preview === null ? null : cloneOnDisk === null ? `${serverName} ne répond pas : le clone ne peut pas être supprimé maintenant.` : cloneOnDisk ? null : `Aucun clone de ce projet sur ${serverName}.`;

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
          const result = await projectsApi.archive(project.id, { removeClone: removeClone && cloneOnDisk === true });
          if (result.clone && !result.clone.removed) {
            // Archived, but the runner kept the clone (work only on the server, something running…).
            onOpenChange(false);
            toast({ message: `${project.name} archivé · clone conservé : ${result.clone.message}`, action: { label: 'Voir les archives', href: '/projets?filtre=archives' } });
            onArchived?.();
            return;
          }
          if (result.clone?.removed) {
            onOpenChange(false);
            toast({
              message: `${project.name} archivé · clone supprimé${result.clone.freedBytes ? ` (${formatBytes(result.clone.freedBytes)} libérés)` : ''}`,
              action: { label: 'Voir les archives', href: '/projets?filtre=archives' },
            });
            onArchived?.();
            return;
          }
        } catch (e) {
          const failure = failureOf(e, "Le projet n'a pas pu être archivé.");
          setError([failure.message, failure.untouched].filter(Boolean).join(' '));
          throw e;
        }
        onOpenChange(false);
        toast({ message: `${project.name} archivé`, action: { label: 'Voir les archives', href: '/projets?filtre=archives' } });
        onArchived?.();
      }}
    >
      <label
        className={cn(
          'flex min-h-11 items-center gap-2.5 rounded-md border border-border px-3 py-2.5 font-sans text-app-13',
          optionReason || preview === null ? 'cursor-not-allowed text-muted' : 'cursor-pointer text-text',
        )}
      >
        <input
          type="checkbox"
          className="size-[18px] shrink-0 accent-(--accent)"
          checked={removeClone && cloneOnDisk === true}
          disabled={preview === null || Boolean(optionReason)}
          onChange={(event) => setRemoveClone(event.target.checked)}
        />
        <span className="flex min-w-0 flex-col">
          <span>{optionLabel}</span>
          {optionReason ? <span className="text-app-12 text-muted">{optionReason}</span> : null}
        </span>
      </label>
    </ConfirmDialog>
  );
}
