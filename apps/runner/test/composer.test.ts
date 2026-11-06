import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ATTACHMENT_DIR,
  SessionSlashCommandRequestSchema,
  slashCommandText,
  type AttachmentDto,
  type PermissionModeResult,
  type SessionCommandResult,
  type SessionDto,
  type SessionSkillsResponse,
} from '@nuera/shared/runner';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attachmentStamp,
  checkAttachmentContent,
  detectPermissionMode,
  parseSkillFrontmatter,
  sanitizeAttachmentName,
} from '../src/sessions/composer-tools';
import {
  auth,
  createBareRemote,
  dbReady,
  git,
  seedProject,
  startTestRunner,
  tmpDir,
  waitFor,
  type TestEnv,
} from './helpers';

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);

describe('composer: pure helpers', () => {
  it('sanitises the uploaded name (never a path, accents and spaces removed, extension kept)', () => {
    expect(sanitizeAttachmentName("Capture d'écran 2026-11-06 à 14.25.PNG")).toBe(
      'capture-d-ecran-2026-11-06-a-14.25.png',
    );
    expect(sanitizeAttachmentName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeAttachmentName('..\\..\\secret.txt')).toBe('secret.txt');
    expect(sanitizeAttachmentName('...png')).toBe('fichier.png');
    expect(sanitizeAttachmentName(`${'a'.repeat(200)}.md`)).toHaveLength(80);
    expect(attachmentStamp(new Date(2026, 10, 6, 14, 5, 9))).toBe('20261106-140509');
  });

  it('checks the bytes against the announced type', () => {
    expect(checkAttachmentContent('a.png', 'image', PNG)).toBe('image/png');
    expect(() => checkAttachmentContent('a.jpg', 'image', PNG)).toThrow(/n'est pas une image JPEG/);
    expect(() => checkAttachmentContent('a.png', 'image', Buffer.from('<svg/>'))).toThrow(
      /image PNG/,
    );
    expect(checkAttachmentContent('a.pdf', 'pdf', Buffer.from('%PDF-1.7\n'))).toBe(
      'application/pdf',
    );
    expect(() => checkAttachmentContent('a.pdf', 'pdf', Buffer.from('hello'))).toThrow(/PDF/);
    expect(checkAttachmentContent('notes.md', 'text', Buffer.from('# Titre\nÉté'))).toMatch(
      /^text\/plain/,
    );
    expect(() => checkAttachmentContent('notes.md', 'text', Buffer.from([0x41, 0, 0x42]))).toThrow(
      /binaires/,
    );
    expect(() => checkAttachmentContent('notes.md', 'text', Buffer.from([0xc3, 0x28]))).toThrow(
      /UTF-8/,
    );
    expect(() => checkAttachmentContent('notes.md', 'text', Buffer.alloc(0))).toThrow(/vide/);
  });

  it('reads the permission mode from the footer of the CLI screen', () => {
    expect(detectPermissionMode('> \n⏵⏵ accept edits on (shift+tab to cycle)')).toBe('acceptEdits');
    expect(detectPermissionMode('> \n  ⏵⏵ auto-accept edits on (shift+tab to cycle)')).toBe(
      'acceptEdits',
    );
    expect(detectPermissionMode('⏸ plan mode on (shift+tab to cycle)\n> ')).toBe('plan');
    expect(detectPermissionMode('> \n⏵⏵ auto mode on (shift+tab to cycle)')).toBe('auto');
    expect(detectPermissionMode('> \n? for shortcuts')).toBe('manual');
    // An old footer far above the prompt does not count.
    expect(
      detectPermissionMode(
        ['⏸ plan mode on', ...Array.from({ length: 10 }, (_, i) => `ligne ${i}`), '> '].join('\n'),
      ),
    ).toBe('manual');
    expect(detectPermissionMode('\n \n')).toBeNull();
  });

  it('parses the SKILL.md front matter', () => {
    expect(
      parseSkillFrontmatter(
        '---\nname: revue-pr\ndescription: "Relit une pull request"\n---\n# Corps',
      ),
    ).toEqual({ name: 'revue-pr', description: 'Relit une pull request' });
    expect(
      parseSkillFrontmatter(
        '---\nname: deploy\ndescription: >\n  Déploie sur Coolify\n  après les tests.\n---\n',
      ),
    ).toEqual({ name: 'deploy', description: 'Déploie sur Coolify après les tests.' });
    expect(parseSkillFrontmatter('# pas de front matter')).toEqual({
      name: null,
      description: null,
    });
  });

  it('only accepts the allowlisted slash commands, with a safe argument', () => {
    expect(
      slashCommandText(
        SessionSlashCommandRequestSchema.parse({ command: 'model', model: 'sonnet' }),
      ),
    ).toBe('/model sonnet');
    expect(SessionSlashCommandRequestSchema.parse({ command: 'model', model: 'opus[1m]' })).toEqual(
      { command: 'model', model: 'opus[1m]' },
    );
    for (const bad of [
      { command: 'exit' },
      { command: 'login' },
      { command: 'model', model: 'sonnet\r/exit' },
      { command: 'model', model: 'sonnet \u001b[Z' },
      { command: 'model', model: '' },
      { command: 'model', model: 'sonnet', extra: 1 },
    ]) {
      expect(SessionSlashCommandRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });
});

describe.skipIf(!dbReady)(
  'composer: attachments, skills, model and mode (fake CLI, PTY backend)',
  () => {
    let env: TestEnv;
    let projectId: string;
    let sessionId: string;
    let worktreePath: string;
    let claudeConfig: string;

    const inject = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
      env.runner.api.inject({
        method,
        url,
        headers: {
          ...auth,
          ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
      });
    const session = async () =>
      (await inject('GET', `/v1/sessions/${sessionId}`)).json() as SessionDto;
    const upload = (name: string, data: Buffer) =>
      inject('POST', `/v1/sessions/${sessionId}/attachments`, {
        name,
        contentType: '',
        dataBase64: data.toString('base64'),
      });

    beforeAll(async () => {
      claudeConfig = tmpDir('claude-config');
      mkdirSync(path.join(claudeConfig, 'projects'), { recursive: true });
      env = await startTestRunner({ claudeConfigDir: claudeConfig });
      const remote = createBareRemote(env.dirs.remotes, 'nuera-studio/composeur');
      const target = path.join(env.dirs.projects, 'composeur');
      git(env.dirs.projects, 'clone', remote.bare, target);
      projectId = (
        await seedProject(env.db, {
          fullName: 'nuera-studio/composeur',
          path: target,
          slug: 'composeur',
        })
      ).id;
      const res = await inject('POST', '/v1/sessions', {
        projectId,
        title: 'Compositeur',
        worktree: { mode: 'new', branch: 'feature/composeur' },
      });
      if (res.statusCode !== 200) throw new Error(`création de session : ${res.statusCode}`);
      const dto = res.json() as SessionDto;
      sessionId = dto.id;
      worktreePath = dto.worktree!.path;
    }, 600_000);

    afterAll(async () => {
      await env?.close();
    }, 600_000);

    it('writes an attachment in the worktree, git-ignored through info/exclude only', async () => {
      const res = await upload("Capture d'écran.png", PNG);
      expect(res.statusCode).toBe(200);
      const dto = res.json() as AttachmentDto;
      expect(dto).toMatchObject({
        name: "Capture d'écran.png",
        size: PNG.length,
        kind: 'image',
        contentType: 'image/png',
      });
      expect(dto.path).toMatch(/^\.nuera\/pieces-jointes\/\d{8}-\d{6}-capture-d-ecran\.png$/);
      expect(readFileSync(path.join(worktreePath, dto.path))).toEqual(PNG);
      // Same name in the same second: a distinct file, never an overwrite.
      const again = (await upload("Capture d'écran.png", PNG)).json() as AttachmentDto;
      expect(again.path).not.toBe(dto.path);

      const exclude = git(worktreePath, 'rev-parse', '--git-path', 'info/exclude');
      expect(
        readFileSync(path.resolve(worktreePath, exclude), 'utf8').match(/^\/\.nuera\/$/gm),
      ).toHaveLength(1);
      expect(git(worktreePath, 'status', '--porcelain', '--untracked-files=all')).toBe('');
      expect(existsSync(path.join(worktreePath, '.gitignore'))).toBe(false);
    }, 120_000);

    it('refuses other types, mismatched bytes and oversized bodies without writing anything', async () => {
      const before = git(
        worktreePath,
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        ATTACHMENT_DIR,
      )
        .split('\n')
        .filter(Boolean).length;
      const exe = await upload('setup.exe', Buffer.from('MZ'));
      expect(exe.statusCode).toBe(400);
      expect(exe.json()).toMatchObject({
        error: { reason: 'ATTACHMENT_REFUSED', untouched: "Aucun fichier n'a été écrit." },
      });
      expect((await upload('.env', Buffer.from('SECRET=1'))).statusCode).toBe(400);
      expect((await upload('photo.heic', Buffer.from('ftypheic'))).statusCode).toBe(400);
      expect((await upload('faux.png', Buffer.from('pas une image'))).statusCode).toBe(400);
      const huge = await inject('POST', `/v1/sessions/${sessionId}/attachments`, {
        name: 'gros.txt',
        dataBase64: 'A'.repeat(28_000_000),
      });
      expect(huge.statusCode).toBe(400);
      const after = git(
        worktreePath,
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        ATTACHMENT_DIR,
      )
        .split('\n')
        .filter(Boolean).length;
      expect(after).toBe(before);
    }, 120_000);

    it('refuses a folder replaced by a link out of the worktree', async () => {
      const outside = tmpDir('dehors');
      rmSync(path.join(worktreePath, '.nuera'), { recursive: true, force: true });
      symlinkSync(outside, path.join(worktreePath, '.nuera'), 'dir');
      const res = await upload('notes.md', Buffer.from('# notes'));
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { reason: 'PATH_REJECTED' } });
      expect(existsSync(path.join(outside, 'pieces-jointes'))).toBe(false);
      rmSync(path.join(worktreePath, '.nuera'));
      expect((await upload('notes.md', Buffer.from('# notes'))).statusCode).toBe(200);
    }, 120_000);

    it('lists the skills of the worktree and of the CLI config dir', async () => {
      mkdirSync(path.join(worktreePath, '.claude', 'skills', 'revue'), { recursive: true });
      writeFileSync(
        path.join(worktreePath, '.claude', 'skills', 'revue', 'SKILL.md'),
        '---\nname: revue\ndescription: Relit le diff du worktree\n---\n',
      );
      mkdirSync(path.join(worktreePath, '.claude', 'skills', 'sans-nom'), { recursive: true });
      writeFileSync(
        path.join(worktreePath, '.claude', 'skills', 'sans-nom', 'SKILL.md'),
        '# Corps seulement',
      );
      mkdirSync(path.join(claudeConfig, 'skills', 'deploiement'), { recursive: true });
      writeFileSync(
        path.join(claudeConfig, 'skills', 'deploiement', 'SKILL.md'),
        '---\nname: deploiement\ndescription: Déploie sur Coolify\n---\n',
      );
      const res = await inject('GET', `/v1/sessions/${sessionId}/skills`);
      expect(res.statusCode).toBe(200);
      expect((res.json() as SessionSkillsResponse).skills).toEqual([
        { name: 'revue', description: 'Relit le diff du worktree', source: 'project' },
        { name: 'sans-nom', description: null, source: 'project' },
        { name: 'deploiement', description: 'Déploie sur Coolify', source: 'user' },
      ]);
    }, 120_000);

    it('stores the mode and the model for the next launch while no CLI runs', async () => {
      const mode = await inject('POST', `/v1/sessions/${sessionId}/permission-mode`, {
        mode: 'acceptEdits',
      });
      expect(mode.statusCode).toBe(200);
      expect(mode.json()).toMatchObject({
        applied: 'next_launch',
        presses: 0,
        mode: 'acceptEdits',
        session: { permissionMode: 'acceptEdits' },
      });
      expect(
        (
          await inject('POST', `/v1/sessions/${sessionId}/permission-mode`, {
            mode: 'bypassPermissions',
          })
        ).statusCode,
      ).toBe(400);
      const model = await inject('POST', `/v1/sessions/${sessionId}/command`, {
        command: 'model',
        model: 'haiku',
      });
      expect(model.json()).toMatchObject({ applied: 'next_launch', session: { model: 'haiku' } });
      expect(
        (await inject('POST', `/v1/sessions/${sessionId}/command`, { command: 'exit' })).statusCode,
      ).toBe(400);
    }, 120_000);

    it('cycles the live CLI with Maj+Tab until its screen shows the mode, and types /model', async () => {
      const res = await inject('POST', `/v1/sessions/${sessionId}/instruction`, {
        text: 'Bonjour',
      });
      expect(res.statusCode).toBe(200);
      await waitFor(
        async () => {
          const s = await session();
          return s.live && s.status === 'waiting_input' ? s : null;
        },
        { timeoutMs: 300_000, intervalMs: 500, label: 'CLI prêt' },
      );
      // Launched with --permission-mode acceptEdits (stored above): acceptEdits → plan is one press.
      const plan = await inject('POST', `/v1/sessions/${sessionId}/permission-mode`, {
        mode: 'plan',
      });
      expect(plan.statusCode).toBe(200);
      expect(plan.json() as PermissionModeResult).toMatchObject({
        applied: 'live',
        presses: 1,
        mode: 'plan',
        session: { permissionMode: 'plan' },
      });
      // plan → auto → default: two presses.
      const manual = await inject('POST', `/v1/sessions/${sessionId}/permission-mode`, {
        mode: 'manual',
      });
      expect(manual.json()).toMatchObject({ applied: 'live', presses: 2, mode: 'manual' });
      // The next hooks carry the CLI's mode: still Manual.
      await inject('POST', `/v1/sessions/${sessionId}/instruction`, { text: 'Encore' });
      await waitFor(async () => ((await session()).status === 'waiting_input' ? true : null), {
        timeoutMs: 120_000,
        intervalMs: 300,
        label: 'tour terminé',
      });
      expect((await session()).permissionMode).toBe('manual');

      const model = await inject('POST', `/v1/sessions/${sessionId}/command`, {
        command: 'model',
        model: 'sonnet',
      });
      expect(model.statusCode).toBe(200);
      expect(model.json() as SessionCommandResult).toMatchObject({
        applied: 'live',
        session: { model: 'sonnet' },
      });
      // The chip follows the status line: the model the CLI reports.
      await waitFor(
        async () => ((await session()).cliStatus?.model?.id === 'sonnet' ? true : null),
        { timeoutMs: 30_000, intervalMs: 300, label: 'status line' },
      );
    }, 600_000);
  },
);
