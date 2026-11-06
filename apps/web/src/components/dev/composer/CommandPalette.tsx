'use client';

import { useId, useState, type KeyboardEvent } from 'react';
import { Icon } from '@/components/icons';
import {
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Sheet,
  SheetContent,
  Spinner,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { PALETTE_COPY, PALETTE_GROUP_LABELS, type PaletteItem } from './palette';
import { usePaletteResults, type PaletteResults, type PaletteSource } from './use-palette';

export interface PaletteListProps {
  results: PaletteResults;
  active: number;
  onActive: (index: number) => void;
  onChoose: (item: PaletteItem) => void;
  listboxId: string;
  optionId: (index: number) => string;
  notice?: string | null;
  /** Rows of 44 px (phone). */
  touch?: boolean;
  className?: string;
}

/** Grouped listbox of the palette. Options never take the focus (the field or the search keeps it). */
export function PaletteList({
  results,
  active,
  onActive,
  onChoose,
  listboxId,
  optionId,
  notice,
  touch,
  className,
}: PaletteListProps) {
  const { items, loading, error } = results;
  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      {items.length === 0 ? (
        <p
          className="m-0 flex items-center gap-2 px-3 py-3 font-sans text-app-13 text-muted"
          role="status"
        >
          {loading ? <Spinner size={14} /> : null}
          {loading ? PALETTE_COPY.loadingFiles : (error ?? PALETTE_COPY.empty)}
        </p>
      ) : (
        <div
          id={listboxId}
          role="listbox"
          aria-label={PALETTE_COPY.title}
          className="flex min-h-0 flex-col overflow-y-auto overscroll-contain p-1"
        >
          {items.map((item, index) => {
            const header = index === 0 || items[index - 1]!.group !== item.group;
            return (
              <div key={item.id} role="presentation" className="flex flex-col">
                {header ? (
                  <span
                    aria-hidden
                    className="px-2.5 pt-2 pb-1 font-mono text-app-11 tracking-label text-muted uppercase"
                  >
                    {PALETTE_GROUP_LABELS[item.group]}
                  </span>
                ) : null}
                <div
                  id={optionId(index)}
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === active}
                  data-palette-item={item.id}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => onActive(index)}
                  onClick={() => onChoose(item)}
                  className={cn(
                    'flex cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-1.5 select-none',
                    touch ? 'min-h-11' : 'min-h-9',
                    index === active && 'bg-accent-pale',
                  )}
                >
                  <Icon
                    name={
                      item.group === 'files'
                        ? item.folder
                          ? 'folder'
                          : 'file'
                        : item.group === 'mcp'
                          ? 'plug'
                          : item.group === 'skills'
                            ? 'book'
                            : 'terminal'
                    }
                    size={16}
                    className="shrink-0 text-muted"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-app-13 text-text">{item.label}</span>
                    {item.description ? (
                      <span className="truncate font-sans text-app-12 text-muted">
                        {item.description}
                      </span>
                    ) : null}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {notice ? (
        <p className="m-0 border-t border-border px-3 py-2 font-sans text-app-12 text-muted">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

/** Panel opened by typing `/` or `@` in the field, above the composer box (no focus change). */
export function PalettePanel({ className, ...props }: PaletteListProps) {
  return (
    <div
      data-palette="inline"
      className={cn(
        'absolute right-0 bottom-full left-0 z-30 mb-2 flex max-h-[min(320px,45dvh)] flex-col overflow-hidden rounded-lg border border-border bg-bg shadow-float',
        className,
      )}
    >
      <PaletteList {...props} className="min-h-0 flex-1" />
      <p className="m-0 border-t border-border px-3 py-1.5 font-sans text-app-11 text-muted">
        {PALETTE_COPY.hint}
      </p>
    </div>
  );
}

export interface PaletteButtonProps {
  source: PaletteSource;
  /** Inserts the chosen item into the field (never sends). */
  onInsert: (item: PaletteItem) => void;
  variant: 'desktop' | 'phone';
  disabledReason?: string | null;
  onBlockedTap?: (reason: string) => void;
  /** Called before opening (the field's caret is kept for the insertion). */
  onOpen?: () => void;
}

/** « / » of the toolbar: searchable palette in a popover (desktop) or a sheet (phone). */
export function PaletteButton({
  source,
  onInsert,
  variant,
  disabledReason,
  onBlockedTap,
  onOpen,
}: PaletteButtonProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listboxId = useId();
  const kind = query.startsWith('@') ? '@' : '/';
  const results = usePaletteResults(source, open ? kind : null, query.replace(/^[@/]/, ''));
  const openWith = (next: boolean) => {
    if (next) onOpen?.();
    setOpen(next);
    setQuery('');
    setActive(0);
  };
  const choose = (item: PaletteItem) => {
    if (item.folder) {
      setQuery(item.insert);
      setActive(0);
      return;
    }
    onInsert(item);
    setOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const count = results.items.length;
    if (count === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => (event.key === 'ArrowDown' ? (i + 1) % count : (i - 1 + count) % count));
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      choose(results.items[Math.min(active, count - 1)]!);
    }
  };
  const blocked = Boolean(disabledReason);
  const trigger = (
    <button
      type="button"
      aria-label={blocked ? `${PALETTE_COPY.button} · ${disabledReason}` : PALETTE_COPY.button}
      aria-disabled={blocked || undefined}
      aria-haspopup="dialog"
      title={variant === 'desktop' ? (disabledReason ?? PALETTE_COPY.button) : undefined}
      onClick={
        blocked
          ? () => onBlockedTap?.(disabledReason!)
          : variant === 'phone'
            ? () => openWith(true)
            : undefined
      }
      className={cn(
        'nu-hit inline-flex shrink-0 items-center justify-center rounded-md font-mono text-muted transition-colors duration-(--dur-fast) hover:bg-hover hover:text-text aria-disabled:cursor-not-allowed aria-disabled:opacity-40',
        variant === 'phone' ? 'size-11 text-app-18' : 'size-9 text-app-16',
      )}
    >
      /
    </button>
  );
  const search = (
    <Input
      autoFocus
      size={variant === 'phone' ? 'lg' : 'md'}
      leadingIcon="search"
      value={query}
      onChange={(event) => {
        setQuery(event.target.value);
        setActive(0);
      }}
      onKeyDown={onKeyDown}
      placeholder={PALETTE_COPY.search}
      aria-label={PALETTE_COPY.search}
      role="combobox"
      aria-expanded
      aria-controls={listboxId}
      aria-activedescendant={results.items.length ? `${listboxId}-${active}` : undefined}
      aria-autocomplete="list"
      enterKeyHint="go"
    />
  );
  const list = (
    <PaletteList
      results={results}
      active={active}
      onActive={setActive}
      onChoose={choose}
      listboxId={listboxId}
      optionId={(i) => `${listboxId}-${i}`}
      notice={source.notice}
      touch={variant === 'phone'}
      className="min-h-0 flex-1"
    />
  );

  if (blocked) return trigger;
  if (variant === 'phone') {
    return (
      <Sheet open={open} onOpenChange={openWith}>
        {trigger}
        <SheetContent title={PALETTE_COPY.title}>
          <div className="flex min-h-0 flex-col gap-2 pb-3">
            {search}
            <div className="flex max-h-[55dvh] min-h-0 flex-col">{list}</div>
          </div>
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Popover open={open} onOpenChange={openWith}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        width={420}
        className="flex max-h-[min(440px,70dvh)] flex-col gap-1 p-2"
      >
        {search}
        {list}
        <p className="m-0 px-1 pt-1 font-sans text-app-11 text-muted">{PALETTE_COPY.hint}</p>
      </PopoverContent>
    </Popover>
  );
}
