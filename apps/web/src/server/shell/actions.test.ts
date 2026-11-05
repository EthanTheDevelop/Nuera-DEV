import { beforeEach, describe, expect, it, vi } from 'vitest';

/* Test doubles: the session, the request headers/cookies, notifications and settings. */
const state = vi.hoisted(() => ({
  headers: new Headers(),
  cookies: [] as Array<{ name: string; value: string }>,
  marked: [] as string[][],
  markedAll: 0,
  themes: [] as string[],
  signedIn: true,
}));

vi.mock('next/headers', () => ({
  headers: async () => state.headers,
  cookies: async () => ({ set: (name: string, value: string) => state.cookies.push({ name, value }) }),
}));

vi.mock('@/server/auth/session', () => ({
  requireUser: async () => {
    if (!state.signedIn) throw new Error('NEXT_REDIRECT /connexion');
    return { id: 'u1', name: 'Owner', email: 'owner@example.test', image: null, twoFactorEnabled: true, authSessionId: 's1' };
  },
}));

vi.mock('@/server/notifications', () => ({
  markNotificationsRead: async (ids: string[]) => {
    state.marked.push(ids);
    return ids.length;
  },
  markAllNotificationsRead: async () => {
    state.markedAll += 1;
    return 3;
  },
}));

vi.mock('@/server/settings', () => ({
  updateAppSettings: async (patch: { theme: string }) => {
    state.themes.push(patch.theme);
    return {};
  },
}));

const { markAllNotificationsReadAction, markNotificationsReadAction, setThemePreferenceAction } = await import('./actions');

const ID = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.stubEnv('APP_URL', 'https://dev.example.test');
  state.headers = new Headers({ origin: 'https://dev.example.test', host: 'dev.example.test' });
  state.cookies = [];
  state.marked = [];
  state.markedAll = 0;
  state.themes = [];
  state.signedIn = true;
});

describe('shell server actions', () => {
  it('saves the theme and mirrors it in the cookie read by the root layout', async () => {
    await expect(setThemePreferenceAction('dark')).resolves.toEqual({ ok: true, theme: 'dark' });
    expect(state.themes).toEqual(['dark']);
    expect(state.cookies).toEqual([{ name: 'nuera-theme', value: 'dark' }]);
  });

  it('rejects an unknown theme', async () => {
    await expect(setThemePreferenceAction('neon' as never)).rejects.toThrow();
    expect(state.themes).toEqual([]);
  });

  it('marks notifications read (validated ids only)', async () => {
    await expect(markNotificationsReadAction([ID])).resolves.toEqual({ updated: 1 });
    await expect(markNotificationsReadAction(['not-a-uuid'])).resolves.toEqual({ updated: 0 });
    await expect(markAllNotificationsReadAction()).resolves.toEqual({ updated: 3 });
    expect(state.marked).toEqual([[ID]]);
  });

  it('refuses a mutation coming from another origin (CSRF)', async () => {
    state.headers = new Headers({ origin: 'https://evil.example', host: 'dev.example.test' });
    await expect(setThemePreferenceAction('dark')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(markNotificationsReadAction([ID])).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(markAllNotificationsReadAction()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(state.themes).toEqual([]);
    expect(state.marked).toEqual([]);
    expect(state.markedAll).toBe(0);
  });

  it('requires the signed-in owner first', async () => {
    state.signedIn = false;
    await expect(markAllNotificationsReadAction()).rejects.toThrow('NEXT_REDIRECT');
    expect(state.markedAll).toBe(0);
  });
});
