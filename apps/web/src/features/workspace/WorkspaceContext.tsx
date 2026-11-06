'use client';

import type { PermissionOption } from '@/components/dev';
import { useOptionalShellData } from '@/components/shell';
import { toast } from '@/components/ui';
import { useOptionalLiveEvents } from '@/hooks/useLiveEvents';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { decidePermissionRequest, interruptRequest, sendInstructionRequest, WorkspaceApiError } from './api';
import { useWorkspaceState, type WorkspaceController } from './hooks/useWorkspaceState';
import {
  DIFF_LAYOUT_VALUES,
  PANEL_VALUES,
  PHONE_TAB_VALUES,
  VIEW_VALUES,
  pick,
  type DiffLayoutParam,
  type PermissionOptionId,
  type WorkspaceData,
  type WorkspacePanel,
  type WorkspacePhoneTab,
  type WorkspaceView,
} from './lib/contract';
import { canPrepareCommit as canPrepare, composerStateFor, defaultPanel } from './lib/thread';

export interface ActionError {
  title: string;
  message?: string;
  untouched?: string;
  raw?: string;
}

export type CommitPreset = 'commit' | 'pull-request' | 'commit-push';

export interface WorkspaceUrlState {
  view: WorkspaceView;
  panel: WorkspacePanel;
  phoneTab: WorkspacePhoneTab;
  review: boolean;
  file: string | null;
  layout: DiffLayoutParam;
  set: (patch: Record<string, string | null>, mode?: 'push' | 'replace') => void;
}

export interface WorkspaceContextValue {
  data: WorkspaceData;
  ctl: WorkspaceController;
  host: string;
  /** Server time of the first snapshot: `useNow(…, initialNow)` renders the same text in SSR and hydration. */
  initialNow: number;
  reconnecting: boolean;
  /** Last proof of life of the server (ms epoch), for « Dernier signe du serveur il y a 12 s ». */
  lastSignalAt: number | null;
  claudeProblem: 'disconnected' | 'wrong_method' | 'not_installed' | null;
  composer: ReturnType<typeof composerStateFor>;
  url: WorkspaceUrlState;
  draft: string;
  setDraft: (value: string) => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  focusComposer: () => void;
  send: (text: string) => Promise<void>;
  sending: boolean;
  sendError: ActionError | null;
  clearSendError: () => void;
  interrupt: () => Promise<void>;
  interrupting: boolean;
  canInterrupt: boolean;
  decide: (permissionId: string, option: PermissionOption, message?: string) => Promise<void>;
  decision: { permissionId: string; optionId: string } | null;
  decisionError: { permissionId: string; message: string } | null;
  actionError: ActionError | null;
  setActionError: (error: ActionError | null) => void;
  commit: { open: boolean; preset: CommitPreset };
  openCommit: (preset: CommitPreset) => void;
  closeCommit: () => void;
  /** Uncommitted files of the worktree (null = unknown). */
  changedCount: number | null;
  /** Something can leave the VPS: uncommitted files or commits not pushed. */
  canPrepareCommit: boolean;
  serverDisabledReason: string | null;
}

const Ctx = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(Ctx);
  if (!value) throw new Error('useWorkspace() hors du Workspace');
  return value;
}

function toActionError(error: unknown, title: string): ActionError {
  if (error instanceof WorkspaceApiError) {
    return {
      title,
      message: error.message,
      ...(error.untouched ? { untouched: error.untouched } : {}),
      ...(error.raw ? { raw: error.raw } : {}),
    };
  }
  return { title, message: (error as Error)?.message ?? 'Erreur inattendue.' };
}

const CLAUDE_PROBLEMS = new Set(['disconnected', 'wrong_method', 'not_installed']);

/** Live connection lost for more than 1,5 s (same delay as the shell's banner). */
function useDelayedFlag(active: boolean, delayMs = 1500): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      const reset = setTimeout(() => setShown(false), 0);
      return () => clearTimeout(reset);
    }
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return active && shown;
}

export function WorkspaceProvider({ data, children }: { data: WorkspaceData; children: ReactNode }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const shell = useOptionalShellData();
  const live = useOptionalLiveEvents();
  const ctl = useWorkspaceState(data);
  const { state, dispatch, refreshChanges } = ctl;
  // The server holding the session (its CLI lives there), not necessarily the shell's.
  const host = data.environment.name;
  const [initialNow] = useState(() => {
    const parsed = Date.parse(data.generatedAt);
    return Number.isNaN(parsed) ? Date.now() : parsed;
  });

  const reconnecting = useDelayedFlag(ctl.reconnecting);
  const lastSignalAt = live?.lastSignalAt ?? null;
  const claudeState = live?.claude.state ?? shell?.claude.state ?? 'unknown';
  const claudeProblem = CLAUDE_PROBLEMS.has(claudeState) ? (claudeState as WorkspaceContextValue['claudeProblem']) : null;

  const worktreeMissing = Boolean(data.worktree && !data.worktree.present);
  const composer = composerStateFor({
    status: state.session.status,
    reconnecting,
    claudeBlocked: Boolean(claudeProblem),
    worktreeMissing,
    resumable: state.session.resumable,
  });

  // --- URL state (overview.md §6) ---------------------------------------------------------------
  const url = useMemo<WorkspaceUrlState>(() => {
    const view = pick(VIEW_VALUES, search.get('vue'), 'conversation');
    const panel = pick(PANEL_VALUES, search.get('panneau'), defaultPanel(data.session.status, data.changes ? data.changes.totals.files : null));
    const phoneTab = pick(PHONE_TAB_VALUES, search.get('onglet'), 'session');
    return {
      view,
      panel,
      phoneTab,
      review: search.get('revue') === '1',
      file: search.get('fichier'),
      layout: pick(DIFF_LAYOUT_VALUES, search.get('affichage'), 'cote-a-cote'),
      set: (patch, mode = 'push') => {
        const next = new URLSearchParams(search.toString());
        for (const [key, value] of Object.entries(patch)) {
          if (value === null || value === '') next.delete(key);
          else next.set(key, value);
        }
        const query = next.toString();
        const href = query ? `${pathname}?${query}` : pathname;
        // Native history (Next keeps useSearchParams in sync): no server round-trip for a UI state,
        // and never twice the same entry (Radix may report one click twice).
        if (href === `${window.location.pathname}${window.location.search}`) return;
        if (mode === 'replace') window.history.replaceState(null, '', href);
        else window.history.pushState(null, '', href);
      },
    };
  }, [data.changes, data.session.status, pathname, search]);

  // --- Composer ----------------------------------------------------------------------------------
  const [draft, setDraft] = useState('');
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const focusComposer = useCallback(() => {
    window.requestAnimationFrame(() => {
      const el = composerRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, []);

  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<ActionError | null>(null);
  const send = useCallback(
    async (text: string) => {
      const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setSending(true);
      setSendError(null);
      const last = ctl.items[ctl.items.length - 1];
      dispatch({ type: 'pending/add', pending: { localId, text, at: new Date().toISOString(), queued: true, afterPosition: last ? last.position : -1 } });
      try {
        const result = await sendInstructionRequest(data.session.id, text);
        dispatch({ type: 'session', patch: { status: result.status, queuedInstructions: result.queuedInstructions } });
        if (result.delivered) dispatch({ type: 'pending/update', localId, queued: false });
      } catch (error) {
        dispatch({ type: 'pending/remove', localId });
        setSendError(toActionError(error, "L'instruction n'a pas été envoyée"));
        throw error;
      } finally {
        setSending(false);
      }
    },
    [ctl.items, data.session.id, dispatch],
  );

  // --- Interrupt ---------------------------------------------------------------------------------
  const [interrupting, setInterrupting] = useState(false);
  const [actionError, setActionError] = useState<ActionError | null>(null);
  const canInterrupt = !reconnecting && (state.session.status === 'running' || state.session.status === 'waiting_permission');
  const interrupt = useCallback(async () => {
    if (!canInterrupt || interrupting) return;
    setInterrupting(true);
    try {
      await interruptRequest(data.session.id);
    } catch (error) {
      setActionError(toActionError(error, "Échap n'a pas été transmis au CLI"));
    } finally {
      setInterrupting(false);
    }
  }, [canInterrupt, data.session.id, interrupting]);

  // --- Permission decisions ----------------------------------------------------------------------
  const [decision, setDecision] = useState<{ permissionId: string; optionId: string } | null>(null);
  const [decisionError, setDecisionError] = useState<{ permissionId: string; message: string } | null>(null);
  const decide = useCallback(
    async (permissionId: string, option: PermissionOption, message?: string) => {
      setDecision({ permissionId, optionId: option.id });
      setDecisionError(null);
      try {
        const dto = await decidePermissionRequest(permissionId, {
          optionId: option.id as PermissionOptionId,
          ...(message ? { message } : {}),
        });
        dispatch({ type: 'permission', permission: dto });
      } catch (error) {
        const apiError = error instanceof WorkspaceApiError ? error : null;
        const text = apiError ? [apiError.message, apiError.untouched].filter(Boolean).join(' ') : "La réponse n'a pas pu être transmise au CLI.";
        setDecisionError({ permissionId, message: text });
        // Already decided elsewhere (another device, the terminal): read the real state again.
        if (apiError?.status === 409) void ctl.reloadThread();
      } finally {
        setDecision(null);
      }
    },
    [ctl, dispatch],
  );

  // --- Commit modal / Git tab ------------------------------------------------------------------
  const [commit, setCommit] = useState<{ open: boolean; preset: CommitPreset }>({ open: false, preset: 'commit' });
  const openCommit = useCallback(
    (preset: CommitPreset) => {
      refreshChanges();
      setCommit({ open: true, preset });
    },
    [refreshChanges],
  );
  const closeCommit = useCallback(() => setCommit((c) => ({ ...c, open: false })), []);

  const changedCount = state.changes ? state.changes.totals.files : null;
  const canPrepareCommit = canPrepare({ worktreePresent: Boolean(data.worktree?.present), changedFiles: changedCount, branch: state.branch });
  const serverDisabledReason = reconnecting ? 'Connexion au serveur perdue : action suspendue pendant la reconnexion.' : null;

  // Toast queued instructions delivered (pending count drop) is visible in the thread itself.
  useEffect(() => {
    if (!sendError) return;
    const t = setTimeout(() => setSendError(null), 30_000);
    return () => clearTimeout(t);
  }, [sendError]);

  const value: WorkspaceContextValue = {
    data,
    ctl,
    host,
    initialNow,
    reconnecting,
    lastSignalAt,
    claudeProblem,
    composer,
    url,
    draft,
    setDraft,
    composerRef,
    focusComposer,
    send,
    sending,
    sendError,
    clearSendError: () => setSendError(null),
    interrupt,
    interrupting,
    canInterrupt,
    decide,
    decision,
    decisionError,
    actionError,
    setActionError,
    commit,
    openCommit,
    closeCommit,
    changedCount,
    canPrepareCommit,
    serverDisabledReason,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export { toActionError, toast };
