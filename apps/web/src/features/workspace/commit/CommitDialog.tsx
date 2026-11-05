'use client';

import { Icon } from '@/components/icons';
import { Button, Dialog, DialogContent } from '@/components/ui';
import { useWorkspace } from '../WorkspaceContext';
import { CommitForm } from './CommitForm';
import { STEP_LABEL, useCommitFlow } from './useCommitFlow';

/**
 * W5 `Modale · Préparer le commit` (231:3904, 680 wide over the 55 % scrim): « Rien n'est envoyé
 * sur GitHub sans cette confirmation. » Escape / Annuler / Fermer keep the draft.
 */
export function CommitDialog() {
  const ws = useWorkspace();
  const flow = useCommitFlow(ws.commit.preset, ws.commit.open);
  const busy = flow.step !== null;
  const branchLine = `${flow.branch ?? ''} → origin${flow.worktreeName ? ` · ${flow.worktreeName.startsWith('clone') ? flow.worktreeName : `worktree ${flow.worktreeName}`}` : ''}`;

  return (
    <Dialog open={ws.commit.open} onOpenChange={(open) => (open ? null : ws.closeCommit())}>
      <DialogContent
        size="lg"
        title="Préparer le commit"
        description={
          <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-app-12 text-muted">
            <Icon name="git-branch" size={14} className="shrink-0" />
            <span className="truncate">{branchLine}</span>
          </span>
        }
        dismissible={!busy}
        bodyClassName="gap-[18px] py-5"
        footerNote={
          busy ? (
            <span role="status" aria-live="polite">
              {STEP_LABEL[flow.step!]}
            </span>
          ) : (
            <>
              Rien n&apos;est envoyé sur GitHub sans cette confirmation.
              {flow.blockers[0] && !flow.error ? <span className="block pt-0.5 text-warn">{flow.blockers[0]}</span> : null}
            </>
          )
        }
        footer={
          <>
            <Button variant="default" onClick={ws.closeCommit} disabled={busy}>
              Annuler
            </Button>
            <Button
              variant="accent"
              loading={busy}
              loadingLabel={busy ? STEP_LABEL[flow.step!] : undefined}
              disabled={!flow.canSubmit}
              onClick={async () => {
                if (await flow.submit()) ws.closeCommit();
              }}
            >
              {flow.cta}
            </Button>
          </>
        }
      >
        <CommitForm flow={flow} variant="dialog" />
      </DialogContent>
    </Dialog>
  );
}
