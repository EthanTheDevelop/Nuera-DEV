'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '@/components/icons';
import { Button, CompactButton, Dialog, DialogContent, ErrorPanel, Sheet, SheetContent, Spinner } from '@/components/ui';
import { useIsDesktopNav } from '@/hooks/useMediaQuery';
import { cn } from '@/lib/cn';
import { TerminalApiError, closeTerminalRequest } from './api';
import { TerminalView } from './TerminalView';

export interface TerminalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Window title (Outfit 600 22 desktop, 18 phone). */
  title: string;
  /** Sub-line: what runs and what to do (sober French). */
  description?: ReactNode;
  /**
   * Opens the terminal when the window opens (POST /api/terminals, or the MCP login route) and
   * returns its id. Called once per opening; the terminal is closed (DELETE) with the window.
   */
  create: () => Promise<{ terminalId: string }>;
  /** Shown above the terminal with the shield icon (login terminals: nothing here is recorded). */
  privacyNote?: ReactNode;
  /** The process exited (login done, /exit…): refresh what depends on it (e.g. Claude status). */
  onExit?: (code: number | null) => void;
  /** Accessible name of the terminal (default: the title). */
  label?: string;
}

type Phase =
  | { kind: 'creating' }
  | { kind: 'ready'; terminalId: string }
  | { kind: 'failed'; message: string; untouched?: string; raw?: string };

function describeFailure(error: unknown): Extract<Phase, { kind: 'failed' }> {
  if (error instanceof TerminalApiError) {
    return { kind: 'failed', message: error.message, ...(error.untouched ? { untouched: error.untouched } : {}), ...(error.raw ? { raw: error.raw } : {}) };
  }
  return { kind: 'failed', message: error instanceof Error && error.message ? error.message : "Le terminal n'a pas pu s'ouvrir." };
}

function releaseTerminal(terminalId: string) {
  void closeTerminalRequest(terminalId, { keepalive: true }).catch(() => undefined);
}

/**
 * Mounted while the window is open (Radix unmounts the content when it closes): opens the terminal
 * on mount, closes it on unmount and when the page goes away.
 */
function TerminalSession({
  create,
  privacyNote,
  onExit,
  label,
  layout,
}: Pick<TerminalDialogProps, 'create' | 'privacyNote' | 'onExit'> & { label: string; layout: 'dialog' | 'sheet' }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'creating' });
  const [attempt, setAttempt] = useState(0);
  const createRef = useRef(create);

  useEffect(() => {
    createRef.current = create;
  }, [create]);

  useEffect(() => {
    let cancelled = false;
    let terminalId: string | null = null;
    // Deferred one tick: React's development double-mount then opens a single terminal.
    const timer = setTimeout(() => {
      createRef.current().then(
        (result) => {
          if (cancelled) {
            releaseTerminal(result.terminalId);
            return;
          }
          terminalId = result.terminalId;
          setPhase({ kind: 'ready', terminalId: result.terminalId });
        },
        (error: unknown) => {
          if (!cancelled) setPhase(describeFailure(error));
        },
      );
    }, 0);
    const onPageHide = () => {
      if (terminalId) releaseTerminal(terminalId);
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener('pagehide', onPageHide);
      if (terminalId) releaseTerminal(terminalId);
    };
  }, [attempt]);

  const retry = () => {
    setPhase({ kind: 'creating' });
    setAttempt((value) => value + 1);
  };

  const height = layout === 'dialog' ? 'h-[min(30rem,calc(100dvh-20rem))] min-h-60' : 'min-h-0 flex-1';

  return (
    <div className={cn('flex min-h-0 flex-col gap-3', layout === 'sheet' && 'h-full')}>
      {privacyNote ? (
        <p className="m-0 flex items-start gap-2 rounded-md border border-border bg-surface-raised px-3 py-2.5 font-sans text-app-12 leading-4 text-muted">
          <Icon name="shield" size={16} className="shrink-0 text-accent" />
          <span>{privacyNote}</span>
        </p>
      ) : null}
      {phase.kind === 'ready' ? (
        <TerminalView terminalId={phase.terminalId} label={label} autoFocus onExit={onExit} className={height} />
      ) : phase.kind === 'creating' ? (
        <div
          data-tone="dark"
          role="status"
          className={cn('flex items-center justify-center gap-2 rounded-md bg-bg font-mono text-app-12 text-muted', height)}
        >
          <Spinner size={14} />
          Ouverture du terminal…
        </div>
      ) : (
        <ErrorPanel
          title="Le terminal n'a pas pu s'ouvrir."
          excerpt={phase.message}
          untouched={phase.untouched ?? "Rien n'a été modifié sur le serveur."}
          raw={phase.raw ?? null}
          onRetry={retry}
          retryLabel="Réessayer"
        />
      )}
    </div>
  );
}

/**
 * Window holding a terminal opened for the occasion: « Se reconnecter dans un terminal »
 * (claude auth login), « Ouvrir /status », MCP « Reconnecter », a worktree shell. Dialog on
 * desktop (not dismissed by Échap nor an outside click: Échap belongs to the terminal; « Fermer »
 * closes), bottom Sheet on the phone. Creates the terminal on open, closes it (DELETE) on close.
 */
export function TerminalDialog({ open, onOpenChange, title, description, create, privacyNote, onExit, label }: TerminalDialogProps) {
  const isDesktop = useIsDesktopNav();
  const terminalLabel = label ?? title;

  if (!isDesktop) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent title={title} description={description} className="h-[85dvh]">
          <div className="flex h-full min-h-0 flex-col gap-3 pt-2">
            <TerminalSession create={create} privacyNote={privacyNote} onExit={onExit} label={terminalLabel} layout="sheet" />
            <CompactButton variant="secondaire" size="lg" block onClick={() => onOpenChange(false)}>
              Fermer le terminal
            </CompactButton>
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={title}
        description={description}
        hideClose
        dismissible={false}
        className="nav:w-[min(55rem,calc(100vw-32px))]"
        footer={
          <Button onClick={() => onOpenChange(false)}>Fermer</Button>
        }
      >
        <TerminalSession create={create} privacyNote={privacyNote} onExit={onExit} label={terminalLabel} layout="dialog" />
      </DialogContent>
    </Dialog>
  );
}
