'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import {
  DictationController,
  IDLE_DICTATION,
  WEB_PLATFORM,
  detectDictation,
  dictationErrorCode,
  dictationErrorText,
  dictationLanguages,
  dictationPlatform,
  dictationRetryable,
  requestMicrophone,
  speechRecognitionOf,
  unavailableReason,
  type DictationAvailability,
  type DictationErrorCode,
  type DictationPlatform,
  type DictationSnapshot,
} from './dictation';
import type { useComposer } from './use-composer';

/** The privacy notice is shown once per browser (a convenience: a blocked storage shows it again). */
const NOTICE_KEY = 'nuera.dictation.notice';

function noticeSeen(): boolean {
  try {
    return window.localStorage.getItem(NOTICE_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberNotice(): void {
  try {
    window.localStorage.setItem(NOTICE_KEY, '1');
  } catch {
    // private window, blocked storage: shown again next time
  }
}

const noSubscription = () => () => undefined;
const detectInBrowser = (): DictationAvailability => detectDictation(window as unknown as Parameters<typeof detectDictation>[0]);
const pendingOnServer = (): DictationAvailability => 'pending';
// Snapshot read by useSyncExternalStore: one stable object per page (the platform does not change).
let browserPlatform: DictationPlatform | null = null;
const platformInBrowser = (): DictationPlatform => (browserPlatform ??= dictationPlatform(window));
const platformOnServer = (): DictationPlatform => WEB_PLATFORM;

/**
 * The page holds the microphone (asked once by `requestMicrophone`, granted): later dictations start the
 * recognition directly. Per page load, like the browser's own grant on iOS.
 */
let microphoneGranted = false;

/** `Ctrl/⌘ + Maj + Espace` toggles the dictation in a desktop composer. */
export function isDictationShortcut(event: { key: string; code?: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  const space = event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar';
  return space && event.shiftKey && (event.ctrlKey || event.metaKey) && !event.altKey;
}

export interface UseDictationOptions {
  /** The textarea the dictated text goes into (caret, focus). */
  fieldRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  setValue: (value: string) => void;
  /** The field does not accept text right now (permission pending, reconnection…): no dictation. */
  disabled?: boolean;
  /** Give the focus to the field when the dictation starts (desktop; on a phone it would open the keyboard). */
  focusOnStart?: boolean;
}

export interface Dictation {
  availability: DictationAvailability;
  /** Why the button cannot work in this browser (null when it can). */
  unavailable: string | null;
  disabled: boolean;
  listening: boolean;
  /** Stop asked, last words still arriving. */
  stopping: boolean;
  interim: string;
  /** The microphone prompt is open (first dictation of the page). */
  asking: boolean;
  error: DictationErrorCode | null;
  errorText: string | null;
  /** « Réessayer » can help (false: a setting must change first, or the installed app cannot dictate). */
  retryable: boolean;
  /** The unavailable reason was asked for (tap on the disabled button: phones have no tooltip). */
  reasonShown: boolean;
  /** One-time privacy notice. */
  notice: boolean;
  toggle: () => void;
  stop: () => void;
  /** Stops and drops the unsettled words (before a send). */
  cancel: () => void;
  retry: () => void;
  dismissNotice: () => void;
  /** Échap stops, Ctrl/⌘+Maj+Espace toggles; returns true when the key was used. */
  handleKeyDown: (event: KeyboardEvent<HTMLElement>) => boolean;
  /** On the composer root: focus leaving the composer stops the dictation. */
  onBlur: (event: FocusEvent<HTMLElement>) => void;
}

/**
 * Browser dictation bound to a composer field (see `dictation.ts`). Detection runs after mount
 * (`pending` on the server), the text is only ever inserted, never sent.
 */
export function useDictation({ fieldRef, value, setValue, disabled = false, focusOnStart = false }: UseDictationOptions): Dictation {
  const availability = useSyncExternalStore(noSubscription, detectInBrowser, pendingOnServer);
  const platform = useSyncExternalStore(noSubscription, platformInBrowser, platformOnServer);
  const [snapshot, setSnapshot] = useState<DictationSnapshot>(IDLE_DICTATION);
  const [asking, setAsking] = useState(false);
  const askingRef = useRef(false);
  const mounted = useRef(true);
  const [reasonShown, setReasonShown] = useState(false);
  const [notice, setNotice] = useState(false);
  const controllerRef = useRef<DictationController | null>(null);
  // Field content as last known (written synchronously by the controller, then by each render).
  const latest = useRef({ value, setValue, focusOnStart });
  useEffect(() => {
    latest.current = { value, setValue, focusOnStart };
  }, [value, setValue, focusOnStart]);

  const controller = useCallback((): DictationController | null => {
    if (controllerRef.current) return controllerRef.current;
    const Ctor = speechRecognitionOf(window as unknown as Parameters<typeof speechRecognitionOf>[0]);
    if (!Ctor) return null;
    controllerRef.current = new DictationController({
      create: () => new Ctor(),
      languages: dictationLanguages(navigator.language),
      onChange: setSnapshot,
      classify: (error) => dictationErrorCode(error, platformInBrowser()),
      target: {
        read: () => {
          const field = fieldRef.current;
          const focused = Boolean(field) && field === document.activeElement;
          return {
            value: latest.current.value,
            selection: focused && field ? { start: field.selectionStart, end: field.selectionEnd } : null,
          };
        },
        write: (next, caret) => {
          latest.current = { ...latest.current, value: next };
          latest.current.setValue(next);
          window.requestAnimationFrame(() => {
            const field = fieldRef.current;
            if (field && field === document.activeElement) field.setSelectionRange(caret, caret);
          });
        },
      },
    });
    return controllerRef.current;
  }, [fieldRef]);

  const unavailable = unavailableReason(availability, platform);
  const blocked = disabled || availability !== 'supported';

  const toggle = useCallback(() => {
    if (unavailable) {
      setReasonShown(true);
      return;
    }
    if (blocked || askingRef.current) return;
    const ctl = controller();
    if (!ctl) return;
    if (ctl.active) {
      ctl.toggle();
      return;
    }
    if (!noticeSeen()) {
      rememberNotice();
      setNotice(true);
    }
    const field = fieldRef.current;
    if (latest.current.focusOnStart && field && field !== document.activeElement) {
      field.focus();
      const end = field.value.length;
      field.setSelectionRange(end, end);
    }
    if (microphoneGranted) {
      ctl.start();
      return;
    }
    // First dictation of the page: ask the microphone explicitly (the OS prompt shows now), release it,
    // then start the recognition — or say precisely why it cannot (refused, blocked, busy…).
    askingRef.current = true;
    setAsking(true);
    ctl.clearError();
    void requestMicrophone(navigator as unknown as Parameters<typeof requestMicrophone>[0]).then((result) => {
      askingRef.current = false;
      if (!mounted.current) return;
      setAsking(false);
      if (result === 'granted') microphoneGranted = true;
      if (result === 'granted' || result === 'unknown') ctl.start();
      else ctl.fail(result);
    });
  }, [blocked, controller, fieldRef, unavailable]);

  const stop = useCallback(() => controllerRef.current?.stop(), []);
  const cancel = useCallback(() => controllerRef.current?.cancel(), []);
  const retry = useCallback(() => {
    controllerRef.current?.clearError();
    toggle();
  }, [toggle]);
  const dismissNotice = useCallback(() => setNotice(false), []);

  // The field stops accepting text (permission request, reconnection): stop listening.
  useEffect(() => {
    if (disabled) controllerRef.current?.stop();
  }, [disabled]);

  // Leaving the page (tab hidden, phone locked) stops the dictation; unmounting drops it. No
  // window `blur`: the browser's microphone prompt can fire one before the first word.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') controllerRef.current?.stop();
    };
    mounted.current = true;
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      mounted.current = false;
      document.removeEventListener('visibilitychange', onHidden);
      controllerRef.current?.dispose();
    };
  }, []);

  const active = snapshot.status !== 'idle';

  // Échap in the field stops the dictation, and only that: Radix dialogs listen on `document` in
  // the capture phase (they would close), the composer would interrupt Claude. `window` capture
  // runs first.
  useEffect(() => {
    if (!active) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.target !== fieldRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      controllerRef.current?.stop();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, fieldRef]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>): boolean => {
      if (isDictationShortcut(event)) {
        event.preventDefault();
        toggle();
        return true;
      }
      if (event.key === 'Escape' && active) {
        event.preventDefault();
        event.stopPropagation();
        controllerRef.current?.stop();
        return true;
      }
      return false;
    },
    [active, toggle],
  );

  const onBlur = useCallback((event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && !event.currentTarget.contains(next)) controllerRef.current?.stop();
  }, []);

  return {
    availability,
    unavailable,
    disabled: disabled || availability === 'pending',
    listening: snapshot.status === 'listening',
    stopping: snapshot.status === 'stopping',
    interim: snapshot.interim,
    asking,
    error: snapshot.error,
    errorText: snapshot.error ? dictationErrorText(snapshot.error, platform) : null,
    retryable: snapshot.error ? dictationRetryable(snapshot.error) : false,
    reasonShown: reasonShown && Boolean(unavailable),
    notice,
    toggle,
    stop,
    cancel,
    retry,
    dismissNotice,
    handleKeyDown,
    onBlur,
  };
}

/**
 * Dictation of a `useComposer` field: its key handler (Échap stops the dictation before it would
 * interrupt Claude, the shortcut toggles it) and its send, which drops the dictation first — what
 * is sent is exactly what the field shows.
 */
export function useComposerDictation(composer: ReturnType<typeof useComposer>, { focusOnStart = false } = {}) {
  const { innerRef, value, setValue, accepts, canSend, submit: send, onKeyDown: composerKeyDown } = composer;
  const dictation = useDictation({ fieldRef: innerRef, value, setValue, disabled: !accepts, focusOnStart });
  const { cancel, handleKeyDown } = dictation;

  const submit = useCallback(() => {
    if (canSend) cancel();
    return send();
  }, [canSend, cancel, send]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (handleKeyDown(event)) return;
      const composing = event.nativeEvent.isComposing || event.keyCode === 229;
      if (!composing && event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && canSend) cancel();
      composerKeyDown(event);
    },
    [canSend, cancel, composerKeyDown, handleKeyDown],
  );

  return { dictation, submit, onKeyDown };
}
