import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * CurrentUser mapping of the multi-account model: role and disabledAt come from Better Auth's
 * `user.additionalFields`; an unexpected role is the least privileged one; a disabled account is
 * treated as signed out.
 */

const state = vi.hoisted(() => ({
  result: null as null | { user: Record<string, unknown>; session: { id: string } },
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ cookie: 'nuera.session_token=x' }),
  cookies: async () => ({ getAll: () => [] }),
}));

vi.mock('@/server/auth/auth', () => ({
  auth: { api: { getSession: async () => state.result } },
}));

const session = await import('./session');

function signedIn(user: Record<string, unknown>) {
  state.result = {
    user: { id: 'u1', name: 'Camille Laurent', email: 'camille@example.test', image: null, twoFactorEnabled: true, ...user },
    session: { id: 's1' },
  };
}

beforeEach(() => {
  state.result = null;
});

describe('getCurrentUser', () => {
  it('maps the instance role and the session id', async () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      signedIn({ role, disabledAt: null });
      expect(await session.getCurrentUser()).toEqual({
        id: 'u1',
        name: 'Camille Laurent',
        email: 'camille@example.test',
        image: null,
        twoFactorEnabled: true,
        authSessionId: 's1',
        role,
        disabledAt: null,
      });
    }
  });

  it('falls back to the least privileged role for a missing or unexpected value', async () => {
    signedIn({});
    expect((await session.getCurrentUser())?.role).toBe('member');
    signedIn({ role: 'superadmin' });
    expect((await session.getCurrentUser())?.role).toBe('member');
  });

  it('treats a disabled account as signed out', async () => {
    signedIn({ role: 'admin', disabledAt: new Date('2026-11-01T10:00:00Z') });
    expect(await session.getCurrentUser()).toBeNull();
    signedIn({ role: 'member', disabledAt: '2026-11-01T10:00:00.000Z' });
    await expect(session.requireUserForApi()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('answers null without a session', async () => {
    expect(await session.getCurrentUser()).toBeNull();
  });
});

describe('isInstanceAdmin', () => {
  it('is true for the owner and administrators only', () => {
    expect(session.isInstanceAdmin({ role: 'owner' })).toBe(true);
    expect(session.isInstanceAdmin({ role: 'admin' })).toBe(true);
    expect(session.isInstanceAdmin({ role: 'member' })).toBe(false);
  });
});

describe("2FA obligatoire et accès à l'administration", () => {
  it('refuses an account without 2FA, whatever NUERA_REQUIRE_2FA says (the flag is gone)', async () => {
    process.env.NUERA_REQUIRE_2FA = 'false';
    try {
      signedIn({ role: 'owner', disabledAt: null, twoFactorEnabled: false });
      await expect(session.requireUserForApi()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      delete process.env.NUERA_REQUIRE_2FA;
    }
  });

  it('opens the administration to the owner and administrators only', async () => {
    for (const role of ['owner', 'admin'] as const) {
      signedIn({ role, disabledAt: null });
      await expect(session.requireAdminForApi()).resolves.toMatchObject({ role });
    }
    signedIn({ role: 'member', disabledAt: null });
    await expect(session.requireAdminForApi()).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Action réservée aux administrateurs.' });
    // Pages: a member gets the 404 (the console is never revealed).
    await expect(session.requireAdmin()).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_HTTP_ERROR_FALLBACK;404/) });
  });
});
