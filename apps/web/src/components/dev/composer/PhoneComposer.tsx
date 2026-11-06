'use client';

import type { Ref } from 'react';
import { IconButton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useAutoGrow } from '../hooks/use-auto-grow';
import { useKeyboardInset } from '../hooks/use-keyboard-inset';
import { SEND_DISABLED_CLASSES } from './Composer';
import { DictationButton, DictationStatus } from './DictationButton';
import { useComposer, type ComposerState } from './use-composer';
import { useComposerDictation } from './use-dictation';

/** Phone placeholders (M05 « Répondez d'abord à la demande… », S2 « Demander une correction à Claude… »). */
export const PHONE_COMPOSER_PLACEHOLDER: Record<ComposerState, string> = {
  ready: 'Écrire une instruction à Claude…',
  running: 'Ajouter une précision pour Claude…',
  waiting_permission: "Répondez d'abord à la demande…",
  reconnecting: 'Saisie suspendue…',
  unavailable: 'Saisie indisponible…',
};

export interface PhoneComposerProps {
  state: ComposerState;
  onSubmit: (text: string) => void | Promise<unknown>;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  disabledReason?: string | null;
  sending?: boolean;
  /** Attachment picker; omitted → no paperclip. */
  onAttach?: () => void;
  /**
   * Follow the on-screen keyboard (S1): the bottom safe-area spacer collapses while it is up.
   * The page keeps the composer pinned (100dvh + `interactive-widget=resizes-content`, or
   * `useKeyboardInset().inset` on iOS).
   */
  keyboardAware?: boolean;
  /** Max height of the growing field (px). Default 120 (≈ 5 lines). */
  maxHeight?: number;
  textareaRef?: Ref<HTMLTextAreaElement>;
  label?: string;
  className?: string;
}

/**
 * Phone `Saisie` (M05, S1, S2 — states-mobile-and-extensions.md §2.4): attach 44 · pill field 44 ·
 * send 44, then the home-indicator safe area. Enter sends (the keyboard shows « envoyer »).
 */
export function PhoneComposer({
  state,
  onSubmit,
  value,
  defaultValue,
  onValueChange,
  placeholder,
  disabledReason,
  sending,
  onAttach,
  keyboardAware = true,
  maxHeight = 120,
  textareaRef,
  label = 'Instruction pour Claude',
  className,
}: PhoneComposerProps) {
  const composer = useComposer({ state, value, defaultValue, onValueChange, onSubmit, sending, textareaRef });
  useAutoGrow(composer.innerRef, composer.value, maxHeight);
  // No focus on start: it would open the on-screen keyboard over the thread.
  const { dictation, submit, onKeyDown } = useComposerDictation(composer);
  const keyboard = useKeyboardInset();
  const keyboardOpen = keyboardAware && keyboard.open;
  const blocked = !composer.accepts;
  const shownPlaceholder =
    placeholder ?? ((state === 'unavailable' && disabledReason) || PHONE_COMPOSER_PLACEHOLDER[state]);

  return (
    <div
      data-keyboard={keyboardOpen ? 'open' : 'closed'}
      onBlur={dictation.onBlur}
      className={cn(
        'w-full border-t border-border bg-bg px-3 pt-2',
        keyboardOpen ? 'pb-0' : 'pb-[max(env(safe-area-inset-bottom),8px)]',
        className,
      )}
    >
      <DictationStatus dictation={dictation} className="px-1 pb-2" />
      <div className="flex items-end gap-1.5">
        {onAttach ? (
          <IconButton
            icon="paperclip"
            label="Joindre un fichier"
            iconClassName="text-muted"
            disabled={blocked}
            onClick={onAttach}
          />
        ) : null}
        <div
          className={cn(
            'flex min-h-11 min-w-0 flex-1 items-center rounded-[22px] border border-border bg-surface-raised px-3.5',
            'transition-[border-color,box-shadow] duration-(--dur-fast)',
            !blocked && 'focus-within:border-accent focus-within:ring-[0.5px] focus-within:ring-accent',
          )}
        >
          <textarea
            ref={composer.ref}
            rows={1}
            // eslint-disable-next-line react/refs -- false positive: useComposer returns plain values beside its refs, none is read from a ref
            value={composer.value}
            onChange={composer.onChange}
            onKeyDown={onKeyDown}
            placeholder={shownPlaceholder}
            readOnly={blocked}
            aria-disabled={blocked || undefined}
            aria-label={label}
            enterKeyHint="send"
            className={cn(
              // 11 + 20 + 11 inside the 1 px border: the pill is 44 px, like the send button (§2.4).
              'block w-full resize-none border-0 bg-transparent py-[11px] font-sans text-app-14 leading-5 text-text outline-none',
              'placeholder:truncate placeholder:text-muted focus-visible:outline-none',
              blocked && 'cursor-not-allowed text-muted',
            )}
          />
        </div>
        <DictationButton dictation={dictation} size="md" />
        <IconButton
          icon="send"
          label="Envoyer"
          variant="accent"
          loading={composer.busy}
          // eslint-disable-next-line react/refs -- false positive: useComposer returns plain values beside its refs, none is read from a ref
          disabled={!composer.canSend}
          onClick={() => void submit()}
          className={SEND_DISABLED_CLASSES}
        />
      </div>
    </div>
  );
}
