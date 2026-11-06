'use client';

import { useRef } from 'react';
import { Textarea, type TextareaProps } from '@/components/ui';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { cn } from '@/lib/cn';
import { DictationButton, DictationStatus } from './DictationButton';
import { useDictation } from './use-dictation';

export interface DictatedTextareaProps extends Omit<TextareaProps, 'value' | 'onChange' | 'ref'> {
  value: string;
  onValueChange: (value: string) => void;
}

/**
 * `Textarea` (inside a `Field`) for an instruction to Claude typed outside the Workspace (first
 * instruction of a new session), with the browser dictation of the composers: microphone in the
 * bottom-right corner of the field, state line under it.
 */
export function DictatedTextarea({ value, onValueChange, disabled, readOnly, className, onKeyDown, ...rest }: DictatedTextareaProps) {
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const finePointer = useMediaQuery('(pointer: fine)', true);
  const dictation = useDictation({
    fieldRef,
    value,
    setValue: onValueChange,
    disabled: Boolean(disabled || readOnly),
    focusOnStart: finePointer,
  });
  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5" onBlur={dictation.onBlur}>
      <div className="relative">
        <Textarea
          {...rest}
          ref={fieldRef}
          value={value}
          disabled={disabled}
          readOnly={readOnly}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
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
