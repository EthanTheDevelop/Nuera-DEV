'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type Ref,
  type RefCallback,
} from 'react';

/** Composer state, mapped from the session (Figma `Dev · Compositeur` État = Prêt / En cours / Attente). */
export type ComposerState = 'ready' | 'running' | 'waiting_permission' | 'reconnecting' | 'unavailable';

/** Whether typing and sending are possible in this state (queued while running). */
export function composerAccepts(state: ComposerState): boolean {
  return state === 'ready' || state === 'running';
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') ref(value);
  else if (ref && typeof ref === 'object') (ref as { current: T | null }).current = value;
}

/**
 * Field content once an instruction is delivered. `sent` is the raw text that was submitted and
 * `current` what the field holds now: text typed while the send was in flight is kept (only the sent
 * part is removed); a sent text edited in the meantime is left untouched.
 */
export function draftAfterSend(sent: string, current: string): string {
  if (current === sent) return '';
  if (current.startsWith(sent)) return current.slice(sent.length).replace(/^\s+/, '');
  return current;
}

export interface UseComposerOptions {
  state: ComposerState;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  onSubmit: (text: string) => void | Promise<unknown>;
  onInterrupt?: () => void;
  sending?: boolean;
  textareaRef?: Ref<HTMLTextAreaElement>;
  /** Turns the typed text into what is sent (the `@<chemin>` of the pieces jointes appended). */
  prepareSubmit?: (text: string) => string;
  /** The instruction was delivered (pieces jointes cleared). */
  onDelivered?: () => void;
  /** Something besides the text can be sent (stored pieces jointes): an empty field may be sent. */
  canSendEmpty?: boolean;
  /** Sending must wait (pieces jointes still uploading). */
  sendBlocked?: boolean;
}

/**
 * Shared behaviour of the desktop and phone composers: controlled / uncontrolled text, Enter to send
 * (Shift+Enter = new line, IME-safe), Échap to interrupt while running, insertion of `/` and `@` at the
 * caret (the CLI handles slash commands and file mentions itself).
 */
export function useComposer({
  state,
  value: controlled,
  defaultValue = '',
  onValueChange,
  onSubmit,
  onInterrupt,
  sending = false,
  textareaRef,
  prepareSubmit,
  onDelivered,
  canSendEmpty = false,
  sendBlocked = false,
}: UseComposerOptions) {
  const [uncontrolled, setUncontrolled] = useState(defaultValue);
  const [submitting, setSubmitting] = useState(false);
  const value = controlled ?? uncontrolled;
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  // Latest field content, read when a send resolves (the owner may have kept typing meanwhile).
  const latestValue = useRef(value);
  useEffect(() => {
    latestValue.current = value;
  }, [value]);

  const setValue = useCallback(
    (next: string) => {
      if (controlled === undefined) setUncontrolled(next);
      onValueChange?.(next);
    },
    [controlled, onValueChange],
  );

  const ref: RefCallback<HTMLTextAreaElement> = useCallback(
    (node) => {
      innerRef.current = node;
      assignRef(textareaRef, node);
    },
    [textareaRef],
  );

  const accepts = composerAccepts(state);
  const busy = sending || submitting;
  const canSend = accepts && !busy && !sendBlocked && (value.trim().length > 0 || canSendEmpty);

  const submit = useCallback(async () => {
    if (!canSend) return;
    const sent = value;
    let result: void | Promise<unknown>;
    try {
      result = onSubmit(prepareSubmit ? prepareSubmit(sent.trim()) : sent.trim());
    } catch {
      // Keep the draft: the caller reports the error (T4 pattern) and the owner can resend.
      return;
    }
    let current = sent;
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      setSubmitting(true);
      let delivered = true;
      try {
        await result;
      } catch {
        delivered = false; // same as above: the draft stays for a resend
      } finally {
        setSubmitting(false);
      }
      if (!delivered) return;
      current = latestValue.current;
    }
    onDelivered?.();
    const next = draftAfterSend(sent, current);
    if (next !== current) setValue(next);
  }, [canSend, onDelivered, onSubmit, prepareSubmit, setValue, value]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        void submit();
        return;
      }
      if (event.key === 'Escape' && state === 'running' && onInterrupt) {
        event.preventDefault();
        onInterrupt();
      }
    },
    [onInterrupt, state, submit],
  );

  const onChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => setValue(event.target.value), [setValue]);

  /** Inserts `/` or `@` at the caret and gives the focus back to the field. */
  const insert = useCallback(
    (text: string) => {
      const el = innerRef.current;
      const start = el?.selectionStart ?? value.length;
      const end = el?.selectionEnd ?? value.length;
      setValue(value.slice(0, start) + text + value.slice(end));
      window.requestAnimationFrame(() => {
        const node = innerRef.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(start + text.length, start + text.length);
      });
    },
    [setValue, value],
  );

  return { value, setValue, ref, innerRef, accepts, busy, canSend, submit, onKeyDown, onChange, insert };
}
