'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import {
  fileItems,
  fileQueryParts,
  filterPaletteItems,
  insertPaletteText,
  paletteTriggerAt,
  PALETTE_COPY,
  type PaletteItem,
  type PaletteTrigger,
  type TreeEntryLike,
} from './palette';

/** What a palette can offer: fixed items (commands, skills, MCP) and, optionally, the worktree files. */
export interface PaletteSource {
  items: readonly PaletteItem[];
  /** Entries of one folder of the worktree (`''` = root); absent → no `@` files. */
  loadFiles?: (dir: string, signal: AbortSignal) => Promise<readonly TreeEntryLike[]>;
  /** The fixed items are still being read (skills, MCP). */
  loading?: boolean;
  /** Why some items are missing (« skills indisponibles »). */
  notice?: string | null;
}

export interface PaletteResults {
  items: PaletteItem[];
  loading: boolean;
  error: string | null;
}

/** Items for a query: `@…` = files of the folder being typed, anything else = commands / skills / MCP. */
export function usePaletteResults(
  source: PaletteSource | undefined,
  kind: '/' | '@' | null,
  query: string,
): PaletteResults {
  const [files, setFiles] = useState<ReadonlyMap<string, readonly TreeEntryLike[]>>(
    () => new Map(),
  );
  const [failed, setFailed] = useState<string | null>(null);
  const loadFiles = source?.loadFiles;
  const dir = kind === '@' ? fileQueryParts(query).dir : null;

  useEffect(() => {
    if (dir === null || !loadFiles || files.has(dir)) return;
    const controller = new AbortController();
    loadFiles(dir, controller.signal)
      .then((entries) => setFiles((current) => new Map(current).set(dir, entries)))
      .catch(() => {
        if (!controller.signal.aborted) setFailed(dir);
      });
    return () => controller.abort();
  }, [dir, files, loadFiles]);

  if (!source || kind === null) return { items: [], loading: false, error: null };
  if (kind === '@') {
    if (!loadFiles) return { items: [], loading: false, error: PALETTE_COPY.filesUnavailable };
    const entries = files.get(dir ?? '');
    const { filter } = fileQueryParts(query);
    const error = !entries && failed === dir ? PALETTE_COPY.filesUnavailable : null;
    return { items: entries ? fileItems(entries, filter) : [], loading: !entries && !error, error };
  }
  return {
    items: filterPaletteItems(source.items, query),
    loading: Boolean(source.loading),
    error: null,
  };
}

export interface UsePaletteTriggerOptions {
  source: PaletteSource | undefined;
  fieldRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  setValue: (value: string) => void;
  disabled?: boolean;
}

export interface PaletteTriggerState {
  open: boolean;
  trigger: PaletteTrigger | null;
  results: PaletteResults;
  active: number;
  setActive: (index: number) => void;
  listboxId: string;
  optionId: (index: number) => string;
  /** Arrow keys, Enter / Tab, Échap while open; returns true when the key was used. */
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Caret moved (click, arrows, selection): re-read the trigger. */
  syncCaret: () => void;
  choose: (item: PaletteItem) => void;
  close: () => void;
}

/**
 * Typing `/` at the start of the instruction (or of a line) or `@` at the start of a word opens the
 * palette under the field, filtered by what follows; the field keeps the focus (combobox pattern).
 */
export function usePaletteTrigger({
  source,
  fieldRef,
  value,
  setValue,
  disabled = false,
}: UsePaletteTriggerOptions): PaletteTriggerState {
  const listboxId = useId();
  const [caret, setCaret] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [active, setActive] = useState(0);

  const trigger = useMemo(() => {
    if (disabled || !source || caret === null) return null;
    const found = paletteTriggerAt(value, Math.min(caret, value.length));
    if (!found || (found.kind === '@' && !source.loadFiles)) return null;
    return found;
  }, [caret, disabled, source, value]);
  const open = trigger !== null && dismissed !== trigger.start;
  const results = usePaletteResults(source, open ? trigger!.kind : null, trigger?.query ?? '');

  const syncCaret = useCallback(() => {
    const el = fieldRef.current;
    setCaret(el && document.activeElement === el ? el.selectionStart : null);
  }, [fieldRef]);

  // The value changed (typing, dictation, insertion): read the caret once the DOM has it.
  useEffect(() => {
    const frame = window.requestAnimationFrame(syncCaret);
    return () => window.cancelAnimationFrame(frame);
  }, [syncCaret, value]);

  const key = `${trigger?.kind ?? ''}${trigger?.start ?? -1}:${trigger?.query ?? ''}`;
  const [activeKey, setActiveKey] = useState(key);
  if (activeKey !== key) {
    setActiveKey(key);
    setActive(0);
  }
  if (dismissed !== null && (!trigger || trigger.start !== dismissed)) setDismissed(null);

  const close = useCallback(() => {
    if (trigger) setDismissed(trigger.start);
  }, [trigger]);

  const choose = useCallback(
    (item: PaletteItem) => {
      if (!trigger) return;
      const next = insertPaletteText(value, trigger, item.insert);
      setValue(next.value);
      window.requestAnimationFrame(() => {
        const el = fieldRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(next.caret, next.caret);
        setCaret(next.caret);
      });
    },
    [fieldRef, setValue, trigger, value],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!open || event.nativeEvent.isComposing) return false;
      const count = results.items.length;
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return true;
      }
      if (count === 0) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((i) => (event.key === 'ArrowDown' ? (i + 1) % count : (i - 1 + count) % count));
        return true;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault();
        choose(results.items[Math.min(active, count - 1)]!);
        return true;
      }
      return false;
    },
    [active, choose, close, open, results.items],
  );

  return {
    open,
    trigger,
    results,
    active,
    setActive,
    listboxId,
    optionId: (index: number) => `${listboxId}-${index}`,
    handleKeyDown,
    syncCaret,
    choose,
    close,
  };
}

/**
 * Insertion from the « / » button (no trigger typed): at the caret; a command or a skill goes to the
 * start of the instruction (the CLI only reads a slash command there).
 */
export function insertFromButton(
  value: string,
  caret: number | null,
  item: PaletteItem,
): { value: string; caret: number } {
  const at = caret ?? value.length;
  if ((item.group === 'commands' || item.group === 'skills') && value.slice(0, at).trim() !== '') {
    return insertPaletteText(value, { start: 0, end: 0 }, item.insert);
  }
  return insertPaletteText(value, { start: at, end: at }, item.insert);
}
