import { describe, expect, it } from 'vitest';
import { ICON_NAMES, ICON_PATHS } from './icon-paths';

describe('icon set', () => {
  it('covers the navigation, section 04 and Nuera OS icons used by the screens', () => {
    const required = [
      // navigation
      'home', 'projets', 'terminal', 'plug', 'reglages',
      // section 04 (37)
      'git-branch', 'git-commit', 'git-pull-request', 'worktree', 'file', 'file-diff', 'folder', 'play', 'stop',
      'pause', 'refresh', 'github', 'figma', 'star', 'archive', 'key', 'cpu', 'lock', 'x', 'arrow-left',
      'chevron-down', 'more', 'history', 'wifi-off', 'eye', 'monitor', 'smartphone', 'trash', 'upload', 'pull',
      'panel-right', 'external', 'filter', 'list-checks',
      // Nuera OS
      'chevron', 'plus', 'search', 'check', 'clock', 'alert', 'shield', 'minus', 'paperclip', 'send', 'bell',
      'messages', 'book', 'rocket', 'server', 'edit', 'globe2',
    ];
    for (const name of required) expect(ICON_NAMES, name).toContain(name);
  });

  it('only contains stroke paths on the 24 px grid', () => {
    for (const [name, paths] of Object.entries(ICON_PATHS)) {
      expect(paths.length, name).toBeGreaterThan(0);
      for (const d of paths) {
        expect(d, name).toMatch(/^M[-\d. ]/);
        expect(d, name).toMatch(/^[MLHVCSQTAZmlhvcsqtaz\d.\s-]+$/);
        const numbers = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
        for (const n of numbers) {
          expect(n, `${name} coordinate`).toBeGreaterThanOrEqual(-1);
          expect(n, `${name} coordinate`).toBeLessThanOrEqual(25);
        }
      }
    }
  });
});
