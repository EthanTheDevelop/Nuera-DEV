'use client';

import {
  useCallback,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { CompactButton } from '@/components/ui';
import { AttachButton, AttachmentChips } from './AttachmentChips';
import { withAttachmentReferences } from './attachments';
import { PaletteButton, PalettePanel } from './CommandPalette';
import { ComposerChip, type ComposerChipProps } from './ComposerChip';
import type { PaletteItem } from './palette';
import type { AttachmentsController } from './use-attachments';
import { insertFromButton, usePaletteTrigger, type PaletteSource } from './use-palette';

export type ComposerToolChip = Omit<ComposerChipProps, 'variant' | 'onBlockedTap' | 'icon'>;

/**
 * Toolbar of a composer « comme un chat Claude Code » — every part optional, none rendered without
 * its action: « Joindre » (pieces jointes uploaded to the worktree, sent as `@<chemin>`), the model
 * and permission-mode chips (what the CLI reports), « / » and the `/` `@` palette (inserts text).
 */
export interface ComposerTools {
  attachments?: AttachmentsController;
  /** Why files cannot be joined now (session without worktree…). */
  attachDisabledReason?: string | null;
  model?: ComposerToolChip;
  mode?: ComposerToolChip;
  palette?: PaletteSource;
}

interface ComposerLike {
  value: string;
  setValue: (value: string) => void;
  innerRef: { current: HTMLTextAreaElement | null };
  accepts: boolean;
}

/**
 * Wires the tools to a `useComposer` field: palette trigger on the field (keys, caret), paste of
 * files, the parts of the toolbar, the « why it is disabled » line of a tapped chip, and what
 * `useComposer` needs to send the pieces jointes with the text.
 */
export function useComposerTools(
  composer: ComposerLike,
  tools: ComposerTools | undefined,
  variant: 'desktop' | 'phone',
) {
  const { value, setValue, innerRef, accepts } = composer;
  const [note, setNote] = useState<string | null>(null);
  const caretRef = useRef<number | null>(null);
  const palette = usePaletteTrigger({
    source: tools?.palette,
    fieldRef: innerRef,
    value,
    setValue,
    disabled: !accepts,
  });
  const attachments = tools?.attachments;

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => palette.handleKeyDown(event),
    [palette],
  );

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      if (!attachments || !accepts || tools?.attachDisabledReason) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      attachments.add(files);
    },
    [accepts, attachments, tools?.attachDisabledReason],
  );

  const insertItem = useCallback(
    (item: PaletteItem) => {
      const next = insertFromButton(value, caretRef.current, item);
      setValue(next.value);
      window.requestAnimationFrame(() => {
        const el = innerRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(next.caret, next.caret);
      });
    },
    [innerRef, setValue, value],
  );

  const blockedTap = useCallback((reason: string) => setNote(reason), []);
  const blockedReason = accepts
    ? null
    : 'Saisie suspendue : rien ne peut être ajouté pour le moment.';

  const fieldProps = {
    onPaste,
    onSelect: palette.syncCaret,
    onClick: palette.syncCaret,
    onFocus: palette.syncCaret,
    ...(palette.open
      ? {
          role: 'combobox' as const,
          'aria-expanded': true,
          'aria-controls': palette.listboxId,
          'aria-autocomplete': 'list' as const,
          'aria-activedescendant': palette.results.items.length
            ? palette.optionId(palette.active)
            : undefined,
        }
      : {}),
  };

  const panel: ReactNode = palette.open ? (
    <PalettePanel
      results={palette.results}
      active={palette.active}
      onActive={palette.setActive}
      onChoose={palette.choose}
      listboxId={palette.listboxId}
      optionId={palette.optionId}
      notice={tools?.palette?.notice ?? null}
      touch={variant === 'phone'}
    />
  ) : null;

  const chips: ReactNode = attachments ? <AttachmentChips attachments={attachments} /> : null;

  const left: ReactNode = tools ? (
    <>
      {attachments ? (
        <AttachButton
          attachments={attachments}
          variant={variant}
          disabledReason={blockedReason ?? tools.attachDisabledReason ?? null}
          onBlockedTap={blockedTap}
        />
      ) : null}
      {tools.model ? (
        <ComposerChip {...tools.model} icon="cpu" variant={variant} onBlockedTap={blockedTap} />
      ) : null}
      {tools.mode ? (
        <ComposerChip {...tools.mode} icon="shield" variant={variant} onBlockedTap={blockedTap} />
      ) : null}
      {tools.palette ? (
        <PaletteButton
          source={tools.palette}
          variant={variant}
          onInsert={insertItem}
          disabledReason={blockedReason}
          onBlockedTap={blockedTap}
          onOpen={() => {
            caretRef.current = innerRef.current?.selectionStart ?? null;
          }}
        />
      ) : null}
    </>
  ) : null;

  const noteLine: ReactNode = note ? (
    <p
      className="m-0 flex min-w-0 flex-wrap items-center gap-x-2 font-sans text-app-12 text-muted"
      role="status"
    >
      <span className="min-w-0">{note}</span>
      <CompactButton variant="discret" onClick={() => setNote(null)}>
        Fermer
      </CompactButton>
    </p>
  ) : null;

  return { palette, handleKeyDown, fieldProps, panel, chips, left, noteLine };
}

/** What `useComposer` needs to send the pieces jointes with the text (`@<chemin>` appended, chips cleared once delivered). */
export function attachmentSubmitOptions(attachments: AttachmentsController | undefined) {
  if (!attachments) return {};
  return {
    prepareSubmit: (text: string) => withAttachmentReferences(text, attachments.paths),
    onDelivered: attachments.clear,
    canSendEmpty: attachments.paths.length > 0,
    sendBlocked: attachments.uploading,
  };
}
