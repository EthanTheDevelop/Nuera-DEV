'use client';

import type { Ref } from 'react';
import { Badge, CompactButton, IconButton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useAutoGrow } from '../hooks/use-auto-grow';
import { permissionModeText } from '../lib/permission';
import { attachmentSubmitOptions, useComposerTools, type ComposerTools } from './ComposerToolbar';
import { DictationButton, DictationStatus } from './DictationButton';
import { SessionPersistenceLine, type PersistenceText } from './SessionPersistenceLine';
import { useComposer, type ComposerState } from './use-composer';
import { useComposerDictation } from './use-dictation';

/** Placeholders of `Dev · Compositeur` (203:497) and W7, verbatim. */
export const COMPOSER_PLACEHOLDER: Record<ComposerState, string> = {
  ready: 'Écrire une instruction à Claude…',
  running: "Ajouter une précision pour Claude, elle sera lue à la fin de l'étape en cours…",
  waiting_permission: "Répondez d'abord à la demande d'autorisation ci-dessus…",
  reconnecting: 'Saisie suspendue pendant la reconnexion…',
  unavailable: 'Saisie indisponible pour cette session…',
};

/** Classes that give the send button its Figma disabled look (`--border` fill, white icon). */
export const SEND_DISABLED_CLASSES =
  'disabled:not-aria-busy:bg-border disabled:not-aria-busy:text-paper disabled:not-aria-busy:opacity-100 disabled:hover:bg-border';

export interface ComposerProps {
  /** `ready` (Prêt), `running` (En cours: queued + Interrompre), `waiting_permission` (Attente), `reconnecting` (W7), `unavailable`. */
  state: ComposerState;
  /** Sends the instruction to the CLI. A returned promise keeps the draft until it resolves. */
  onSubmit: (text: string) => void | Promise<unknown>;
  /** Current CLI permission mode label (« demander avant d'agir »). */
  modeLabel: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Overrides the state placeholder (S2: « Demander une correction à Claude… »). */
  placeholder?: string;
  /** `unavailable`: why typing is not possible (shown as placeholder and under a kept draft). */
  disabledReason?: string | null;
  /** Instruction being transmitted (spinner on Envoyer). */
  sending?: boolean;
  /** Sends Échap to the CLI (« Interrompre · Échap » while running, and the Échap key). */
  onInterrupt?: () => void;
  interrupting?: boolean;
  /** Attachment picker. Omitted → no paperclip (nothing is shown that does not work). */
  onAttach?: () => void;
  /**
   * Toolbar « comme un chat Claude Code » (Joindre, model and mode chips, « / » palette): replaces
   * the paperclip, the mode badge and the « / commandes · @ fichiers » hints.
   */
  tools?: ComposerTools;
  /** Persistence line under the box (see `persistenceText`); null hides it. */
  persistence?: PersistenceText | null;
  /** Keyboard hint of the persistence line (« Échap · interrompre »). */
  persistenceHint?: string | null;
  autoFocus?: boolean;
  /** Max height of the growing field before it scrolls (px). Default 200. */
  maxHeight?: number;
  textareaRef?: Ref<HTMLTextAreaElement>;
  /** Accessible name of the field. */
  label?: string;
  className?: string;
}

/**
 * `Dev · Compositeur` (203:497), desktop — « Saisie envoyée au CLI. En cours, l'envoi passe en file et
 * Interrompre envoie Échap au processus. En attente d'autorisation, la saisie est suspendue. »
 */
export function Composer({
  state,
  onSubmit,
  modeLabel,
  value: valueProp,
  defaultValue,
  onValueChange,
  placeholder,
  disabledReason,
  sending,
  onInterrupt,
  interrupting,
  onAttach,
  tools,
  persistence,
  persistenceHint = 'Échap · interrompre',
  autoFocus,
  maxHeight = 200,
  textareaRef,
  label = 'Instruction pour Claude',
  className,
}: ComposerProps) {
  const composer = useComposer({
    state,
    value: valueProp,
    defaultValue,
    onValueChange,
    onSubmit,
    onInterrupt,
    sending,
    textareaRef,
    ...attachmentSubmitOptions(tools?.attachments),
  });
  useAutoGrow(composer.innerRef, composer.value, maxHeight);
  const { dictation, submit, onKeyDown } = useComposerDictation(composer, { focusOnStart: true });
  const toolbar = useComposerTools(composer, tools, 'desktop');

  const blocked = !composer.accepts;
  const stateText = (state === 'unavailable' && disabledReason) || COMPOSER_PLACEHOLDER[state];
  const shownPlaceholder = placeholder ?? stateText;
  // A draft typed before the request arrived stays visible; the reason is then repeated under it.
  const blockedText = disabledReason ?? stateText;

  return (
    <div className={cn('relative flex w-full min-w-0 flex-col gap-2', className)} onBlur={dictation.onBlur}>
      {toolbar.panel}
      <div
        className={cn(
          'flex w-full min-w-0 flex-col gap-2.5 rounded-lg border border-border bg-bg py-3 pr-3 pl-4',
          'transition-[border-color,box-shadow] duration-(--dur-fast)',
          !blocked && 'focus-within:border-accent focus-within:ring-[0.5px] focus-within:ring-accent',
        )}
      >
        {toolbar.chips}
        <textarea
          ref={composer.ref}
          rows={1}
          // eslint-disable-next-line react/refs -- false positive: useComposer returns plain values beside its refs, none is read from a ref
          value={composer.value}
          onChange={composer.onChange}
          {...toolbar.fieldProps}
          onKeyDown={(event) => {
            if (toolbar.handleKeyDown(event)) return;
            onKeyDown(event);
          }}
          placeholder={shownPlaceholder}
          readOnly={blocked}
          aria-disabled={blocked || undefined}
          aria-label={label}
          autoFocus={autoFocus}
          enterKeyHint="send"
          spellCheck
          className={cn(
            'block w-full resize-none border-0 bg-transparent p-0 font-sans text-app-14 leading-5 text-text outline-none',
            'placeholder:text-muted focus-visible:outline-none',
            blocked && 'cursor-not-allowed text-muted',
          )}
        />
        {blocked && composer.value.trim() !== '' ? (
          <p className="m-0 font-sans text-app-12 text-muted">{blockedText}</p>
        ) : null}
        <DictationStatus dictation={dictation} />
        {toolbar.noteLine}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {tools ? (
            <div className="-ml-2 flex min-w-0 flex-1 items-center gap-1.5" data-composer-tools>
              {toolbar.left}
            </div>
          ) : null}
          {!tools && onAttach ? (
            <IconButton
              icon="paperclip"
              label="Joindre un fichier"
              size="sm"
              iconSize={18}
              iconClassName="text-muted"
              disabled={blocked}
              onClick={onAttach}
              className="-ml-2"
            />
          ) : null}
          {!tools ? (
          <Badge
            tone="neutral"
            title="Mode de permission du CLI pour cette session"
            className={onAttach ? undefined : '-ml-2'}
          >
            {permissionModeText(modeLabel)}
          </Badge>
          ) : null}
          {!tools ? (
          <div className="flex min-w-0 flex-1 items-center overflow-hidden font-mono text-app-11 whitespace-pre text-muted">
            {/* Accessible names start with the visible text (WCAG 2.5.3, voice control). */}
            <button
              type="button"
              disabled={blocked}
              onClick={() => composer.insert('/')}
              aria-label="/ commandes : insère / pour une commande du CLI"
              className="nu-hit shrink-0 hover:text-text disabled:cursor-not-allowed disabled:hover:text-muted"
            >
              / commandes
            </button>
            <span aria-hidden>{'  ·  '}</span>
            <button
              type="button"
              disabled={blocked}
              onClick={() => composer.insert('@')}
              aria-label="@ fichiers : insère @ pour mentionner un fichier"
              className="nu-hit min-w-0 truncate hover:text-text disabled:cursor-not-allowed disabled:hover:text-muted"
            >
              @ fichiers
            </button>
          </div>
          ) : null}
          {/* Narrow columns (tablet split, zoom): the actions wrap under the hints instead of overflowing. */}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {state === 'running' && onInterrupt ? (
              <CompactButton variant="secondaire" icon="stop" loading={interrupting} onClick={onInterrupt}>
                Interrompre · Échap
              </CompactButton>
            ) : null}
            <DictationButton dictation={dictation} size="sm" shortcut />
            <IconButton
              icon="send"
              label="Envoyer"
              variant="accent"
              size="sm"
              iconSize={18}
              loading={composer.busy}
              // eslint-disable-next-line react/refs -- false positive: useComposer returns plain values beside its refs, none is read from a ref
              disabled={!composer.canSend}
              onClick={() => void submit()}
              className={SEND_DISABLED_CLASSES}
            />
          </div>
        </div>
      </div>
      {persistence ? (
        <SessionPersistenceLine tone={persistence.tone} text={persistence.text} hint={persistenceHint} />
      ) : null}
    </div>
  );
}
