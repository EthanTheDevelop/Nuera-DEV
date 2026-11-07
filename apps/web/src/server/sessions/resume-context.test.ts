import { RESUME_CONTEXT_MAX_CHARS } from '@nuera/shared/runner';
import { describe, expect, it } from 'vitest';
import { resumableFromDatabase, resumeBlockedReason } from './queries';
import { buildResumeContext, cleanContextText } from './resume-context';

const base = {
  title: 'Remise client',
  projectName: 'Devis Express',
  branch: 'feature/remise',
  instructions: ['Ajoute la remise'],
  messages: ['Remise ajoutée.'],
  files: ['src/remise.ts'],
  lastCommit: '4f2a9c1 feat: remise',
};

describe('« Reprendre avec le contexte »: summary of the stored history', () => {
  it('names the session, its branch, the last commit, the owner\'s instructions, Claude\'s messages and the files', () => {
    const text = buildResumeContext(base);
    expect(text.split('\n\n')).toEqual([
      [
        'Reprise de la session « Remise client » du projet Devis Express (Nuera Dev).',
        "La conversation précédente de Claude Code n'a pas pu être rouverte : voici un résumé de l'historique enregistré par Nuera Dev.",
        'Branche : feature/remise.',
        'Dernier commit : 4f2a9c1 feat: remise.',
      ].join('\n'),
      'Dernières instructions :\n1. Ajoute la remise',
      'Derniers messages de Claude :\n- Remise ajoutée.',
      'Fichiers modifiés : src/remise.ts.',
      "Prends connaissance de ce contexte, vérifie l'état du worktree (git status, git log -3), puis résume en quelques lignes où en était le travail et attends mes instructions.",
    ]);
    // Nothing stored: only the head and the request.
    const empty = buildResumeContext({ ...base, branch: null, lastCommit: null, instructions: [], messages: [], files: [] });
    expect(empty).not.toContain('Dernières instructions');
    expect(empty).not.toContain('Branche');
  });

  it('keeps the last 5 instructions and 3 messages, each cut, and never exceeds the cap', () => {
    const many = Array.from({ length: 12 }, (_, i) => `instruction ${i} ${'x'.repeat(2000)}`);
    const text = buildResumeContext({
      ...base,
      instructions: many,
      messages: Array.from({ length: 9 }, (_, i) => `message ${i} ${'y'.repeat(3000)}`),
      files: Array.from({ length: 80 }, (_, i) => `src/fichier-${i}-${'z'.repeat(150)}.ts`),
    });
    expect(text.length).toBeLessThanOrEqual(RESUME_CONTEXT_MAX_CHARS);
    expect(text).not.toContain('instruction 6 ');
    expect(text).toContain('instruction 11 ');
    expect(text).not.toContain('message 5 ');
    expect(text).toContain('message 8 ');
    expect(text).toContain('…');
    expect(text.endsWith('attends mes instructions.')).toBe(true);
  });

  it('never carries a secret: known values of the session, token patterns, values of NAME=value assignments', () => {
    const text = buildResumeContext({
      ...base,
      instructions: ['Configure DATABASE_URL=postgres://u:motdepasse@db/app puis export API_TOKEN="abc123def456"'],
      messages: ['Le jeton ghp_abcdefghijklmnopqrstuvwxyz0123 et la clé sk-ant-api03-abcdefghijkl sont dans .env', 'Valeur secrète : valeur-tres-secrete-42'],
      files: ['.env'],
      secrets: ['valeur-tres-secrete-42'],
    });
    for (const secret of ['motdepasse', 'abc123def456', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'sk-ant-api03-abcdefghijkl', 'valeur-tres-secrete-42']) expect(text).not.toContain(secret);
    expect(text).toContain('DATABASE_URL=[masqué]');
    expect(text).toContain('export API_TOKEN=[masqué]');
    expect(cleanContextText('a'.repeat(50), 10)).toBe(`${'a'.repeat(9)}…`);
  });
});

describe('« Reprendre » rule (database view, same as the runner)', () => {
  const row = (status: Parameters<typeof resumableFromDatabase>[0]['status'], project: { archivedAt?: Date | null; status?: string } = {}) => ({
    status,
    projectArchivedAt: project.archivedAt ?? null,
    projectStatus: project.status ?? 'ready',
  });

  it('offers « Reprendre » for every ended session — interrupted, stopped, failed, finished — whatever its worktree or journal', () => {
    for (const status of ['interrupted', 'stopped', 'failed', 'finished'] as const) {
      expect(resumableFromDatabase(row(status))).toBe(true);
      expect(resumeBlockedReason(row(status), true)).toBeNull();
    }
    for (const status of ['new', 'running', 'waiting_input', 'waiting_permission', 'archived'] as const) expect(resumableFromDatabase(row(status))).toBe(false);
  });

  it('is impossible only for an archived session or project', () => {
    expect(resumableFromDatabase(row('stopped', { archivedAt: new Date() }))).toBe(false);
    expect(resumeBlockedReason(row('stopped', { archivedAt: new Date() }), false)).toBe('project_archived');
    expect(resumableFromDatabase(row('failed', { status: 'archived' }))).toBe(false);
    expect(resumeBlockedReason(row('archived'), false)).toBe('archived');
  });
});
