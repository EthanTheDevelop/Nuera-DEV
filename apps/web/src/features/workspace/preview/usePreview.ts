'use client';

import { terminalText } from '@/components/dev';
import { useOptionalLiveEvents } from '@/hooks/useLiveEvents';
import { parseRunnerEvent } from '@nuera/shared/events';
import { DEFAULT_DEV_SERVER_NAME, PREVIEW_POSITION_MESSAGE } from '@nuera/shared/runner';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AUTODEBUG_STALL_MS, devServerFailure } from '@/lib/preview-autodebug';
import {
  fetchDevRuns,
  fetchRun,
  previewAutodebugRequest,
  previewHandoffRequest,
  startDevServerRequest,
  stopRunRequest,
  WorkspaceApiError,
  type RunListItem,
} from '../api';
import { useWorkspace } from '../WorkspaceContext';

/**
 * « Aperçu » state of the session's worktree: its dev servers (one per name the project declares —
 * « client », « admin » —, each its latest run, kept live by the global `run.status` events), the
 * selected one followed through `/api/stream/runs/<id>` (`run.status`, `run.output`), the handoff
 * to the preview origin once its port is detected, the path shown in the frame (posted by the
 * preview page itself), the viewer's options and the hand-over to Claude of a server started here
 * that does not start. Never polled.
 */

export type ServerState = 'loading' | 'unavailable' | 'stopped' | 'starting' | 'online' | 'error';
export type PreviewViewport = 'bureau' | 'telephone';

/**
 * No position posted by the page (`previewPositionScript`, added by the runner to the dev server's
 * HTML pages) this long after a navigation of the frame: the toolbar says so instead of leaving a
 * blank frame unexplained.
 */
const STALL_MS = 15_000;
const OUTPUT_KEEP = 16 * 1024;
/** A handoff older than this is renewed by « Recharger » (the preview cookie lives 12 h). */
const HANDOFF_RENEW_MS = 11 * 3_600_000;
const AUTO_RELOAD_DELAY_MS = 1_200;

// --- Viewer preferences (browser storage: a convenience, never required) -------------------------

const listeners = new Set<() => void>();
function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // private window, blocked storage: the choice lasts for this page only
  }
  for (const listener of listeners) listener();
}
function subscribePref(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const memory = new Map<string, string>();
function usePref<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (value: T) => void] {
  const raw = useSyncExternalStore(subscribePref, () => memory.get(key) ?? readPref(key), () => null);
  const value = raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
  const set = useCallback(
    (next: T) => {
      memory.set(key, next);
      writePref(key, next);
    },
    [key],
  );
  return [value, set];
}

// --- Helpers -------------------------------------------------------------------------------------

/** Last meaningful lines of a command output (ANSI removed). */
export function lastLines(output: string | null, count = 6): string {
  if (!output) return '';
  const lines = terminalText(output)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  return lines.slice(-count).join('\n');
}

function withoutHash(path: string): string {
  const at = path.indexOf('#');
  return at >= 0 ? path.slice(0, at) : path;
}

/** Last page shown per dev server, so moving the preview (panel ⇄ main view ⇄ tab) keeps it. */
const lastPaths = new Map<string, string>();

interface RunState {
  status: 'loading' | 'ready' | 'error';
  /** Latest run per dev server name. */
  runs: Record<string, { run: RunListItem; live: boolean }>;
  /** Output of the selected server's latest run. */
  output: string;
  outputRunId: string | null;
  message: string | null;
}

/** What happened to « Demander à Claude » for a run (shown under the error). */
export type AutodebugState =
  | { kind: 'sending' }
  | { kind: 'sent'; queued: boolean }
  | { kind: 'waiting_permission' }
  | { kind: 'error'; message: string };

export interface DevServerTab {
  name: string;
  command: string;
  state: ServerState;
  port: number | null;
  runId: string | null;
}

export interface PreviewController {
  enabled: boolean;
  disabledReason: string | null;
  origin: string | null;
  /** Command of the selected dev server (null: the project has none). */
  devCommand: string | null;
  /** Every dev server of the project, default first (tabs when there are several). */
  servers: DevServerTab[];
  /** Name of the dev server shown. */
  selected: string | null;
  select: (name: string) => void;
  worktreePresent: boolean;
  projectId: string;
  state: ServerState;
  run: RunListItem | null;
  outputLines: string;
  output: string;
  loadError: string | null;
  actionError: string | null;
  clearActionError: () => void;
  /** Single-use entry URL loaded in the frame (null until handed off). */
  frameSrc: string | null;
  opening: boolean;
  /** Path shown in the frame (as reported by the page), else the last one asked. */
  path: string;
  /** The frame showed no page of the dev server {@link STALL_MS} after its last navigation. */
  stalled: boolean;
  starting: boolean;
  stopping: boolean;
  /** Starts the selected dev server, or the one named (then selected). */
  start: (name?: string) => Promise<void>;
  stop: () => Promise<void>;
  reload: () => void;
  /** New handoff (the previous one failed). */
  reopen: () => void;
  navigate: (path: string) => void;
  openInNewTab: () => Promise<void>;
  retryLoad: () => void;
  /** Callback ref of the frame element. */
  attachFrame: (element: HTMLIFrameElement | null) => void;
  viewport: PreviewViewport;
  setViewport: (value: PreviewViewport) => void;
  autoReload: boolean;
  setAutoReload: (value: boolean) => void;
  /** « Demander à Claude de corriger automatiquement » (default on). */
  autoFix: boolean;
  setAutoFix: (value: boolean) => void;
  /** « Relancer après correction » (default off): starts the server again once Claude's turn ends. */
  relaunchAfterFix: boolean;
  setRelaunchAfterFix: (value: boolean) => void;
  /** Hand-over of the selected run to Claude (null: never asked). */
  autodebug: AutodebugState | null;
  /** « Demander à Claude » (the selected server does not start). */
  askClaude: () => void;
  /** The selected server does not start (ended in error, or no port with errors after a minute). */
  failing: boolean;
  serverDisabledReason: string | null;
}

const lastSelected = new Map<string, string>();

function stateOf(entry: { run: RunListItem; live: boolean } | undefined, loading: RunState['status']): ServerState {
  if (loading === 'loading') return 'loading';
  if (!entry) return loading === 'error' ? 'unavailable' : 'stopped';
  const { run, live } = entry;
  if (run.status === 'running' && live) return run.port ? 'online' : 'starting';
  if (run.status === 'failed') return 'error';
  return 'stopped';
}

export function usePreview(): PreviewController {
  const ws = useWorkspace();
  const live = useOptionalLiveEvents();
  const { project, worktree, preview, session } = ws.data;
  const worktreeId = worktree?.present ? worktree.id : null;
  const configured = project.commands.devServers;
  const origin = preview.enabled ? preview.origin : null;
  const sessionStatus = ws.ctl.state.session.status;

  const [viewport, setViewport] = usePref<PreviewViewport>('nuera.apercu.affichage', 'bureau', ['bureau', 'telephone']);
  const [autoPref, setAutoPref] = usePref<'oui' | 'non'>('nuera.apercu.rechargement', 'oui', ['oui', 'non']);
  const autoReload = autoPref === 'oui';
  const setAutoReload = useCallback((value: boolean) => setAutoPref(value ? 'oui' : 'non'), [setAutoPref]);
  const [fixPref, setFixPref] = usePref<'oui' | 'non'>('nuera.apercu.correction', 'oui', ['oui', 'non']);
  const autoFix = fixPref === 'oui';
  const setAutoFix = useCallback((value: boolean) => setFixPref(value ? 'oui' : 'non'), [setFixPref]);
  const [relaunchPref, setRelaunchPref] = usePref<'oui' | 'non'>('nuera.apercu.relance', 'non', ['oui', 'non']);
  const relaunchAfterFix = relaunchPref === 'oui';
  const setRelaunchAfterFix = useCallback((value: boolean) => setRelaunchPref(value ? 'oui' : 'non'), [setRelaunchPref]);

  const [runState, setRunState] = useState<RunState>({ status: 'loading', runs: {}, output: '', outputRunId: null, message: null });
  const [actionError, setActionError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  // --- Selected dev server ---------------------------------------------------------------------------
  const selectionKey = worktreeId ?? project.id;
  const [chosen, setChosen] = useState<string | null>(() => lastSelected.get(selectionKey) ?? null);
  const select = useCallback(
    (name: string) => {
      lastSelected.set(selectionKey, name);
      setChosen(name);
    },
    [selectionKey],
  );

  /** Server names shown: the configured ones, then a live run of a name no longer configured. */
  const names = useMemo(() => {
    const list = configured.map((entry) => entry.name);
    for (const [name, entry] of Object.entries(runState.runs)) if (!list.includes(name) && entry.live && entry.run.status === 'running') list.push(name);
    return list;
  }, [configured, runState.runs]);
  const selected = chosen && names.includes(chosen) ? chosen : (names.find((name) => runState.runs[name]?.live) ?? names[0] ?? null);
  const selectedEntry = selected ? runState.runs[selected] : undefined;

  // --- Latest run of each dev server of the worktree ---------------------------------------------------
  const defaultName = configured[0]?.name ?? DEFAULT_DEV_SERVER_NAME;
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    if (!worktreeId) return;
    const seq = (loadSeq.current += 1);
    try {
      const { runs } = await fetchDevRuns(project.id, worktreeId);
      const latest = new Map<string, RunListItem>();
      for (const run of runs) {
        if (run.kind !== 'dev') continue;
        const name = run.name ?? defaultName;
        if (!latest.has(name)) latest.set(name, run);
      }
      const details = await Promise.all(
        [...latest.entries()].map(async ([name, run]) => {
          const detail = await fetchRun(run.id);
          return [name, detail] as const;
        }),
      );
      if (seq !== loadSeq.current) return;
      setRunState((prev) => {
        const next: RunState['runs'] = {};
        for (const [name, detail] of details) {
          const base = latest.get(name)!;
          next[name] = { run: { ...base, ...detail.run, name, port: detail.run.port ?? null }, live: detail.live };
        }
        // The output stays: the selected run's one is read (and streamed) on its own.
        return { ...prev, status: 'ready', runs: next, message: null };
      });
    } catch (error) {
      if (seq !== loadSeq.current) return;
      setRunState((prev) => ({ ...prev, status: 'error', message: (error as Error).message }));
    }
  }, [defaultName, project.id, worktreeId]);

  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- reads external data (runs of the worktree)
    void load();
  }, [load]);

  const run = selectedEntry?.run ?? null;
  const runId = run?.id ?? null;
  const running = run?.status === 'running' && Boolean(selectedEntry?.live);

  // The output shown belongs to the selected run: a new selection starts from its stored tail.
  useEffect(() => {
    if (!runId || runState.outputRunId === runId) return;
    let cancelled = false;
    void fetchRun(runId)
      .then((detail) => {
        if (cancelled) return;
        setRunState((prev) => (prev.outputRunId === runId ? prev : { ...prev, output: detail.outputTail ?? '', outputRunId: runId }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [runId, runState.outputRunId]);

  const patchRun = useCallback((name: string, id: string, patch: Partial<RunListItem>, liveFlag?: boolean) => {
    setRunState((prev) => {
      const entry = prev.runs[name];
      if (entry?.run.id !== id) return prev;
      return { ...prev, runs: { ...prev.runs, [name]: { run: { ...entry.run, ...patch }, live: liveFlag ?? entry.live } } };
    });
  }, []);

  // Live selected run: status (port detected, end) and output (starting / error lines).
  useEffect(() => {
    if (!runId || !running || !selected) return;
    const name = selected;
    const source = new EventSource(`/api/stream/runs/${encodeURIComponent(runId)}`, { withCredentials: true });
    source.addEventListener('message', (message) => {
      const event = parseRunnerEvent(message.data);
      if (event?.type === 'run.status' && event.data.run.id === runId) {
        const next = event.data.run;
        patchRun(name, runId, { status: next.status, port: next.port, exitCode: next.exitCode, summary: next.summary, finishedAt: next.finishedAt }, next.live);
      } else if (event?.type === 'run.output' && event.data.runId === runId) {
        const { data, replay } = event.data;
        setRunState((prev) => ({
          ...prev,
          output: (replay || prev.outputRunId !== runId ? data : prev.output + data).slice(-OUTPUT_KEEP),
          outputRunId: runId,
        }));
      }
    });
    return () => source.close();
  }, [patchRun, runId, running, selected]);

  // Every dev server of this worktree, wherever it was started (another tab, the project page).
  const subscribe = live?.subscribe;
  const runsRef = useRef(runState.runs);
  useEffect(() => {
    runsRef.current = runState.runs;
  }, [runState.runs]);
  useEffect(() => {
    if (!subscribe || !worktreeId) return;
    return subscribe('run.status', (event) => {
      const other = event.data.run;
      if (other.kind !== 'dev' || other.worktreeId !== worktreeId) return;
      const name = other.name ?? defaultName;
      const known = runsRef.current[name];
      if (known?.run.id === other.id) {
        patchRun(name, other.id, { status: other.status, port: other.port, exitCode: other.exitCode, summary: other.summary, finishedAt: other.finishedAt }, other.live);
      } else {
        void load();
      }
    });
  }, [defaultName, load, patchRun, subscribe, worktreeId]);

  const servers: DevServerTab[] = useMemo(
    () =>
      names.map((name) => {
        const entry = runState.runs[name];
        return {
          name,
          command: configured.find((c) => c.name === name)?.command ?? entry?.run.command ?? '',
          state: stateOf(entry, runState.status),
          port: entry?.live && entry.run.status === 'running' ? entry.run.port : null,
          runId: entry?.run.id ?? null,
        };
      }),
    [configured, names, runState.runs, runState.status],
  );
  const state: ServerState = stateOf(selectedEntry, runState.status);
  const devCommand = selected ? (configured.find((c) => c.name === selected)?.command ?? run?.command ?? null) : null;

  // --- Handoff → frame -----------------------------------------------------------------------------
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const attachFrame = useCallback((element: HTMLIFrameElement | null) => {
    frameRef.current = element;
  }, []);
  const [frame, setFrame] = useState<{ runId: string; src: string; at: number } | null>(null);
  const [opening, setOpening] = useState(false);
  const [path, setPath] = useState('/');
  const pathRef = useRef('/');
  const runIdRef = useRef(runId);
  useEffect(() => {
    runIdRef.current = runId;
  }, [runId]);
  const showPath = useCallback((value: string) => {
    pathRef.current = value;
    if (runIdRef.current) lastPaths.set(runIdRef.current, value);
    setPath(value);
  }, []);

  // Navigations of the frame (handoff, path field, « Recharger ») and whether the page answered.
  const [navigation, setNavigation] = useState(0);
  const answered = useRef(-1);
  const navigationRef = useRef(0);
  const [stalledAt, setStalledAt] = useState(-1);
  const markNavigation = useCallback(() => {
    navigationRef.current += 1;
    setNavigation(navigationRef.current);
  }, []);

  const handoff = useCallback(
    async (id: string, at: string) => {
      setOpening(true);
      try {
        const { url } = await previewHandoffRequest(id, at);
        setFrame({ runId: id, src: url, at: Date.now() });
        markNavigation();
        setActionError(null);
      } catch (error) {
        setFrame(null);
        setActionError(error instanceof WorkspaceApiError ? error.message : "L'aperçu n'a pas pu être ouvert.");
      } finally {
        setOpening(false);
      }
    },
    [markNavigation],
  );

  const onlineRunId = state === 'online' && origin ? runId : null;
  useEffect(() => {
    if (!onlineRunId) {
      // eslint-disable-next-line react/set-state-in-effect -- the frame follows the dev server (external state)
      setFrame(null);
      return;
    }
    if (frame?.runId === onlineRunId) return;
    const resume = lastPaths.get(onlineRunId) ?? '/';
    pathRef.current = resume;
    // eslint-disable-next-line react/set-state-in-effect -- resumes the page last shown for this dev server
    setPath(resume);
    void handoff(onlineRunId, withoutHash(resume));
  }, [frame?.runId, handoff, onlineRunId]);

  // Position posted by the preview page (only from our frame, only from the preview origin).
  useEffect(() => {
    if (!origin) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { type?: unknown; path?: unknown } | null;
      if (data?.type !== PREVIEW_POSITION_MESSAGE || typeof data.path !== 'string' || !data.path.startsWith('/') || data.path.length > 2048) return;
      answered.current = navigationRef.current;
      setStalledAt(-1);
      showPath(data.path);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [origin, showPath]);

  const frameShown = frame !== null;
  useEffect(() => {
    if (!frameShown) return;
    const timer = setTimeout(() => {
      if (answered.current !== navigation) setStalledAt(navigation);
    }, STALL_MS);
    return () => clearTimeout(timer);
  }, [frameShown, navigation]);

  const go = useCallback(
    (target: string) => {
      if (!origin || !onlineRunId) return;
      markNavigation();
      if (frame && Date.now() - frame.at > HANDOFF_RENEW_MS) {
        void handoff(onlineRunId, withoutHash(target));
        return;
      }
      const win = frameRef.current?.contentWindow;
      const url = `${origin}${withoutHash(target)}`;
      try {
        if (win) win.location.replace(url);
        else if (frameRef.current) frameRef.current.src = url;
      } catch {
        if (frameRef.current) frameRef.current.src = url;
      }
    },
    [frame, handoff, markNavigation, onlineRunId, origin],
  );

  const reload = useCallback(() => go(pathRef.current), [go]);
  const navigate = useCallback(
    (value: string) => {
      const text = value.trim();
      const target = text ? (text.startsWith('/') ? text : `/${text}`) : '/';
      if (target.startsWith('//') || target.startsWith('/__nuera/') || /[\s\\]/.test(target)) {
        setActionError('Chemin invalide : saisissez un chemin du site, par exemple /devis.');
        return;
      }
      setActionError(null);
      showPath(target);
      go(target);
    },
    [go, showPath],
  );

  // « Recharger après chaque modification de Claude ».
  const writes = ws.ctl.claudeWrites;
  const seenWrites = useRef(writes);
  useEffect(() => {
    if (writes === seenWrites.current) return;
    seenWrites.current = writes;
    if (!autoReload || !frame) return;
    const timer = setTimeout(reload, AUTO_RELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [autoReload, frame, reload, writes]);

  // --- Actions -------------------------------------------------------------------------------------
  /** Runs started from this Aperçu (the owner clicked « Démarrer »): only those are handed to Claude by themselves. */
  const startedHere = useRef(new Set<string>());
  const start = useCallback(
    async (name?: string) => {
      const target = name ?? selected;
      if (!worktreeId || !target) return;
      if (name) select(name);
      setStarting(target);
      setActionError(null);
      try {
        const { run: started } = await startDevServerRequest(project.id, worktreeId, target);
        startedHere.current.add(started.id);
        setRunState((prev) => ({
          ...prev,
          status: 'ready',
          output: prev.outputRunId === started.id ? prev.output : '',
          outputRunId: started.id,
          runs: {
            ...prev.runs,
            [target]: {
              live: true,
              run: {
                id: started.id,
                kind: 'dev',
                name: target,
                command: configured.find((c) => c.name === target)?.command ?? '',
                status: started.status,
                exitCode: null,
                summary: null,
                port: started.port ?? null,
                worktreeId,
                startedAt: new Date().toISOString(),
                finishedAt: null,
                tests: null,
              },
            },
          },
        }));
        void load();
      } catch (error) {
        setActionError((error as Error).message);
        // Already running in this worktree (another tab): show that one.
        void load();
      } finally {
        setStarting(null);
      }
    },
    [configured, load, project.id, select, selected, worktreeId],
  );

  const stop = useCallback(async () => {
    if (!runId) return;
    setStopping(true);
    setActionError(null);
    try {
      await stopRunRequest(runId);
      await load();
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setStopping(false);
    }
  }, [load, runId]);

  // --- « Demander à Claude » (a dev server that does not start) ---------------------------------------
  const [autodebugByRun, setAutodebugByRun] = useState<Record<string, AutodebugState>>({});
  const autodebugRef = useRef(autodebugByRun);
  useEffect(() => {
    autodebugRef.current = autodebugByRun;
  }, [autodebugByRun]);
  /** Server to start again once Claude's turn ends (« Relancer après correction »), and whether that turn began. */
  const relaunch = useRef<{ name: string; sawWork: boolean } | null>(null);

  const handOver = useCallback(
    async (target: RunListItem, name: string, trigger: 'auto' | 'manual', output: string | null) => {
      const current = autodebugRef.current[target.id];
      if (current && current.kind !== 'error' && current.kind !== 'waiting_permission') return;
      autodebugRef.current = { ...autodebugRef.current, [target.id]: { kind: 'sending' } };
      setAutodebugByRun((prev) => ({ ...prev, [target.id]: { kind: 'sending' } }));
      try {
        const result = await previewAutodebugRequest({
          runId: target.id,
          sessionId: session.id,
          trigger,
          ...(output ? { output: output.slice(-60_000) } : {}),
        });
        // Claude was working: the CLI takes the instruction after its current step.
        const queued = result.queued || sessionStatus === 'running';
        setAutodebugByRun((prev) => ({ ...prev, [target.id]: { kind: 'sent', queued } }));
        relaunch.current = { name, sawWork: false };
      } catch (error) {
        const reason = error instanceof WorkspaceApiError ? error.reason : null;
        const next: AutodebugState =
          reason === 'SESSION_BUSY_PERMISSION'
            ? { kind: 'waiting_permission' }
            : reason === 'AUTODEBUG_ALREADY_SENT'
              ? { kind: 'sent', queued: false }
              : { kind: 'error', message: (error as Error).message };
        setAutodebugByRun((prev) => ({ ...prev, [target.id]: next }));
      }
    },
    [session.id, sessionStatus],
  );

  // Automatic hand-over: a server started here that ended in error, or that has shown errors without
  // a port for a minute — once per run; after the pending permission is answered when one waits.
  const [stallTick, setStallTick] = useState(0);
  useEffect(() => {
    if (!autoFix) return;
    let nextCheck: number | null = null;
    for (const [name, entry] of Object.entries(runState.runs)) {
      const target = entry.run;
      if (!startedHere.current.has(target.id)) continue;
      const done = autodebugByRun[target.id];
      if (done && done.kind !== 'waiting_permission') continue;
      if (done?.kind === 'waiting_permission' && sessionStatus === 'waiting_permission') continue;
      const output = runState.outputRunId === target.id ? runState.output : '';
      const failure = devServerFailure(target, output);
      if (failure) {
        // eslint-disable-next-line react/set-state-in-effect -- hands an external failure (the dev server's) to Claude
        void handOver(target, name, 'auto', output || null);
      } else if (target.status === 'running' && !target.port && runState.outputRunId === target.id) {
        const due = Date.parse(target.startedAt) + AUTODEBUG_STALL_MS - Date.now();
        nextCheck = Math.max(1_000, Math.min(nextCheck ?? Infinity, due + 500));
      }
    }
    if (nextCheck === null) return;
    const timer = setTimeout(() => setStallTick((n) => n + 1), Math.min(nextCheck, 15_000));
    return () => clearTimeout(timer);
    // stallTick: re-check a starting server once its minute is over.
    // eslint-disable-next-line react/exhaustive-effect-dependencies -- see above
  }, [autoFix, autodebugByRun, handOver, runState.output, runState.outputRunId, runState.runs, sessionStatus, stallTick]);

  // « Relancer après correction »: once Claude worked and waits again, the server starts once more.
  useEffect(() => {
    const pending = relaunch.current;
    if (!pending) return;
    if (sessionStatus === 'running' || sessionStatus === 'waiting_permission') {
      pending.sawWork = true;
      return;
    }
    if (!pending.sawWork || sessionStatus !== 'waiting_input') return;
    relaunch.current = null;
    if (!relaunchAfterFix) return;
    const entry = runsRef.current[pending.name];
    if (entry?.live && entry.run.status === 'running') return;
    void start(pending.name);
  }, [relaunchAfterFix, sessionStatus, start]);

  const failing = Boolean(run && devServerFailure(run, runState.outputRunId === run.id ? runState.output : ''));
  const askClaude = useCallback(() => {
    if (!run || !selected) return;
    void handOver(run, selected, 'manual', runState.outputRunId === run.id ? runState.output : null);
  }, [handOver, run, runState.output, runState.outputRunId, selected]);

  const openInNewTab = useCallback(async () => {
    if (!onlineRunId) return;
    // Opened during the click (popup blockers), filled once the handoff URL is known.
    const tab = window.open('about:blank', '_blank');
    if (!tab) {
      setActionError("Le navigateur a bloqué l'ouverture d'un nouvel onglet.");
      return;
    }
    tab.opener = null;
    try {
      const { url } = await previewHandoffRequest(onlineRunId, withoutHash(pathRef.current));
      tab.location.replace(url);
    } catch (error) {
      tab.close();
      setActionError(error instanceof WorkspaceApiError ? error.message : "L'aperçu n'a pas pu être ouvert.");
    }
  }, [onlineRunId]);

  return {
    enabled: preview.enabled,
    disabledReason: preview.enabled ? null : preview.reason,
    origin,
    devCommand,
    servers,
    selected,
    select,
    worktreePresent: Boolean(worktreeId),
    projectId: project.id,
    state,
    run,
    output: runState.outputRunId === runId ? runState.output : '',
    outputLines: lastLines(runState.outputRunId === runId ? runState.output : ''),
    loadError: runState.status === 'error' ? runState.message : null,
    actionError,
    clearActionError: () => setActionError(null),
    frameSrc: frame?.src ?? null,
    opening,
    path,
    stalled: frameShown && stalledAt === navigation,
    starting: starting !== null && starting === selected,
    stopping,
    start,
    stop,
    reload,
    reopen: () => {
      if (onlineRunId) void handoff(onlineRunId, withoutHash(pathRef.current));
    },
    navigate,
    openInNewTab,
    retryLoad: () => void load(),
    attachFrame,
    viewport,
    setViewport,
    autoReload,
    setAutoReload,
    autoFix,
    setAutoFix,
    relaunchAfterFix,
    setRelaunchAfterFix,
    autodebug: runId ? (autodebugByRun[runId] ?? null) : null,
    askClaude,
    failing,
    serverDisabledReason: ws.serverDisabledReason,
  };
}
