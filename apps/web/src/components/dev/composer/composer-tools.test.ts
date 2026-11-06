import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_MAX_BYTES,
  attachmentMeta,
  readyPaths,
  refusedText,
  selectAttachments,
  withAttachmentReferences,
  type ComposerAttachment,
} from './attachments';
import { Composer } from './Composer';
import type { ComposerTools } from './ComposerToolbar';
import {
  buildPaletteItems,
  CURATED_COMMANDS,
  fileItems,
  fileQueryParts,
  filterPaletteItems,
  insertPaletteText,
  paletteTriggerAt,
} from './palette';
import { PhoneComposer } from './PhoneComposer';
import type { AttachmentsController } from './use-attachments';
import { insertFromButton } from './use-palette';

const chip = (patch: Partial<ComposerAttachment> = {}): ComposerAttachment => ({
  id: 'a',
  name: 'capture.png',
  size: 2_400_000,
  kind: 'image',
  status: 'ready',
  path: '.nuera/pieces-jointes/20261106-142501-capture.png',
  error: null,
  previewUrl: null,
  ...patch,
});

describe('pièces jointes du compositeur', () => {
  it('accepts images, PDF, text and code within the limits, and says why the others are refused', () => {
    const files = [
      { name: 'capture.png', size: 10, type: 'image/png' },
      { name: 'devis.pdf', size: 10, type: 'application/pdf' },
      { name: 'notes.md', size: 10, type: 'text/markdown' },
      { name: 'archive.zip', size: 10, type: 'application/zip' },
      { name: 'IMG_0001.HEIC', size: 10, type: 'image/heic' },
      { name: 'gros.png', size: ATTACHMENT_MAX_BYTES + 1, type: 'image/png' },
      { name: 'vide.txt', size: 0, type: 'text/plain' },
      { name: '.env', size: 10, type: '' },
    ];
    const selection = selectAttachments([], files);
    expect(selection.accepted.map((a) => [a.file.name, a.kind])).toEqual([
      ['capture.png', 'image'],
      ['devis.pdf', 'pdf'],
      ['notes.md', 'text'],
    ]);
    expect(selection.refused.map((r) => r.name)).toEqual([
      'archive.zip',
      'IMG_0001.HEIC',
      'gros.png',
      'vide.txt',
      '.env',
    ]);
    expect(refusedText(selection.refused.slice(2, 3))).toBe('gros.png : plus de 20 Mo');
  });

  it('caps a message at 5 files (failed uploads do not count)', () => {
    const existing = [
      chip({ id: '1' }),
      chip({ id: '2' }),
      chip({ id: '3', status: 'uploading' }),
      chip({ id: '4', status: 'error' }),
    ];
    const many = Array.from({ length: 4 }, (_, i) => ({
      name: `p${i}.png`,
      size: 1,
      type: 'image/png',
    }));
    const selection = selectAttachments(existing, many);
    expect(selection.accepted).toHaveLength(2);
    expect(selection.refused).toEqual([
      { name: 'p2.png', reason: '5 fichiers au maximum par message' },
      { name: 'p3.png', reason: '5 fichiers au maximum par message' },
    ]);
  });

  it('references the stored files with @<chemin> after the text, in the order of the chips', () => {
    const items = [
      chip(),
      chip({ id: 'b', status: 'uploading', path: null }),
      chip({
        id: 'c',
        name: 'devis.pdf',
        kind: 'pdf',
        path: '.nuera/pieces-jointes/20261106-142502-devis.pdf',
      }),
    ];
    const paths = readyPaths(items);
    expect(withAttachmentReferences('  Corrige le bouton  ', paths)).toBe(
      'Corrige le bouton\n\n@.nuera/pieces-jointes/20261106-142501-capture.png @.nuera/pieces-jointes/20261106-142502-devis.pdf',
    );
    expect(withAttachmentReferences('', paths.slice(0, 1))).toBe(
      '@.nuera/pieces-jointes/20261106-142501-capture.png',
    );
    expect(withAttachmentReferences('Sans pièce jointe', [])).toBe('Sans pièce jointe');
    expect(attachmentMeta(chip())).toBe('2 Mo');
    expect(attachmentMeta(chip({ status: 'uploading' }))).toBe('Envoi…');
    expect(attachmentMeta(chip({ status: 'error', error: 'Type de fichier refusé.' }))).toBe(
      'Type de fichier refusé.',
    );
  });
});

describe('palette « / » et « @ »', () => {
  it('offers curated interactive commands, never a cost or usage command', () => {
    const names = CURATED_COMMANDS.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'compact',
        'clear',
        'model',
        'review',
        'init',
        'context',
        'mcp',
        'agents',
      ]),
    );
    for (const forbidden of ['cost', 'usage', 'login', 'logout', 'status', 'upgrade', 'exit'])
      expect(names).not.toContain(forbidden);
  });

  it('builds the items: commands, then skills, then MCP servers and their known tools', () => {
    const items = buildPaletteItems({
      skills: [{ name: 'revue', description: 'Relit le diff', source: 'project' }],
      mcp: [
        { name: 'figma', label: 'Figma', tools: ['get_design_context'] },
        { name: 'github', label: 'GitHub', tools: [] },
      ],
    });
    expect(items.find((i) => i.id === 'skill:project:revue')).toMatchObject({
      label: '/revue',
      insert: '/revue ',
      description: 'Relit le diff · projet',
    });
    expect(items.find((i) => i.id === 'mcp:figma:get_design_context')).toMatchObject({
      insert: 'mcp__figma__get_design_context ',
    });
    expect(items.find((i) => i.id === 'mcp:github')?.description).toBe(
      'GitHub · outils connus après un test de connexion',
    );
    expect(items.map((i) => i.group)).toEqual([
      ...CURATED_COMMANDS.map(() => 'commands'),
      'skills',
      'mcp',
      'mcp',
      'mcp',
    ]);
  });

  it('filters by label first, then by description and French keywords (accents ignored)', () => {
    const items = buildPaletteItems({
      skills: [{ name: 'compte-rendu', description: null, source: 'user' }],
    });
    // Label matches first; « /init » only by its description (« compléter CLAUDE.md »).
    expect(filterPaletteItems(items, 'comp').map((i) => i.label)).toEqual([
      '/compact',
      '/compte-rendu',
      '/init',
    ]);
    expect(filterPaletteItems(items, '/cle').map((i) => i.label)[0]).toBe('/clear');
    expect(filterPaletteItems(items, 'memoire').map((i) => i.label)).toEqual(['/memory']);
    expect(filterPaletteItems(items, 'zzz')).toEqual([]);
  });

  it('opens on / at the start of the instruction or of a line, and on @ at the start of a word', () => {
    expect(paletteTriggerAt('/comp', 5)).toEqual({ kind: '/', query: 'comp', start: 0, end: 5 });
    expect(paletteTriggerAt('Bonjour\n/cl', 11)).toMatchObject({
      kind: '/',
      query: 'cl',
      start: 8,
    });
    expect(paletteTriggerAt('Lis /tmp', 8)).toBeNull();
    expect(paletteTriggerAt('a/b', 3)).toBeNull();
    expect(paletteTriggerAt('/src/index', 10)).toBeNull();
    expect(paletteTriggerAt('Regarde @src/ind', 16)).toEqual({
      kind: '@',
      query: 'src/ind',
      start: 8,
      end: 16,
    });
    expect(paletteTriggerAt('mail@exemple.fr', 15)).toBeNull();
    expect(paletteTriggerAt('Regarde @src fin', 12)).toMatchObject({ kind: '@', query: 'src' });
    expect(paletteTriggerAt('Regarde @src fin', 16)).toBeNull();
  });

  it('inserts in place of the typed trigger and never sends', () => {
    expect(insertPaletteText('/comp', { start: 0, end: 5 }, '/compact ')).toEqual({
      value: '/compact ',
      caret: 9,
    });
    expect(
      insertPaletteText('Regarde @src/ind merci', { start: 8, end: 16 }, '@src/index.ts '),
    ).toEqual({ value: 'Regarde @src/index.ts merci', caret: 22 });
    // From the « / » button: a command goes to the start, a file at the caret.
    const command = buildPaletteItems()[0]!;
    expect(insertFromButton('résume le travail', 17, command).value).toBe(
      '/compact résume le travail',
    );
    expect(
      insertFromButton('Lis', 3, {
        id: 'file:a',
        group: 'files',
        label: 'a.ts',
        description: null,
        insert: '@a.ts ',
      }).value,
    ).toBe('Lis @a.ts ');
  });

  it('lists the folder being typed, folders first, ignored files last', () => {
    expect(fileQueryParts('src/comp')).toEqual({ dir: 'src', filter: 'comp' });
    expect(fileQueryParts('src/')).toEqual({ dir: 'src', filter: '' });
    expect(fileQueryParts('ind')).toEqual({ dir: '', filter: 'ind' });
    const entries = [
      { name: 'index.ts', path: 'src/index.ts', kind: 'file' as const, ignored: false },
      { name: 'components', path: 'src/components', kind: 'dir' as const, ignored: false },
      { name: 'cache.json', path: 'src/cache.json', kind: 'file' as const, ignored: true },
      { name: 'lien', path: 'src/lien', kind: 'other' as const, ignored: false },
    ];
    expect(fileItems(entries, '').map((i) => [i.label, i.insert])).toEqual([
      ['src/components/', '@src/components/'],
      ['src/index.ts', '@src/index.ts '],
      ['src/cache.json', '@src/cache.json '],
    ]);
    expect(fileItems(entries, 'IND').map((i) => i.label)).toEqual(['src/index.ts']);
  });
});

describe("barre d'outils du compositeur (rendu)", () => {
  const attachments: AttachmentsController = {
    items: [chip()],
    add: () => undefined,
    remove: () => undefined,
    clear: () => undefined,
    paths: [chip().path!],
    uploading: false,
    notice: null,
    dismissNotice: () => undefined,
  };
  const tools: ComposerTools = {
    attachments,
    model: {
      title: 'Modèle de la session',
      label: 'Fake Opus',
      options: [{ value: 'opus', label: 'Opus' }],
      value: null,
      onSelect: () => undefined,
    },
    mode: {
      title: 'Mode de permission',
      label: 'Planifier sans modifier',
      options: [{ value: 'plan', label: 'Planifier sans modifier' }],
      value: 'plan',
      onSelect: () => undefined,
      disabledReason: "Répondez d'abord à la demande d'autorisation.",
    },
    palette: { items: buildPaletteItems() },
  };

  it('desktop: Joindre, model and mode chips, « / » on the left; mic and Envoyer on the right', () => {
    const html = renderToStaticMarkup(
      createElement(Composer, {
        state: 'ready',
        onSubmit: () => undefined,
        modeLabel: 'planifier sans modifier',
        tools,
      }),
    );
    expect(html).toContain('aria-label="Joindre"');
    expect(html).toContain('aria-label="Modèle de la session : Fake Opus"');
    expect(html).toContain(
      'aria-label="Mode de permission : Planifier sans modifier · Répondez d&#x27;abord à la demande d&#x27;autorisation."',
    );
    expect(html).toContain('aria-label="Commandes, skills et fichiers"');
    expect(html).toContain('capture.png');
    expect(html).toContain('aria-label="Retirer capture.png"');
    // The old hints are replaced by the palette.
    expect(html).not.toContain('/ commandes');
    expect(html.indexOf('aria-label="Joindre"')).toBeLessThan(html.indexOf('aria-label="Envoyer"'));
    // A stored file alone can be sent (Envoyer enabled with an empty field).
    expect(/<button[^>]*aria-label="Envoyer"[^>]*disabled/.test(html)).toBe(false);
  });

  it('phone: the same tools in a row above the field, file inputs for the library and the camera', () => {
    const html = renderToStaticMarkup(
      createElement(PhoneComposer, { state: 'ready', onSubmit: () => undefined, tools }),
    );
    expect(html).toContain('data-composer-tools');
    expect(html).toContain('capture="environment"');
    expect(html).toContain('accept="image/*"');
    expect(html.indexOf('data-composer-tools')).toBeLessThan(html.indexOf('<textarea'));
  });
});
