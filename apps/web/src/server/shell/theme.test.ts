import { beforeEach, describe, expect, it, vi } from 'vitest';

/* Theme of the SSR per account: the signed-in account's own preference, the cookie only when signed out. */

const state = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  user: null as { id: string } | null,
  preferences: new Map<string, { theme: string }>(),
  failing: false,
  asked: [] as string[],
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 'nuera-theme' && state.cookie ? { value: state.cookie } : undefined) }),
}));

vi.mock('@/server/auth/session', () => ({
  getCurrentUser: async () => state.user,
}));

vi.mock('@/server/settings', () => ({
  getUserPreferences: async (userId: string) => {
    state.asked.push(userId);
    if (state.failing) throw new Error('database down');
    return state.preferences.get(userId) ?? null;
  },
}));

const { getThemePreference } = await import('./theme');

beforeEach(() => {
  state.cookie = undefined;
  state.user = null;
  state.failing = false;
  state.asked = [];
  state.preferences = new Map([
    ['user-a', { theme: 'dark' }],
    ['user-b', { theme: 'light' }],
  ]);
});

describe('getThemePreference', () => {
  it("follows the signed-in account, whatever another account of this browser left in the cookie", async () => {
    state.cookie = 'dark';
    state.user = { id: 'user-b' };
    expect(await getThemePreference()).toBe('light');
    state.user = { id: 'user-a' };
    state.cookie = 'light';
    expect(await getThemePreference()).toBe('dark');
    expect(state.asked).toEqual(['user-b', 'user-a']);
  });

  it('uses the cookie mirror when signed out or when the database cannot be read, never throws', async () => {
    state.cookie = 'system';
    expect(await getThemePreference()).toBe('system');
    expect(state.asked).toEqual([]);
    state.user = { id: 'user-a' };
    state.failing = true;
    expect(await getThemePreference()).toBe('system');
    state.cookie = undefined;
    expect(await getThemePreference()).toBe('light');
    state.cookie = 'neon';
    state.user = null;
    expect(await getThemePreference()).toBe('light');
  });
});
