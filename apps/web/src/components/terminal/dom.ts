/**
 * Browser-only helpers of `TerminalView`: read the dark tokens and the JetBrains Mono family from
 * the CSS (never hard-coded), measure a cell like xterm does, per-tab client id for resizes.
 * Called from effects only (never during SSR).
 */

import {
  TERMINAL_TOKEN_VARS,
  buildTerminalTheme,
  parseCssColor,
  type Rgba,
  type TerminalTokens,
} from './protocol';
import type { ITheme } from '@xterm/xterm';

/** Resolves each dark token of the scope `element` sits in (`data-tone="dark"`) to an rgba colour. */
export function readTerminalTheme(element: HTMLElement): ITheme | null {
  const probe = element.ownerDocument.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  element.appendChild(probe);
  try {
    const tokens: Partial<Record<keyof TerminalTokens, Rgba>> = {};
    for (const [name, cssVar] of Object.entries(TERMINAL_TOKEN_VARS) as Array<[keyof TerminalTokens, string]>) {
      probe.style.color = '';
      probe.style.color = `var(${cssVar})`;
      const color = parseCssColor(getComputedStyle(probe).color);
      if (!color) return null;
      tokens[name] = color;
    }
    return buildTerminalTheme(tokens as TerminalTokens);
  } finally {
    probe.remove();
  }
}

/** Font family list of `--font-mono` (the next/font JetBrains Mono family first). */
export function readMonoFontFamily(element: HTMLElement): string {
  const probe = element.ownerDocument.createElement('span');
  probe.style.fontFamily = 'var(--font-mono)';
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  element.appendChild(probe);
  try {
    const family = getComputedStyle(probe).fontFamily;
    return family && family.trim() ? family : 'ui-monospace, monospace';
  } finally {
    probe.remove();
  }
}

/** Waits (bounded) for the mono font so that xterm measures the real glyphs, not a fallback. */
export async function waitForFont(fontFamily: string, fontSize: number, timeoutMs = 2_000): Promise<void> {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  if (!fonts?.load) return;
  const first = fontFamily.split(',')[0]?.trim();
  if (!first) return;
  await Promise.race([
    Promise.all([fonts.load(`${fontSize}px ${first}`), fonts.load(`bold ${fontSize}px ${first}`)]).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

/** Height of one character box, as xterm's CharSizeService measures it (canvas metrics or DOM). */
export function measureCharHeight(fontFamily: string, fontSize: number, host: HTMLElement): number {
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const ctx = new OffscreenCanvas(10, 10).getContext('2d');
      if (ctx) {
        ctx.font = `${fontSize}px ${fontFamily}`;
        const metrics = ctx.measureText('W');
        const height = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
        if (Number.isFinite(height) && height > 0) return height;
      }
    }
  } catch {
    // fall back to the DOM measure
  }
  const probe = host.ownerDocument.createElement('span');
  probe.textContent = 'W'.repeat(32);
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;line-height:normal;font-kerning:none;font-family:${fontFamily};font-size:${fontSize}px`;
  host.appendChild(probe);
  try {
    return probe.offsetHeight;
  } finally {
    probe.remove();
  }
}

let tabClientId: string | null = null;

/** One id per browser tab: the runner keeps the size of the last client that resized. */
export function terminalClientId(): string {
  if (!tabClientId) {
    tabClientId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `tab-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
  return tabClientId;
}

export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? navigator.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform) || /Mac OS X/.test(navigator.userAgent);
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}
