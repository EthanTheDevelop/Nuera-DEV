'use client';

import { CompactButton, Field, Input, toast } from '@/components/ui';
import { Dialog, DialogContent } from '@/components/ui';
import { ResumeContextDialog, StopSessionDialog, needsContextChoice, renameSessionRequest, resumeSessionRequest, SessionApiError } from '@/features/sessions';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useWorkspace } from '../WorkspaceContext';
import { isLiveStatus } from '../lib/contract';

/**
 * Session actions shared by the desktop « … » menu and the phone « Actions de session » sheet:
 * rename (SESSIONS lot PATCH), resume (SESSIONS lot resume route — « Reprendre avec le contexte »
 * asked first when the conversation is gone), stop (T8, SESSIONS lot).
 */
export function useSessionMenu() {
  const ws = useWorkspace();
  const router = useRouter();
  const { session } = ws.ctl.state;
  const [stopOpen, setStopOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const live = isLiveStatus(session.status);
  const canResume = !live && session.status !== 'new' && session.resumable && !ws.reconnecting;
  const canStop = live && !ws.reconnecting;
  /** « Reprendre la conversation » or « Reprendre avec un nouveau contexte » (what the runner said it will do). */
  const resumeLabel = session.resumeMode === 'context' ? 'Reprendre avec un nouveau contexte' : 'Reprendre la session';

  const fail = (error: unknown) =>
    ws.setActionError({
      title: "La session n'a pas pu être reprise",
      message: (error as Error).message,
      ...(error instanceof SessionApiError && error.untouched ? { untouched: error.untouched } : {}),
      ...(error instanceof SessionApiError && error.raw ? { raw: error.raw } : {}),
    });

  const resume = async () => {
    if (session.resumeMode === 'context') {
      setContextError(null);
      setContextOpen(true);
      return;
    }
    setResuming(true);
    try {
      await resumeSessionRequest(session.id);
      toast({ message: 'Session reprise : Claude Code rouvre la conversation dans son worktree.' });
      router.refresh();
    } catch (error) {
      if (needsContextChoice(error)) {
        setContextError(null);
        setContextOpen(true);
      } else fail(error);
    } finally {
      setResuming(false);
    }
  };

  const resumeWithChoice = async (withContext: boolean) => {
    setContextError(null);
    try {
      await resumeSessionRequest(session.id, { context: withContext });
      setContextOpen(false);
      toast({
        message: withContext
          ? 'Session reprise avec un nouveau contexte : le résumé de l\'historique est envoyé à Claude.'
          : 'Session reprise avec un nouveau contexte, sans résumé.',
      });
      router.refresh();
    } catch (error) {
      setContextError((error as Error).message);
      throw error;
    }
  };

  const dialogs = (
    <>
      <StopSessionDialog
        open={stopOpen}
        onOpenChange={setStopOpen}
        session={{
          id: session.id,
          title: session.title,
          worktree: ws.data.worktree ? { name: ws.data.worktree.name, isPrimary: ws.data.worktree.isPrimary } : null,
        }}
        onStopped={() => {
          setStopOpen(false);
          toast({ message: `Session « ${session.title} » arrêtée : le worktree et la conversation sont conservés.` });
          router.refresh();
        }}
      />
      <RenameDialog open={renameOpen} onOpenChange={setRenameOpen} />
      <ResumeContextDialog
        target={contextOpen ? { title: session.title } : null}
        error={contextError}
        onClose={() => setContextOpen(false)}
        onConfirm={resumeWithChoice}
      />
    </>
  );

  return { canResume, canStop, resuming, resume, resumeLabel, openStop: () => setStopOpen(true), openRename: () => setRenameOpen(true), dialogs };
}

/** Rename (not designed): one field, same language as the other dialogs. */
export function RenameDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const ws = useWorkspace();
  const router = useRouter();
  const [value, setValue] = useState(ws.ctl.state.session.title);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const title = value.trim();
    if (!title) {
      setError('Titre requis.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await renameSessionRequest(ws.ctl.state.session.id, title);
      ws.ctl.dispatch({ type: 'session', patch: { title } });
      onOpenChange(false);
      toast({ message: `Session renommée : « ${title} ».` });
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setValue(ws.ctl.state.session.title);
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent
        title="Renommer la session"
        description="Le nouveau titre s'affiche partout dans Nuera Dev ; le CLI le reprend à son prochain lancement."
        size="sm"
        footer={
          <>
            <CompactButton variant="secondaire" onClick={() => onOpenChange(false)}>
              Annuler
            </CompactButton>
            <CompactButton variant="principal" type="submit" form="renommer-session" loading={saving}>
              Renommer
            </CompactButton>
          </>
        }
      >
        <form id="renommer-session" onSubmit={submit}>
          <Field label="Titre de la session" error={error}>
            <Input value={value} onChange={(e) => setValue(e.target.value)} maxLength={200} autoFocus />
          </Field>
        </form>
      </DialogContent>
    </Dialog>
  );
}
