import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { CommitAuthorLine, CommitForm, GIT_IDENTITY_HREF, commitAuthorLabel } from './CommitForm';
import type { CommitFlow } from './useCommitFlow';

const html = (node: ReactElement) => renderToStaticMarkup(node);
/** Visible text of rendered markup (tags removed, entities decoded). */
const text = (node: ReactElement) =>
  html(node)
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const AUTHOR = { name: 'Camille L.', email: 'camille@atelier.test' };

/** The parts of the flow the form reads (the hook itself needs the Workspace context). */
function flow(overrides: Partial<CommitFlow> = {}): CommitFlow {
  const files = [{ path: 'src/export.ts', oldPath: null, status: 'modified', insertions: 12, deletions: 3, binary: false }];
  return {
    draft: { message: 'feat: export CSV', body: '', push: true, openPr: false, prTitle: '', prTitleEdited: false, excluded: [] },
    setDraft: () => undefined,
    files,
    included: files,
    totals: { insertions: 12, deletions: 3 },
    openPullRequest: null,
    openPr: false,
    prTitle: 'feat: export CSV',
    base: 'main',
    branch: 'feature/export-csv',
    author: AUTHOR,
    worktreeName: 'export-csv',
    toggleFile: () => undefined,
    toggleAll: () => undefined,
    blockers: [],
    canSubmit: true,
    step: null,
    error: null,
    clearError: () => undefined,
    submit: async () => true,
    pushBlockedReason: null,
    cta: 'Committer et pousser',
    phoneCta: 'Committer et pousser',
    ...overrides,
  } as unknown as CommitFlow;
}

describe('« Auteur » line (W5)', () => {
  it('writes the identity that signs the commit and links to Paramètres', () => {
    expect(commitAuthorLabel(AUTHOR)).toBe('Camille L. <camille@atelier.test>');
    expect(GIT_IDENTITY_HREF).toBe('/parametres?onglet=compte-et-securite#identite-git');
    const line = <CommitAuthorLine author={AUTHOR} variant="dialog" />;
    expect(text(line)).toBe('Auteur : Camille L. <camille@atelier.test>Modifier');
    expect(html(line)).toContain(`href="${GIT_IDENTITY_HREF}"`);
    expect(html(line)).toContain('aria-label="Modifier l&#x27;identité Git"');
  });

  it('hides « Modifier » while the commit runs', () => {
    const line = <CommitAuthorLine author={AUTHOR} variant="phone" busy />;
    expect(text(line)).toBe('Auteur : Camille L. <camille@atelier.test>');
    expect(html(line)).not.toContain('href=');
  });

  it('is shown in the desktop modal and the phone Git tab, only when files will be committed', () => {
    for (const variant of ['dialog', 'phone'] as const) {
      expect(text(<CommitForm flow={flow()} variant={variant} />), variant).toContain('Auteur : Camille L. <camille@atelier.test>');
      const pushOnly = flow({ files: [], included: [], totals: { insertions: 0, deletions: 0 } });
      expect(text(<CommitForm flow={pushOnly} variant={variant} />), variant).not.toContain('Auteur :');
    }
  });
});
