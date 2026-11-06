import { describe, expect, it } from 'vitest';
import { safeRedirectPath } from '@/server/auth/policy';
import { signInAfterSignOut } from '../../../(auth)/deconnexion/after-sign-out';
import { guardSignOutHref } from './sign-out-href';

/*
 * « Se déconnecter » of the notification click guard (W5): /deconnexion?suivant=<guard>, then the
 * sign-out lands on /connexion?suivant=<guard>, which brings the next account back to the guard with
 * the same `vers` and `compte`.
 */

const query = (href: string, name: string) => new URL(href, 'http://localhost').searchParams.get(name);

describe('guardSignOutHref', () => {
  it('signs out towards /connexion?suivant=<this guard> with the same vers and compte', () => {
    const href = guardSignOutHref({ vers: '/sessions/5f3c?onglet=journal&x=1', compte: 'tag-abc_123' });
    expect(href.startsWith('/deconnexion?suivant=')).toBe(true);
    const guard = query(href, 'suivant')!;
    expect(guard.startsWith('/parametres/notification?')).toBe(true);
    expect(query(guard, 'vers')).toBe('/sessions/5f3c?onglet=journal&x=1');
    expect(query(guard, 'compte')).toBe('tag-abc_123');

    // The sign-out action, then /connexion (safeRedirectPath), keep it intact.
    const connexion = signInAfterSignOut(query(href, 'suivant'));
    expect(connexion).toBe(`/connexion?suivant=${encodeURIComponent(guard)}`);
    expect(safeRedirectPath(query(connexion, 'suivant'))).toBe(guard);
  });

  it('takes the first value of a repeated parameter and only carries vers and compte', () => {
    const guard = query(guardSignOutHref({ vers: ['/projets', '/autre'], compte: undefined }), 'suivant')!;
    expect(guard).toBe('/parametres/notification?vers=%2Fprojets');
    expect(query(guardSignOutHref({}), 'suivant')).toBe('/parametres/notification');
  });

  it('signs out to plain /connexion when the guard URL is not a valid in-app path (too long)', () => {
    expect(guardSignOutHref({ vers: `/${'a'.repeat(600)}` })).toBe('/deconnexion');
  });
});

describe('signInAfterSignOut', () => {
  it('goes to /connexion, with suivant only for an in-app path', () => {
    expect(signInAfterSignOut(null)).toBe('/connexion');
    expect(signInAfterSignOut('')).toBe('/connexion');
    expect(signInAfterSignOut('/')).toBe('/connexion');
    expect(signInAfterSignOut('/projets?vue=liste')).toBe('/connexion?suivant=%2Fprojets%3Fvue%3Dliste');
    expect(signInAfterSignOut(['/projets', '/autre'])).toBe('/connexion?suivant=%2Fprojets');
    for (const unsafe of ['https://evil.example/x', '//evil.example', '/\\evil.example', '/connexion?suivant=/x', '/deconnexion', '/api/notifications', 'javascript:alert(1)']) {
      expect(signInAfterSignOut(unsafe), unsafe).toBe('/connexion');
    }
  });
});
