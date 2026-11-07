'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  Button,
  CompactButton,
  ConfirmDialog,
  Dialog,
  DialogContent,
  ErrorPanel,
  Field,
  Input,
  toast,
} from '@/components/ui';
import { archiveSessionRequest, needsContextChoice, renameSessionRequest, resumeSessionRequest, SessionApiError } from './api';
import { DEFAULT_SESSION_TITLE, SESSION_TITLE_MAX, workspaceUrl, type ResumeBlockedReason, type ResumeMode } from './lib/contract';
import { ResumeContextDialog } from './ResumeContextDialog';
import { StopSessionDialog } from './StopSessionDialog';

/** What the actions need to know about a session (a `SessionListItem` fits). */
export interface SessionActionTarget {
  id: string;
  title: string;
  worktree?: { name: string; isPrimary: boolean } | null;
  project?: { name: string } | null;
  resumeBlockedReason?: ResumeBlockedReason | null;
  /** What « Reprendre » will do (`context`: the dialog « Reprendre avec le contexte » asks first). */
  resumeMode?: ResumeMode | null;
}

type Kind = 'resume' | 'archive' | 'rename' | 'stop';

interface ActionFailure {
  kind: Kind;
  target: SessionActionTarget;
  message: string;
  detail?: string;
  untouched?: string;
  raw?: string;
}

export interface SessionActions {
  /**
   * « Reprendre »: the conversation is reopened (`claude --resume`), or — when it is gone — the dialog
   * « Reprendre avec le contexte » asks first; then the Workspace opens.
   */
  resume: (target: SessionActionTarget) => Promise<void>;
  /** T8 confirmation, then « Arrêter la session ». */
  requestStop: (target: SessionActionTarget) => void;
  /** Confirmation, then archive. */
  requestArchive: (target: SessionActionTarget) => void;
  /** Small dialog with the title field. */
  requestRename: (target: SessionActionTarget) => void;
  /** « Pourquoi ? » of « Reprise impossible ». */
  explainResume: (target: SessionActionTarget) => void;
  /** Id of the session whose action is running (buttons show a spinner). */
  pending: { id: string; kind: Kind } | null;
  /** Render once: the confirmation / rename / explanation dialogs. */
  dialogs: ReactNode;
  /** T4 panel of the last failed action (null when none), with retry. */
  errorPanel: ReactNode;
}

const UNTOUCHED: Record<Kind, string> = {
  resume: "La conversation et le worktree n'ont pas été modifiés.",
  archive: 'Session non archivée.',
  rename: 'Titre inchangé.',
  stop: "Rien n'a été arrêté.",
};
const FAILED_TITLE: Record<Kind, (title: string) => string> = {
  resume: (t) => `La reprise de « ${t} » a échoué`,
  archive: (t) => `L'archivage de « ${t} » a échoué`,
  rename: (t) => `« ${t} » n'a pas pu être renommée`,
  stop: (t) => `« ${t} » n'a pas pu être arrêtée`,
};

/**
 * Text of « Pourquoi ? ». Only an archived session or project blocks a resumption: a removed
 * worktree is recreated from its branch, a lost conversation restarts with a new context.
 */
export function resumeBlockedText(target: SessionActionTarget): string {
  switch (target.resumeBlockedReason) {
    case 'project_archived':
      return `Le projet ${target.project?.name ?? ''} est archivé : ses sessions ne peuvent plus être reprises. L'historique reste lisible.`.replace('  ', ' ');
    default:
      return "Cette session est archivée : elle ne peut plus être reprise. L'historique reste lisible.";
  }
}

function toFailure(kind: Kind, target: SessionActionTarget, error: unknown): ActionFailure {
  if (error instanceof SessionApiError) {
    return {
      kind,
      target,
      message: error.message,
      ...(error.detail ? { detail: error.detail } : {}),
      ...(error.untouched ? { untouched: error.untouched } : {}),
      ...(error.raw ? { raw: error.raw } : {}),
    };
  }
  return { kind, target, message: error instanceof Error && error.message ? error.message : "L'action n'a pas abouti." };
}

/**
 * Session row / card actions shared by Sessions (D06/M06), Accueil and the Workspace: each one goes
 * through the API routes of the sessions lot, then refreshes the server data (`router.refresh()`).
 */
export function useSessionActions(options: { onChanged?: () => void } = {}): SessionActions {
  const router = useRouter();
  const { onChanged } = options;
  const [pending, setPending] = useState<SessionActions['pending']>(null);
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  const [stopTarget, setStopTarget] = useState<SessionActionTarget | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<SessionActionTarget | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<SessionActionTarget | null>(null);
  const [whyTarget, setWhyTarget] = useState<SessionActionTarget | null>(null);
  const [contextTarget, setContextTarget] = useState<SessionActionTarget | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  // The T4 panel is rendered near the list, sometimes above the row that failed (phone sheet, long
  // history): bring it into view when it appears.
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (failure) panelRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [failure]);

  const changed = useCallback(() => {
    if (onChanged) onChanged();
    else router.refresh();
  }, [onChanged, router]);

  const resume = useCallback(
    async (target: SessionActionTarget) => {
      setFailure(null);
      if (target.resumeMode === 'context') {
        setContextError(null);
        setContextTarget(target);
        return;
      }
      setPending({ id: target.id, kind: 'resume' });
      try {
        const result = await resumeSessionRequest(target.id);
        router.push(result.workspaceUrl);
      } catch (error) {
        setPending(null);
        // The conversation turned out to be gone: the owner chooses « Reprendre avec le contexte ».
        if (needsContextChoice(error)) {
          setContextError(null);
          setContextTarget(target);
          return;
        }
        setFailure(toFailure('resume', target, error));
      }
    },
    [router],
  );

  const resumeWithChoice = async (target: SessionActionTarget, withContext: boolean) => {
    setContextError(null);
    try {
      const result = await resumeSessionRequest(target.id, { context: withContext });
      setContextTarget(null);
      toast({ message: `Session reprise avec un nouveau contexte : ${target.title}`, icon: 'play' });
      router.push(result.workspaceUrl);
    } catch (error) {
      setContextError(error instanceof Error && error.message ? error.message : "La session n'a pas pu être reprise.");
      throw error;
    }
  };

  const archive = async (target: SessionActionTarget) => {
    setArchiveError(null);
    try {
      await archiveSessionRequest(target.id);
      setArchiveTarget(null);
      toast({ message: `Session archivée : ${target.title}`, icon: 'archive' });
      changed();
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : "La session n'a pas pu être archivée.");
      throw error;
    }
  };

  const retry = () => {
    if (!failure) return;
    const { kind, target } = failure;
    setFailure(null);
    if (kind === 'resume') void resume(target);
    else if (kind === 'stop') setStopTarget(target);
    else if (kind === 'archive') setArchiveTarget(target);
    else setRenameTarget(target);
  };

  const dialogs = (
    <>
      <ResumeContextDialog
        target={contextTarget}
        error={contextError}
        onClose={() => {
          setContextTarget(null);
          setContextError(null);
        }}
        onConfirm={(withContext) => (contextTarget ? resumeWithChoice(contextTarget, withContext) : Promise.resolve())}
      />
      {stopTarget ? (
        <StopSessionDialog
          open
          onOpenChange={(open) => !open && setStopTarget(null)}
          session={stopTarget}
          onStopped={() => {
            toast({ message: `Session arrêtée : ${stopTarget.title}`, icon: 'stop' });
            changed();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={archiveTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setArchiveTarget(null);
            setArchiveError(null);
          }
        }}
        tone="warn"
        icon="archive"
        title={`Archiver « ${archiveTarget?.title ?? ''} » ?`}
        consequences={[
          {
            kind: 'kept',
            text: archiveTarget?.worktree?.name
              ? `Le worktree ${archiveTarget.worktree.name} et ses fichiers ne sont pas touchés.`
              : 'Aucun fichier ni worktree ne sont touchés.',
          },
          { kind: 'kept', text: "L'historique reste lisible dans Sessions, filtre « Archivées »." },
          { kind: 'risk', text: 'La session ne pourra plus être reprise.' },
        ]}
        confirmLabel="Archiver"
        error={archiveError}
        onConfirm={() => (archiveTarget ? archive(archiveTarget) : undefined)}
      />
      {renameTarget ? (
        <RenameDialog
          target={renameTarget}
          onClose={() => setRenameTarget(null)}
          onRenamed={(title) => {
            setRenameTarget(null);
            toast({ message: `Session renommée : ${title}`, icon: 'edit' });
            changed();
          }}
        />
      ) : null}
      <Dialog open={whyTarget !== null} onOpenChange={(open) => !open && setWhyTarget(null)}>
        {whyTarget ? (
          <DialogContent
            size="sm"
            title="Reprise impossible"
            description={whyTarget.title}
            footer={
              <>
                <Button onClick={() => setWhyTarget(null)}>Fermer</Button>
                <Button variant="accent" href={workspaceUrl(whyTarget.id)}>
                  Voir l'historique
                </Button>
              </>
            }
          >
            <p className="m-0 font-sans text-app-14 leading-5 text-text">{resumeBlockedText(whyTarget)}</p>
            <p className="m-0 font-sans text-app-13 leading-[18px] text-muted">
              Sinon, Reprendre rouvre la conversation enregistrée par Claude Code (claude --resume) dans son worktree, recréé depuis sa branche s'il a été supprimé.
            </p>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );

  const errorPanel = failure ? (
    <div ref={panelRef} className="min-w-0 scroll-mt-4">
      <ErrorPanel
        title={FAILED_TITLE[failure.kind](failure.target.title)}
        excerpt={failure.detail ? `${failure.message} ${failure.detail}` : failure.message}
        untouched={failure.untouched ?? UNTOUCHED[failure.kind]}
        raw={failure.raw ?? null}
        onRetry={retry}
        retryLabel="Réessayer"
        actions={
          <CompactButton variant="discret" onClick={() => setFailure(null)}>
            Masquer
          </CompactButton>
        }
      />
    </div>
  ) : null;

  return {
    resume,
    requestStop: (target) => {
      setFailure(null);
      setStopTarget(target);
    },
    requestArchive: (target) => {
      setFailure(null);
      setArchiveTarget(target);
    },
    requestRename: (target) => {
      setFailure(null);
      setRenameTarget(target);
    },
    explainResume: (target) => setWhyTarget(target),
    pending,
    dialogs,
    errorPanel,
  };
}

function RenameDialog({ target, onClose, onRenamed }: { target: SessionActionTarget; onClose: () => void; onRenamed: (title: string) => void }) {
  const [title, setTitle] = useState(target.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = title.trim();
  const invalid = trimmed.length === 0 ? 'Titre requis.' : trimmed.length > SESSION_TITLE_MAX ? `${SESSION_TITLE_MAX} caractères au maximum.` : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (invalid || busy) {
      if (invalid) setError(invalid);
      return;
    }
    if (trimmed === target.title) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await renameSessionRequest(target.id, trimmed);
      onRenamed(trimmed);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "La session n'a pas pu être renommée.");
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent size="sm" title="Renommer la session" dismissible={!busy}>
        <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-5">
          <Field label="Titre" error={error ?? undefined} hint="Le CLI garde son nom (--name) jusqu'à la prochaine reprise.">
            <Input value={title} autoFocus maxLength={SESSION_TITLE_MAX} placeholder={DEFAULT_SESSION_TITLE} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <Button type="button" onClick={onClose} disabled={busy}>
              Annuler
            </Button>
            <Button type="submit" variant="accent" loading={busy} loadingLabel="Enregistrement…">
              Renommer
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
