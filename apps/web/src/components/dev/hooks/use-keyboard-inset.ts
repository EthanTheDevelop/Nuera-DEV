'use client';

import { useSyncExternalStore } from 'react';

export interface KeyboardInset {
  /** The on-screen keyboard is up (S1 · Clavier ouvert). */
  open: boolean;
  /**
   * Pixels of the layout viewport hidden by the keyboard. 0 when the browser resizes the layout
   * itself (`interactive-widget=resizes-content`, Chrome Android); > 0 on iOS Safari, where only the
   * visual viewport shrinks — offset a bottom-pinned composer by this amount.
   */
  inset: number;
}

/** A keyboard takes far more than this; toolbars and URL bars take less. */
const OPEN_THRESHOLD_PX = 120;

// Largest visual-viewport height seen for the current width (the "keyboard closed" height).
let baseline = 0;
let baselineWidth = 0;

/** Encoded snapshot (a primitive, so React can compare it): 0 = closed, n > 0 = open with inset n − 1. */
function readSnapshot(): number {
  const vv = window.visualViewport;
  if (!vv) return 0;
  if (Math.abs(vv.width - baselineWidth) > 1) {
    baselineWidth = vv.width;
    baseline = vv.height;
  }
  baseline = Math.max(baseline, vv.height);
  if (baseline - vv.height <= OPEN_THRESHOLD_PX) return 0;
  return Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) + 1;
}

function subscribe(onChange: () => void): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => undefined;
  vv.addEventListener('resize', onChange);
  vv.addEventListener('scroll', onChange);
  return () => {
    vv.removeEventListener('resize', onChange);
    vv.removeEventListener('scroll', onChange);
  };
}

const serverSnapshot = () => 0;

/**
 * Tracks the phone keyboard through `window.visualViewport` (S1: the composer stays pinned right
 * above the keyboard and the home-indicator spacer collapses). Always closed on the server and on
 * browsers without a visual viewport.
 */
export function useKeyboardInset(): KeyboardInset {
  const value = useSyncExternalStore(subscribe, readSnapshot, serverSnapshot);
  return { open: value > 0, inset: value > 0 ? value - 1 : 0 };
}
