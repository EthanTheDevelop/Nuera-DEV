'use client';

import '@xterm/xterm/css/xterm.css';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Terminal as XTerm } from '@xterm/xterm';
import { CompactButton, Spinner, StatusDot, type StatusTone } from '@/components/ui';
import { useOptionalShellData } from '@/components/shell/ShellContext';
import { useIsDesktopNav, useMediaQuery } from '@/hooks/useMediaQuery';
import { useNow } from '@/hooks/useNow';
import { cn } from '@/lib/cn';
import { postTerminalJson, terminalUrls } from './api';
import { TerminalConnection, type TerminalConnectionStatus } from './connection';
import {
  isApplePlatform,
  measureCharHeight,
  prefersReducedMotion,
  readMonoFontFamily,
  readTerminalTheme,
  terminalClientId,
  waitForFont,
} from './dom';
import {
  DESKTOP_FONT_SIZE,
  InputBatcher,
  KEY_BAR,
  PHONE_FONT_SIZE,
  RESIZE_DEBOUNCE_MS,
  clampSize,
  clipboardShortcut,
  errorText,
  exitText,
  keySequence,
  lineHeightFor,
  safeExternalUrl,
  sameSize,
  stateAnnouncement,
  xtermLineHeight,
  type TerminalKey,
  type TerminalSize,
  type TerminalViewState,
} from './protocol';

export type { TerminalViewState } from './protocol';

export interface TerminalViewProps {
  /** Runner terminal id (POST /api/terminals, MCP login, or a session's `GET /v1/sessions/:id/terminal`). */
  terminalId: string;
  /** SSE relay (default `/api/stream/terminals/<id>`). */
  streamUrl?: string;
  /** Keystrokes (default `/api/terminals/<id>/input`). */
  inputUrl?: string;
  /** Size of this tab (default `/api/terminals/<id>/resize`). */
  resizeUrl?: string;
  /** Watch only: no keystroke, no resize (the grid follows the PTY size). */
  readOnly?: boolean;
  /** Focus the terminal once its first screen is drawn. */
  autoFocus?: boolean;
  /** Give the panel its height here (`flex-1`, `h-[60dvh]`…); default minimum height 240 px. */
  className?: string;
  /** Font size in px (default 13 / 21 on desktop, 11 / 17 on the phone). */
  fontSize?: number;
  /** The process exited (`terminal.exit`), with its code when known. */
  onExit?: (code: number | null) => void;
  onStateChange?: (state: TerminalViewState) => void;
  /** Accessible name of the terminal region (default « Terminal »). */
  label?: string;
  /** Phone key bar (Échap, Ctrl+C, Tab, arrows, Coller): `auto` = phone layout or touch screen. */
  keyBar?: boolean | 'auto';
  /** Server name of the « … ne répond pas » copy outside the app shell (default: the shell's server). */
  serverName?: string;
}

const INITIAL_STATUS: TerminalConnectionStatus = {
  state: 'connecting',
  attempt: 0,
  nextRetryAt: null,
  runnerDown: false,
  wasLive: false,
  exitCode: null,
  signal: null,
  error: null,
};

/** true once `active` stayed true for `delayMs` (no flash on a quick reconnection). */
function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(active), active ? delayMs : 0);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return active && shown;
}

const noSubscribe = () => () => undefined;
/** Clipboard reading exists (secure context): the key bar offers « Coller ». */
function useCanReadClipboard(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => typeof navigator.clipboard?.readText === 'function',
    () => false,
  );
}

function RetryCountdown({ nextRetryAt }: { nextRetryAt: number | null }) {
  const now = useNow(1_000);
  const seconds = nextRetryAt === null ? 0 : Math.max(0, Math.ceil((nextRetryAt - now) / 1000));
  return <span suppressHydrationWarning>{seconds > 0 ? `nouvel essai dans ${seconds} s` : 'nouvel essai en cours…'}</span>;
}

function openExternal(uri: string): void {
  const url = safeExternalUrl(uri);
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
}

function copyText(text: string): void {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => document.execCommand('copy'));
  } else {
    document.execCommand('copy');
  }
}

interface ViewActions {
  applyFont: (size: number) => void;
  sendKey: (key: TerminalKey) => void;
  paste: () => void;
  retry: () => void;
  setLabel: (label: string) => void;
}

/**
 * The shared browser terminal (xterm.js 6): « Terminal brut » of a session (W2), shell of a worktree,
 * `claude auth login`, `/status`, MCP login. Dark Color mode (`data-tone="dark"`: ink background,
 * JetBrains Mono 13 / 21, white text, 62 % white muted, accent #a6b9dd, failures in danger-pale).
 *
 * Draws `terminal.snapshot` (screen + scrollback) then `terminal.data`, follows `terminal.resize`
 * and `terminal.exit`; keystrokes batched (~10 ms, in order) to the input route; size reported
 * (debounced, one client id per tab) when this tab's panel changes or when it takes the keyboard
 * back; reconnection with back-off and a fresh snapshot. Never logs terminal bytes.
 */
export function TerminalView({
  terminalId,
  streamUrl,
  inputUrl,
  resizeUrl,
  readOnly = false,
  autoFocus = false,
  className,
  fontSize,
  onExit,
  onStateChange,
  label = 'Terminal',
  keyBar = 'auto',
  serverName: serverNameProp,
}: TerminalViewProps) {
  const urls = useMemo(() => terminalUrls(terminalId), [terminalId]);
  const stream = streamUrl ?? urls.stream;
  const input = inputUrl ?? urls.input;
  const resize = resizeUrl ?? urls.resize;

  const isDesktop = useIsDesktopNav();
  const coarsePointer = useMediaQuery('(pointer: coarse)', false);
  const canPaste = useCanReadClipboard();
  const effectiveFontSize = fontSize ?? (isDesktop ? DESKTOP_FONT_SIZE : PHONE_FONT_SIZE);
  const showKeyBar = !readOnly && (keyBar === true || (keyBar === 'auto' && (!isDesktop || coarsePointer)));
  const serverName = useOptionalShellData()?.server.name ?? serverNameProp ?? 'le serveur';

  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<ViewActions | null>(null);
  const settingsRef = useRef({ fontSize: effectiveFontSize, label, onExit, onStateChange, autoFocus });
  const [status, setStatus] = useState<TerminalConnectionStatus>(INITIAL_STATUS);
  const [announcement, setAnnouncement] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [inputIssue, setInputIssue] = useState(false);

  useEffect(() => {
    settingsRef.current = { fontSize: effectiveFontSize, label, onExit, onStateChange, autoFocus };
  }, [effectiveFontSize, label, onExit, onStateChange, autoFocus]);

  // --- Terminal + connection lifecycle --------------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    const root = rootRef.current;
    if (!host || !root) return;
    const life = { cancelled: false };
    const cleanups: Array<() => void> = [];

    void (async () => {
      let modules: [
        typeof import('@xterm/xterm'),
        typeof import('@xterm/addon-fit'),
        typeof import('@xterm/addon-unicode11'),
        typeof import('@xterm/addon-web-links'),
      ];
      try {
        // Client only, on demand: xterm never runs during SSR.
        modules = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
          import('@xterm/addon-unicode11'),
          import('@xterm/addon-web-links'),
        ]);
      } catch {
        if (!life.cancelled) {
          setLoadFailed(true);
          setAnnouncement("Le terminal n'a pas pu se charger.");
        }
        return;
      }
      if (life.cancelled) return;
      const [{ Terminal }, { FitAddon }, { Unicode11Addon }, { WebLinksAddon }] = modules;
      Terminal.strings.promptLabel = 'Saisie du terminal';
      Terminal.strings.tooMuchOutput = 'Trop de sortie à annoncer : parcourez les lignes du terminal.';

      const fontFamily = readMonoFontFamily(root);
      await waitForFont(fontFamily, settingsRef.current.fontSize);
      if (life.cancelled) return;

      const lineHeightOf = (size: number) =>
        xtermLineHeight(lineHeightFor(size), measureCharHeight(fontFamily, size, host), window.devicePixelRatio || 1);
      const term: XTerm = new Terminal({
        allowProposedApi: true,
        fontFamily,
        fontSize: settingsRef.current.fontSize,
        lineHeight: lineHeightOf(settingsRef.current.fontSize),
        theme: readTerminalTheme(root) ?? undefined,
        cursorBlink: !prefersReducedMotion(),
        cursorStyle: 'block',
        cursorInactiveStyle: 'outline',
        scrollback: 5_000,
        smoothScrollDuration: 0,
        disableStdin: readOnly,
        drawBoldTextInBrightColors: false,
        minimumContrastRatio: 1,
        scrollOnUserInput: true,
        rightClickSelectsWord: isApplePlatform(),
        linkHandler: { activate: (_event, text) => openExternal(text), allowNonHttpProtocols: false },
      });
      cleanups.push(() => term.dispose());
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = '11';
      term.loadAddon(new WebLinksAddon((_event, uri) => openExternal(uri)));
      term.open(host);
      const setLabel = (value: string) => term.textarea?.setAttribute('aria-label', `Saisie · ${value}`);
      setLabel(settingsRef.current.label);

      const clientId = terminalClientId();
      /** Last size known for the PTY (snapshot or terminal.resize). */
      /** (ptySize) Last size known for the PTY (snapshot or terminal.resize).
       *  (followingRemote) Another client resized the PTY: this tab shows its grid until it takes the keyboard back. */
      const local: {
        ptySize: TerminalSize | null;
        followingRemote: boolean;
        resizeTimer: ReturnType<typeof setTimeout> | null;
        previous: typeof INITIAL_STATUS;
      } = { ptySize: null, followingRemote: false, resizeTimer: null, previous: INITIAL_STATUS };

      const measure = (): TerminalSize | null => {
        if (!host.isConnected || host.clientWidth < 40 || host.clientHeight < 20) return null;
        return clampSize(fit.proposeDimensions());
      };

      const batcher = new InputBatcher({
        send: (data) => postTerminalJson(input, { data }),
        onError: () => {
          if (!life.cancelled) setInputIssue(true);
        },
      });
      cleanups.push(() => batcher.dispose());

      const connection: TerminalConnection = new TerminalConnection({
        streamUrl: stream,
        terminalId,
        onSnapshot: ({ data, cols, rows }) => {
          // A fresh copy of the screen: repaint from scratch at the PTY's size, then take our size back.
          term.reset();
          local.ptySize = { cols, rows };
          if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
          term.write(data, () => {
            if (!life.cancelled && !readOnly && document.visibilityState === 'visible') fitAndClaim();
          });
        },
        onData: (data) => term.write(data),
        onResize: (size) => {
          local.ptySize = size;
          if (size.cols !== term.cols || size.rows !== term.rows) {
            term.resize(size.cols, size.rows);
            local.followingRemote = true;
          }
        },
        onExit: ({ exitCode }) => settingsRef.current.onExit?.(exitCode),
        onStatus: (next) => {
          if (life.cancelled) return;
          if (next.state !== local.previous.state) {
            const text = stateAnnouncement(next.state, { exitCode: next.exitCode, error: next.error, wasLive: local.previous.wasLive });
            if (text) setAnnouncement(text);
            if (next.state === 'live' && !local.previous.wasLive && settingsRef.current.autoFocus) term.focus();
          }
          local.previous = next;
          setStatus(next);
        },
      });
      cleanups.push(() => connection.dispose());

      const reportSize = (size: TerminalSize) => {
        if (local.resizeTimer) clearTimeout(local.resizeTimer);
        local.resizeTimer = setTimeout(() => {
          local.resizeTimer = null;
          if (life.cancelled || connection.current.state !== 'live' || sameSize(size, local.ptySize)) return;
          void postTerminalJson(resize, { cols: size.cols, rows: size.rows, clientId }).catch(() => undefined);
        }, RESIZE_DEBOUNCE_MS);
      };
      cleanups.push(() => {
        if (local.resizeTimer) clearTimeout(local.resizeTimer);
      });
      /** This tab takes the size: local grid now, PTY shortly after (the last client that resizes wins). */
      function fitAndClaim() {
        if (readOnly) return;
        const size = measure();
        if (!size) return;
        local.followingRemote = false;
        if (size.cols !== term.cols || size.rows !== term.rows) term.resize(size.cols, size.rows);
        reportSize(size);
      }

      const sendInput = (data: string) => {
        if (readOnly || connection.current.state !== 'live') return;
        if (local.followingRemote) fitAndClaim();
        setInputIssue(false);
        batcher.push(data);
      };
      term.onData(sendInput);

      // Échap typed in the terminal belongs to the terminal: Radix listens on `document` (capture)
      // and would close the surrounding Sheet / window first (the login procedure with it). Taken
      // at the window (capture), before anyone else, and sent to the PTY here.
      const onEscapeCapture = (event: KeyboardEvent) => {
        if (readOnly || event.key !== 'Escape' || event.isComposing || event.target !== term.textarea) return;
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        event.stopPropagation();
        event.preventDefault();
        term.scrollToBottom();
        sendInput(keySequence('escape'));
      };
      window.addEventListener('keydown', onEscapeCapture, true);
      cleanups.push(() => window.removeEventListener('keydown', onEscapeCapture, true));

      const isMac = isApplePlatform();
      term.attachCustomKeyEventHandler((event) => {
        const action = clipboardShortcut(event, { isMac, hasSelection: term.hasSelection() });
        if (action === 'copy') {
          if (event.type === 'keydown') {
            event.preventDefault();
            const text = term.getSelection();
            if (text) {
              copyText(text);
              // Ctrl+C copies once; the next Ctrl+C is the terminal's again.
              if (!event.shiftKey && event.key.toLowerCase() === 'c') term.clearSelection();
            }
          }
          return false;
        }
        // Paste: leave it to the browser (`paste` event), xterm turns it into (bracketed) input.
        return action !== 'paste';
      });

      const onFocus = () => fitAndClaim();
      term.textarea?.addEventListener('focus', onFocus);
      cleanups.push(() => term.textarea?.removeEventListener('focus', onFocus));

      const raf = { frame: 0 };
      const observer = new ResizeObserver(() => {
        cancelAnimationFrame(raf.frame);
        raf.frame = requestAnimationFrame(() => {
          if (life.cancelled) return;
          if (!readOnly && connection.current.state === 'live') {
            fitAndClaim();
            return;
          }
          // Not ours to resize the PTY: keep its grid; before the first screen, just fill the panel.
          if (!local.ptySize) {
            const size = measure();
            if (size && (size.cols !== term.cols || size.rows !== term.rows)) term.resize(size.cols, size.rows);
          }
        });
      });
      observer.observe(host);
      cleanups.push(() => {
        cancelAnimationFrame(raf.frame);
        observer.disconnect();
      });

      // Fonts that finish loading later change the cell size: measure again.
      const onFontsDone = () => {
        if (life.cancelled) return;
        term.options.fontFamily = fontFamily;
        term.options.lineHeight = lineHeightOf(term.options.fontSize ?? settingsRef.current.fontSize);
        if (connection.current.state === 'live') fitAndClaim();
      };
      document.fonts?.addEventListener?.('loadingdone', onFontsDone);
      cleanups.push(() => document.fonts?.removeEventListener?.('loadingdone', onFontsDone));

      // Offline: show the loss at once. Back online / visible again: do not wait for the back-off.
      const nudge = () => {
        if (document.visibilityState === 'visible') connection.nudge();
      };
      const drop = () => connection.drop();
      window.addEventListener('online', nudge);
      window.addEventListener('offline', drop);
      document.addEventListener('visibilitychange', nudge);
      cleanups.push(() => {
        window.removeEventListener('online', nudge);
        window.removeEventListener('offline', drop);
        document.removeEventListener('visibilitychange', nudge);
      });

      const initial = measure();
      if (initial) term.resize(initial.cols, initial.rows);

      actionsRef.current = {
        applyFont: (size) => {
          if (term.options.fontSize === size) return;
          term.options.fontSize = size;
          term.options.lineHeight = lineHeightOf(size);
          if (connection.current.state === 'live') fitAndClaim();
        },
        sendKey: (key) => {
          if (readOnly || connection.current.state !== 'live') return;
          term.scrollToBottom();
          batcher.push(keySequence(key, { applicationCursor: term.modes.applicationCursorKeysMode }));
        },
        paste: () => {
          if (readOnly || connection.current.state !== 'live' || !navigator.clipboard?.readText) return;
          void (async () => {
            try {
              const text = await navigator.clipboard.readText();
              if (text && !life.cancelled) term.paste(text);
            } catch {
              // clipboard refused (permission): nothing to paste
            }
          })();
        },
        retry: () => connection.retryNow(),
        setLabel,
      };
      connection.start();
    })();

    return () => {
      life.cancelled = true;
      actionsRef.current = null;
      while (cleanups.length) {
        try {
          cleanups.pop()?.();
        } catch {
          // a failing disposer never blocks the others
        }
      }
    };
  // eslint-disable-next-line react/exhaustive-effect-dependencies -- reloadKey forces a reconnection
  }, [terminalId, stream, input, resize, readOnly, reloadKey]);

  // Font size follows the layout (desktop 13 / phone 11) without recreating the terminal.
  useEffect(() => {
    actionsRef.current?.applyFont(effectiveFontSize);
  }, [effectiveFontSize]);

  useEffect(() => {
    actionsRef.current?.setLabel(label);
  }, [label]);

  // Transient « saisie non transmise » notice.
  useEffect(() => {
    if (!inputIssue) return;
    const timer = setTimeout(() => setInputIssue(false), 5_000);
    return () => clearTimeout(timer);
  }, [inputIssue]);

  const state: TerminalViewState = loadFailed ? 'error' : status.state;
  useEffect(() => {
    settingsRef.current.onStateChange?.(state);
  }, [state]);

  const reconnecting = status.state === 'reconnecting';
  const showLost = useDelayedFlag(reconnecting && status.wasLive, 1_500);
  const firstConnect = !loadFailed && (status.state === 'connecting' || (reconnecting && !status.wasLive));

  const retry = useCallback(() => {
    if (loadFailed) {
      setLoadFailed(false);
      setStatus(INITIAL_STATUS);
      setReloadKey((key) => key + 1);
      return;
    }
    actionsRef.current?.retry();
  }, [loadFailed]);

  let bar: { tone: StatusTone; text: ReactNode; action?: ReactNode } | null = null;
  if (loadFailed) {
    bar = {
      tone: 'danger',
      text: "Le terminal n'a pas pu se charger dans ce navigateur.",
      action: (
        <CompactButton variant="discret" icon="refresh" onClick={retry}>
          Réessayer
        </CompactButton>
      ),
    };
  } else if (status.state === 'exited') {
    bar = { tone: status.exitCode === 0 ? 'success' : status.exitCode === null ? 'neutral' : 'danger', text: exitText(status.exitCode) };
  } else if (status.state === 'error') {
    bar = { tone: 'danger', text: errorText(status.error ?? 'closed') };
  } else if (showLost) {
    bar = {
      tone: 'warn',
      text: (
        <>
          {status.runnerDown ? `${serverName} ne répond pas` : 'Connexion au terminal perdue'} ·{' '}
          <RetryCountdown nextRetryAt={status.nextRetryAt} />
        </>
      ),
      action: (
        <CompactButton variant="discret" onClick={retry}>
          Réessayer maintenant
        </CompactButton>
      ),
    };
  } else if (inputIssue && status.state === 'live') {
    bar = { tone: 'warn', text: 'Saisie non transmise : vérifiez la connexion, puis retapez.' };
  }

  // 7 keys of 44 px fit a 390 px phone (Échap, Ctrl+C, Tab, arrows); « Coller » scrolls in when it does not fit.
  const keyClasses = cn(
    'inline-flex h-11 min-w-11 flex-1 shrink-0 items-center justify-center whitespace-nowrap rounded-sm border border-border bg-surface-raised px-1',
    'text-text select-none hover:bg-hover active:bg-pressed disabled:opacity-40',
  );
  const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault();

  return (
    <div
      ref={rootRef}
      data-tone="dark"
      data-terminal-state={state}
      role="group"
      aria-label={label}
      aria-busy={state === 'connecting' || undefined}
      className={cn(
        'relative flex min-h-60 min-w-0 flex-col overflow-hidden rounded-md bg-bg text-text',
        // xterm.css paints its viewport black: at a fractional offset (centred dialog) it shows as 1 px lines.
        '[&_.xterm-viewport]:bg-transparent!',
        'ring-1 ring-transparent focus-within:ring-accent',
        className,
      )}
    >
      <div className="relative min-h-0 flex-1">
        <div
          ref={hostRef}
          className={cn(
            'absolute inset-3 nav:inset-x-5 nav:inset-y-4',
            'transition-opacity duration-(--dur-fast)',
            showLost && 'opacity-50',
          )}
        />
        {firstConnect ? (
          <div className="absolute inset-0 flex items-center justify-center bg-bg p-6">
            <div className="flex flex-col items-center gap-3 text-center">
              <p className="m-0 flex items-center gap-2 font-mono text-app-12 text-muted">
                {status.state === 'connecting' ? (
                  <>
                    <Spinner size={14} />
                    Connexion au terminal…
                  </>
                ) : (
                  <>
                    <StatusDot tone="warn" />
                    <span>
                      {status.runnerDown ? `${serverName} ne répond pas` : 'Connexion au terminal impossible'} ·{' '}
                      <RetryCountdown nextRetryAt={status.nextRetryAt} />
                    </span>
                  </>
                )}
              </p>
              {reconnecting ? (
                <CompactButton variant="discret" onClick={retry}>
                  Réessayer maintenant
                </CompactButton>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      {bar ? (
        <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3 py-1 nav:px-5">
          <p className="m-0 flex min-w-0 flex-1 items-center gap-2 py-1.5 font-mono text-app-12 text-muted">
            <StatusDot tone={bar.tone} />
            <span className="min-w-0">{bar.text}</span>
          </p>
          {bar.action}
        </div>
      ) : null}
      {showKeyBar ? (
        <div role="toolbar" aria-label="Touches du terminal" className="flex shrink-0 gap-1 overflow-x-auto border-t border-border px-1.5 py-1.5">
          {KEY_BAR.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-label={item.ariaLabel}
              disabled={state !== 'live'}
              // Keep the focus (and the phone keyboard) on the terminal.
              onPointerDown={keepFocus}
              onMouseDown={keepFocus}
              onClick={() => actionsRef.current?.sendKey(item.key)}
              className={cn(keyClasses, 'font-mono text-app-11')}
            >
              {item.label}
            </button>
          ))}
          {canPaste ? (
            <button
              type="button"
              disabled={state !== 'live'}
              onPointerDown={keepFocus}
              onMouseDown={keepFocus}
              onClick={() => actionsRef.current?.paste()}
              className={cn(keyClasses, 'flex-none px-3 font-sans text-app-13')}
            >
              Coller
            </button>
          ) : null}
        </div>
      ) : null}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </div>
  );
}
