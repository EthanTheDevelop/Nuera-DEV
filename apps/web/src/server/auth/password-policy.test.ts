import { describe, expect, it } from 'vitest';
import { newPasswordSchema, passwordProblems } from './password-policy';

describe('passwordProblems', () => {
  it('accepts a long password mixing letters and digits or symbols', () => {
    expect(passwordProblems('rivière-bleue-2026')).toEqual([]);
    expect(passwordProblems('Correct horse battery staple!')).toEqual([]);
  });

  it('requires 12 characters', () => {
    expect(passwordProblems('Court-1')).toContain('12 caractères au minimum');
  });

  it('requires letters and at least a digit or a symbol', () => {
    expect(passwordProblems('seulementdeslettres')).toContain('des lettres et au moins un chiffre ou un symbole');
    expect(passwordProblems('123456789012345')).toContain('des lettres et au moins un chiffre ou un symbole');
  });

  it('refuses the name, the e-mail and common passwords', () => {
    expect(passwordProblems('nezar-2026-secret', { email: 'nezar@nuera.studio' })).toContain('sans votre nom ni votre e-mail');
    expect(passwordProblems('Ethan Ngo 1234 !', { name: 'Ethan Ngo' })).toContain('sans votre nom ni votre e-mail');
    expect(passwordProblems('motdepasse12345')).toContain('pas un mot de passe courant');
    expect(passwordProblems('azertyazerty1')).toContain('pas un mot de passe courant');
  });

  it('refuses more than 128 characters', () => {
    expect(passwordProblems(`a1${'x'.repeat(130)}`)).toContain('128 caractères au maximum');
  });

  it('is exposed as a Zod schema with French messages', () => {
    const result = newPasswordSchema.safeParse('court');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((issue) => issue.message)).toContain('12 caractères au minimum');
    expect(newPasswordSchema.safeParse('une-phrase-solide-42').success).toBe(true);
  });
});
