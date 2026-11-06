'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { cn } from '@/lib/cn';

const STORAGE_KEY = 'nuera.workspace.sideWidth';
const DEFAULT_WIDTH = 460;
const MIN_WIDTH = 320;
/** The main column always keeps this much room. */
const MAIN_MIN_WIDTH = 420;
const STEP = 24;

function maxWidth(): number {
  if (typeof window === 'undefined') return 900;
  return Math.max(MIN_WIDTH, window.innerWidth - MAIN_MIN_WIDTH);
}

function clamp(width: number): number {
  return Math.round(Math.min(Math.max(width, MIN_WIDTH), maxWidth()));
}

function readStored(): number | null {
  try {
    const value = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function store(width: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    // private window / blocked storage: the width lasts for this page only
  }
}

/**
 * Width of the Workspace's right column (context panel, or the conversation beside the enlarged
 * preview), chosen by dragging its left edge; remembered by the browser (per-viewer convenience).
 */
export function useSideColumnWidth() {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useEffect(() => {
    const stored = readStored();
    // eslint-disable-next-line react/set-state-in-effect -- the stored width is only readable after mount (SSR renders the default)
    if (stored) setWidth(clamp(stored));
    const onResize = () => setWidth((current) => clamp(current));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const update = useCallback((next: number, persist: boolean) => {
    const value = clamp(next);
    setWidth(value);
    if (persist) store(value);
  }, []);
  return { width, update, reset: () => update(DEFAULT_WIDTH, true) };
}

/** Vertical drag handle on the left edge of the right column (mouse, pen, touch and keyboard). */
export function PanelResizer({ width, onChange, onReset }: { width: number; onChange: (width: number, persist: boolean) => void; onReset: () => void }) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width };
    setDragging(true);
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start) return;
    // Dragging left widens the right column.
    onChange(start.startWidth + (start.startX - event.clientX), false);
  }
  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start) return;
    drag.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
    onChange(start.startWidth + (start.startX - event.clientX), true);
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft') onChange(width + STEP, true);
    else if (event.key === 'ArrowRight') onChange(width - STEP, true);
    else if (event.key === 'Home') onChange(MIN_WIDTH, true);
    else if (event.key === 'End') onChange(maxWidth(), true);
    else return;
    event.preventDefault();
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Redimensionner le panneau (double-clic : taille par défaut)"
      aria-valuenow={width}
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={maxWidth()}
      tabIndex={0}
      title="Glisser pour redimensionner · double-clic : taille par défaut"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      className={cn(
        'group relative z-10 -mx-1 w-2 shrink-0 cursor-col-resize touch-none select-none outline-none',
        'focus-visible:bg-accent/20',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors',
          'group-hover:w-0.5 group-hover:bg-accent group-focus-visible:w-0.5 group-focus-visible:bg-accent',
          dragging && 'w-0.5 bg-accent',
        )}
      />
      {/* While dragging, a full-window layer keeps the cursor and stops the preview iframe from swallowing the pointer. */}
      {dragging ? <span aria-hidden="true" className="fixed inset-0 cursor-col-resize" /> : null}
    </div>
  );
}
