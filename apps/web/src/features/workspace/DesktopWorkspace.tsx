'use client';

import { useEffect } from 'react';
import { CommitDialog } from './commit/CommitDialog';
import { SessionHeader } from './header/SessionHeader';
import { ContextPanel } from './panel/ContextPanel';
import { PreviewPanel } from './preview/PreviewPanel';
import { ReviewMode } from './review/ReviewMode';
import { SessionColumn } from './session/SessionColumn';
import { useWorkspace } from './WorkspaceContext';

/** Échap anywhere in the conversation view interrupts the current step (D05 « Échap · interrompre »). */
function useEscapeInterrupts() {
  const ws = useWorkspace();
  const { canInterrupt, interrupt, url } = ws;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !canInterrupt || url.view !== 'conversation') return;
      const target = event.target as HTMLElement | null;
      // Terminals, fields with their own Échap, menus and dialogs keep the key.
      if (target?.closest('[data-terminal-state], input, select, [role="dialog"], [role="alertdialog"], [role="menu"], [data-radix-popper-content-wrapper]')) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]')) return;
      if (target?.tagName === 'TEXTAREA') return; // the composer handles it
      event.preventDefault();
      void interrupt();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canInterrupt, interrupt, url.view]);
}

/**
 * D05 desktop composition (1440): header, session column + 460 px context panel, or W4 review.
 * `?vue=apercu` (« Inverser ») swaps them: the preview in the middle, the conversation and composer in the
 * 460 px column, so the owner keeps prompting while looking at the site.
 */
export function DesktopWorkspace() {
  const ws = useWorkspace();
  useEscapeInterrupts();
  const panelShown = ws.url.panel !== 'ferme';
  return (
    <div className="flex h-dvh min-h-0 w-full min-w-0 flex-col bg-surface-raised">
      <SessionHeader />
      <div className="flex min-h-0 flex-1">
        {ws.url.review ? (
          <ReviewMode />
        ) : (
          <>
            {ws.url.view === 'apercu' ? (
              // « Inverser » : le rendu au centre, la conversation (et la saisie) à droite, à la place du panneau.
              <>
                <PreviewPanel variant="main" />
                <div className="flex w-[460px] min-w-0 shrink-0 border-l border-border">
                  <SessionColumn compact />
                </div>
              </>
            ) : (
              <>
                <SessionColumn />
                {panelShown ? <ContextPanel /> : null}
              </>
            )}
          </>
        )}
      </div>
      <CommitDialog />
    </div>
  );
}
