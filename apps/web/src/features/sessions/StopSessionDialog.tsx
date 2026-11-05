'use client';

import { useState } from 'react';
import { ConfirmDialog, toast } from '@/components/ui';
import { stopSessionRequest, SessionApiError, type SessionActionResponse } from './api';

export interface StopSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: { id: string; title: string; worktree?: { name: string; isPrimary: boolean } | null };
  /** After the stop (default: success toast). */
  onStopped?: (result: SessionActionResponse) => void;
}

/** Worktree sentence of T8 (« Les fichiers modifiés et le worktree crm-core sont conservés. »). */
export function stopKeptText(worktree: StopSessionDialogProps['session']['worktree']): string {
  if (!worktree) return 'Les fichiers modifiés sont conservés.';
  if (worktree.isPrimary) return 'Les fichiers modifiés et le clone principal sont conservés.';
  return `Les fichiers modifiés et le worktree ${worktree.name} sont conservés.`;
}

/**
 * T8 « Arrêter « Module CRM · pipeline » ? » (236:5442): Claude Code receives Échap, then `/exit`,
 * then the runner stops the process. Used by Sessions, Accueil and the Workspace « … » menu.
 */
export function StopSessionDialog({ open, onOpenChange, session, onStopped }: StopSessionDialogProps) {
  const [error, setError] = useState<string | null>(null);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
      tone="warn"
      icon="stop"
      title={`Arrêter « ${session.title} » ?`}
      consequences={[
        { kind: 'risk', text: "Claude Code reçoit Échap puis s'arrête, même au milieu d'une étape." },
        { kind: 'kept', text: stopKeptText(session.worktree ?? null) },
        { kind: 'kept', text: 'La conversation reste reprenable depuis Sessions.' },
      ]}
      confirmLabel="Arrêter la session"
      error={error}
      onConfirm={async () => {
        setError(null);
        try {
          const result = await stopSessionRequest(session.id);
          onOpenChange(false);
          if (onStopped) onStopped(result);
          else toast({ message: `Session arrêtée : ${session.title}`, icon: 'stop' });
        } catch (failure) {
          setError(failure instanceof SessionApiError || failure instanceof Error ? failure.message : "La session n'a pas pu être arrêtée.");
          throw failure;
        }
      }}
    />
  );
}
