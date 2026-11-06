'use client';

import { useRef } from 'react';
import { Textarea, type TextareaProps } from '@/components/ui';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { cn } from '@/lib/cn';
import { PalettePanel } from './CommandPalette';
import { DictationButton, DictationStatus } from './DictationButton';
import { useDictation } from './use-dictation';
import { usePaletteTrigger, type PaletteSource } from './use-palette';

export interface DictatedTextareaProps extends Omit<TextareaProps, 'value' | 'onChange' | 'ref'> {
  value: string;
  onValueChange: (value: string) => void;
  /** `/` at the start of the text opens the palette of the composers (inserts, never sends). */
  palette?: PaletteSource;
}

/**
 * `Textarea` (inside a `Field`) for an instruction to Claude typed outside the Workspace (first
 * instruction of a new session), with the browser dictation of the composers: microphone in the
 * bottom-right corner of the field, state line under it; optionally the `/` palette.
 */
export function DictatedTextarea({
  value,
  onValueChange,
  disabled,
  readOnly,
  className,
  onKeyDown,
  palette,
  ...rest
}: DictatedTextareaProps) {
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const finePointer = useMediaQuery('(pointer: fine)', true);
  const dictation = useDictation({
    fieldRef,
    value,
    setValue: onValueChange,
    disabled: Boolean(disabled || readOnly),
    focusOnStart: finePointer,
  });
  const trigger = usePaletteTrigger({
    source: palette,
    fieldRef,
    value,
    setValue: onValueChange,
    disabled: Boolean(disabled || readOnly),
  });
  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5" onBlur={dictation.onBlur}>
      <div className="relative">
        {trigger.open ? (
          <PalettePanel
            results={trigger.results}
            active={trigger.active}
            onActive={trigger.setActive}
            onChoose={trigger.choose}
            listboxId={trigger.listboxId}
            optionId={trigger.optionId}
            touch={!finePointer}
            className="top-full bottom-auto mt-1 mb-0"
          />
        ) : null}
        <Textarea
          {...rest}
          ref={fieldRef}
          value={value}
          disabled={disabled}
          readOnly={readOnly}
          onChange={(event) => onValueChange(event.target.value)}
          onSelect={trigger.syncCaret}
          onClick={trigger.syncCaret}
          onFocus={trigger.syncCaret}
          {...(trigger.open
            ? {
                role: 'combobox',
                'aria-expanded': true,
                'aria-controls': trigger.listboxId,
                'aria-autocomplete': 'list' as const,
                'aria-activedescendant': trigger.results.items.length
                  ? trigger.optionId(trigger.active)
                  : undefined,
              }
            : {})}
          onKeyDown={(event) => {
            if (trigger.handleKeyDown(event)) return;
            if (dictation.handleKeyDown(event)) return;
            onKeyDown?.(event);
          }}
          className={cn('pr-10', className)}
        />
        <div className="absolute right-1 bottom-1">
          <DictationButton dictation={dictation} size="sm" shortcut={finePointer} />
        </div>
      </div>
      <DictationStatus dictation={dictation} />
    </div>
  );
}
