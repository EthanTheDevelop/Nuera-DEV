'use client';

import { useId, useState } from 'react';
import { Checkbox, ConfirmDialog } from '@/components/ui';

export interface ResumeContextDialogProps {
  /** The session to resume (null: closed). */
  target: { title: string } | null;
  onClose: () => void;
  /** The owner's choice: a summary of the stored history as the first instruction, or not. */
  onConfirm: (withContext: boolean) => Promise<void>;
  error?: string | null;
}

/**
 * « Reprendre avec le contexte » (not designed: same language as the T8 confirmations). Shown when
 * the conversation recorded by Claude Code cannot be reopened: the session restarts in the same
 * thread with a fresh CLI, and — when the box stays checked — a compact summary of what Nuera Dev
 * stored (instructions, Claude's last messages, files changed, last commit) as its first instruction.
 */
export function ResumeContextDialog({ target, onClose, onConfirm, error }: ResumeContextDialogProps) {
  const id = useId();
  const [withContext, setWithContext] = useState(true);
  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
          setWithContext(true);
        }
      }}
      tone="warn"
      icon="play"
      title={`Reprendre « ${target?.title ?? ''} » avec un nouveau contexte ?`}
      consequences={[
        { kind: 'risk', text: "La conversation enregistrée par Claude Code est introuvable sur le serveur : Claude Code repart d'une nouvelle conversation." },
        { kind: 'kept', text: "La session, son historique et son worktree sont conservés (recréé depuis sa branche s'il a été supprimé)." },
      ]}
      confirmLabel="Reprendre la session"
      error={error ?? null}
      onConfirm={async () => {
        await onConfirm(withContext);
        setWithContext(true);
      }}
    >
      <div className="flex min-h-11 items-start gap-3">
        <Checkbox id={`${id}-contexte`} checked={withContext} onCheckedChange={setWithContext} className="mt-0.5" />
        <label htmlFor={`${id}-contexte`} className="flex cursor-pointer flex-col gap-0.5 font-sans">
          <span className="text-app-14 text-text">Reprendre avec le contexte</span>
          <span className="text-app-13 leading-[18px] text-muted">
            Envoie d'abord un résumé de l'historique : dernières instructions, derniers messages de Claude, fichiers modifiés, dernier commit.
          </span>
        </label>
      </div>
    </ConfirmDialog>
  );
}
