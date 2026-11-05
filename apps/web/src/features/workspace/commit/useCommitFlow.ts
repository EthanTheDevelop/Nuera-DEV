'use client';

import { toast } from '@/components/ui';
import type { ChangedFile } from '@nuera/shared/runner';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { commitRequest, pullRequestRequest, pushRequest, WorkspaceApiError } from '../api';
import type { CommitResultView, PushResultView, WorkspacePullRequest } from '../lib/contract';
import { useWorkspace, type ActionError, type CommitPreset } from '../WorkspaceContext';

export interface CommitDraft {
  /** Paths left out of the commit (the others are included). */
  excluded: string[];
  message: string;
  body: string;
  push: boolean;
  openPr: boolean;
  prTitle: string;
  /** The PR title was typed by hand (no longer follows the commit subject). */
  prTitleEdited: boolean;
}

// Kept in memory for the session while the page lives (W5: « Keep the draft in memory »).
const drafts = new Map<string, CommitDraft>();

function emptyDraft(preset: CommitPreset): CommitDraft {
  return {
    excluded: [],
    message: '',
    body: '',
    push: preset !== 'commit',
    openPr: preset === 'pull-request' || preset === 'commit-push',
    prTitle: '',
    prTitleEdited: false,
  };
}

export type CommitStep = 'commit' | 'push' | 'pull-request';
export const STEP_LABEL: Record<CommitStep, string> = {
  commit: 'Commit en cours…',
  push: 'Push vers GitHub…',
  'pull-request': 'Ouverture de la pull request…',
};

export interface CommitFlowError extends ActionError {
  step: CommitStep;
}

/** Label of the confirm button for the chosen options (W5 Q5). */
export function commitCtaLabel(input: { files: number; push: boolean; openPr: boolean }): string {
  if (input.files > 0) {
    if (input.push && input.openPr) return 'Committer et ouvrir la PR';
    if (input.push) return 'Committer et pousser';
    return 'Committer';
  }
  if (input.push && input.openPr) return 'Pousser et ouvrir la PR';
  if (input.push) return 'Pousser';
  return 'Committer';
}

/**
 * Commit → push → pull request (W5 modal, S3 Git tab), run in order and stopped at the first
 * error, which says what failed and what was not touched (T4). Success = T3 toast with the link.
 */
export function useCommitFlow(preset: CommitPreset, active: boolean) {
  const ws = useWorkspace();
  const router = useRouter();
  const sessionId = ws.data.session.id;
  const worktree = ws.data.worktree;
  const files: ChangedFile[] = useMemo(() => ws.ctl.state.changes?.files ?? [], [ws.ctl.state.changes]);
  const openPullRequest = ws.ctl.state.pullRequest?.state === 'open' ? ws.ctl.state.pullRequest : null;
  const base = worktree?.baseBranch ?? ws.data.project.defaultBranch;
  // The default branch evolves through pull requests only (the server refuses the push too).
  const pushBlockedReason =
    worktree && worktree.branch === ws.data.project.defaultBranch
      ? `${worktree.branch} est la branche par défaut : le push direct est refusé, passez par une branche de session.`
      : null;
  const noFiles = files.length === 0;

  const [draft, setDraftState] = useState<CommitDraft>(() => drafts.get(sessionId) ?? emptyDraft(preset));
  const [step, setStep] = useState<CommitStep | null>(null);
  const [error, setError] = useState<CommitFlowError | null>(null);

  // Opening with another entry point (« Préparer la pull request »…) sets the switches accordingly.
  useEffect(() => {
    if (!active) return;
    setError(null);
    setDraftState((current) => {
      const saved = drafts.get(sessionId) ?? current;
      // Nothing to commit: pushing the commits already made is the only possible action.
      const push = pushBlockedReason ? false : preset === 'commit' && !noFiles ? saved.push : true;
      const openPr = !push ? false : preset === 'commit' ? false : preset === 'pull-request' ? true : saved.openPr || preset === 'commit-push';
      return { ...saved, push, openPr };
    });
  }, [active, noFiles, preset, pushBlockedReason, sessionId]);

  const setDraft = useCallback(
    (patch: Partial<CommitDraft>) => {
      setDraftState((current) => {
        const next = { ...current, ...patch };
        if (pushBlockedReason) next.push = false;
        if (!next.push) next.openPr = false;
        if (patch.message !== undefined && !next.prTitleEdited) next.prTitle = patch.message;
        drafts.set(sessionId, next);
        return next;
      });
    },
    [pushBlockedReason, sessionId],
  );

  const included = files.filter((f) => !draft.excluded.includes(f.path));
  const totals = included.reduce((acc, f) => ({ insertions: acc.insertions + f.insertions, deletions: acc.deletions + f.deletions }), {
    insertions: 0,
    deletions: 0,
  });
  const openPr = draft.openPr && !openPullRequest;
  const prTitle = draft.prTitleEdited ? draft.prTitle : draft.message;

  const blockers: string[] = [];
  if (!worktree?.present) blockers.push('Le worktree de cette session a été supprimé.');
  if (ws.serverDisabledReason) blockers.push(ws.serverDisabledReason);
  if (included.length > 0 && !draft.message.trim()) blockers.push('Écrivez le message de commit.');
  if (included.length === 0 && !draft.push) {
    blockers.push(pushBlockedReason ?? (noFiles ? 'Activez le push : aucun fichier à committer.' : 'Choisissez au moins un fichier à committer.'));
  }
  if (openPr && !prTitle.trim()) blockers.push('Donnez un titre à la pull request.');
  const canSubmit = blockers.length === 0 && step === null;

  const toggleFile = (path: string) =>
    setDraft({ excluded: draft.excluded.includes(path) ? draft.excluded.filter((p) => p !== path) : [...draft.excluded, path] });
  const toggleAll = () => setDraft({ excluded: included.length === files.length ? files.map((f) => f.path) : [] });

  const submit = useCallback(async (): Promise<boolean> => {
    if (!worktree?.present || !canSubmit) return false;
    setError(null);
    let commit: CommitResultView | null = null;
    let push: PushResultView | null = null;
    let pr: WorkspacePullRequest | null = null;
    let current: CommitStep = 'commit';
    try {
      if (included.length > 0) {
        current = 'commit';
        setStep('commit');
        commit = await commitRequest(worktree.id, {
          message: draft.message.trim(),
          ...(draft.body.trim() ? { body: draft.body } : {}),
          paths: included.map((f) => f.path),
          sessionId,
        });
      }
      if (draft.push) {
        current = 'push';
        setStep('push');
        push = await pushRequest(worktree.id, sessionId);
      }
      if (openPr) {
        current = 'pull-request';
        setStep('pull-request');
        pr = await pullRequestRequest(worktree.id, {
          title: prTitle.trim(),
          ...(draft.body.trim() ? { body: draft.body } : {}),
          base,
          sessionId,
        });
        ws.ctl.dispatch({ type: 'pullRequest', pullRequest: pr });
      }
    } catch (err) {
      const api = err instanceof WorkspaceApiError ? err : null;
      const done =
        current === 'push' && commit
          ? `Le commit ${commit.shortSha} est créé dans le worktree ; rien n'a été envoyé sur GitHub.`
          : current === 'pull-request'
            ? `${commit ? `Le commit ${commit.shortSha} est créé` : 'Rien n\'a été committé'}${push ? ' et la branche est poussée' : ''} ; aucune pull request n'a été créée.`
            : null;
      setError({
        step: current,
        title:
          current === 'commit' ? "Le commit n'a pas été créé" : current === 'push' ? "Le push vers GitHub n'a pas abouti" : "La pull request n'a pas été ouverte",
        message: api?.message ?? (err as Error).message,
        ...(done ?? api?.untouched ? { untouched: done ?? api?.untouched } : {}),
        ...(api?.raw ? { raw: api.raw } : {}),
      });
      setStep(null);
      ws.ctl.refreshChanges();
      if (commit) {
        // The commit exists: it must not be proposed again.
        setDraft({ message: '', body: '', excluded: [], prTitleEdited: false, prTitle: '' });
      }
      return false;
    }
    setStep(null);
    drafts.delete(sessionId);
    setDraftState(emptyDraft(preset));
    ws.ctl.refreshChanges();
    router.refresh();
    if (pr) {
      toast({ message: `Pull request #${pr.number} ouverte vers ${pr.baseBranch}`, icon: 'git-pull-request', action: { label: 'Voir sur GitHub', href: pr.url, external: true } });
    } else if (push) {
      toast({
        message: commit ? `Commit ${commit.shortSha} poussé sur origin/${push.remoteBranch}` : `Branche poussée sur origin/${push.remoteBranch}`,
        icon: 'upload',
        action: { label: 'Voir sur GitHub', href: push.url, external: true },
      });
    } else if (commit) {
      toast({ message: `Commit ${commit.shortSha} créé sur ${commit.branch ?? worktree.branch}`, icon: 'git-commit' });
    }
    return true;
  }, [base, canSubmit, draft, included, openPr, preset, prTitle, router, sessionId, setDraft, worktree, ws.ctl]);

  return {
    draft,
    setDraft,
    files,
    included,
    totals,
    openPullRequest,
    openPr,
    prTitle,
    base,
    branch: worktree?.branch ?? null,
    worktreeName: worktree?.isPrimary ? 'clone principal' : (worktree?.name ?? null),
    toggleFile,
    toggleAll,
    blockers,
    canSubmit,
    step,
    error,
    clearError: () => setError(null),
    submit,
    pushBlockedReason,
    cta: commitCtaLabel({ files: included.length, push: draft.push, openPr }),
    /** S3 (phone) names the button after the push: « Committer et pousser » even with the PR switch on. */
    phoneCta: commitCtaLabel({ files: included.length, push: draft.push, openPr: false }),
  };
}

export type CommitFlow = ReturnType<typeof useCommitFlow>;
