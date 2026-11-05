import { beforeEach, describe, expect, it, vi } from 'vitest';

/* The developer gallery (/kit) must never render in production, and only for the signed-in owner
   unless NUERA_KIT_PUBLIC=1 under `next dev` (screenshots). */
const calls = vi.hoisted(() => ({ notFound: 0, requireUser: 0 }));

vi.mock('next/navigation', () => ({
  notFound: () => {
    calls.notFound += 1;
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
  },
}));

vi.mock('@/server/auth/session', () => ({
  requireUser: async () => {
    calls.requireUser += 1;
    return { id: 'u1' };
  },
}));

const { default: DevLayout } = await import('./layout');

beforeEach(() => {
  calls.notFound = 0;
  calls.requireUser = 0;
});

describe('(dev) layout gate', () => {
  it('is a 404 in production, even with NUERA_KIT_PUBLIC=1', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NUERA_KIT_PUBLIC', '1');
    await expect(DevLayout({ children: null })).rejects.toThrow('404');
    expect(calls.notFound).toBe(1);
    expect(calls.requireUser).toBe(0);
  });

  it('requires the signed-in owner in development by default', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NUERA_KIT_PUBLIC', '');
    await DevLayout({ children: null });
    expect(calls.requireUser).toBe(1);
  });

  it('skips the session only with NUERA_KIT_PUBLIC=1 under next dev', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NUERA_KIT_PUBLIC', '1');
    await DevLayout({ children: null });
    expect(calls.requireUser).toBe(0);
    vi.stubEnv('NODE_ENV', 'test');
    await DevLayout({ children: null });
    expect(calls.requireUser).toBe(1);
  });
});
