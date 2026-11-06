import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMMON_SKILL_MARKER, type CommonConfigPayload, type CommonSkill } from '@nuera/shared/runner';
import { CommonConfigSync, validateSkillFiles } from '../src/claude/common-config';
import { buildSettings } from '../src/sessions/runtime-files';

/**
 * Configuration Claude commune on the disk of a server (lot K1): what the runner writes in the Claude
 * folder (skills, user-level rules) and in its own folder (« Imposé » rules), atomically, and what it
 * never touches (credentials, account file, the account's own skills, other rules).
 */

const logger = pino({ level: 'silent' });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function skill(name: string, files: Array<{ path: string; content: string; executable?: boolean }>, version = 1): CommonSkill {
  const normalized = files.map((file) => ({ path: file.path, content: file.content, executable: file.executable ?? false }));
  return { id: `id-${name}`, name, description: `Skill ${name}`, version, hash: sha(JSON.stringify(normalized)), locked: false, files: normalized };
}

function payload(input: { skills?: CommonSkill[]; defaultMarkdown?: string | null; lockedMarkdown?: string | null; revision?: number }): CommonConfigPayload {
  const skills = input.skills ?? [];
  return {
    hash: sha(JSON.stringify([skills.map((s) => [s.name, s.hash]), input.defaultMarkdown ?? null, input.lockedMarkdown ?? null])),
    revision: input.revision ?? 1,
    generatedAt: new Date().toISOString(),
    rules: {
      defaultMarkdown: input.defaultMarkdown ?? null,
      lockedMarkdown: input.lockedMarkdown ?? null,
      items: [],
    },
    skills,
  };
}

/** Fake web: serves the next payload, omits the files of the skills the runner already has. */
class FakeWeb {
  next: CommonConfigPayload | null = null;
  calls: Array<Array<{ name: string; hash: string }>> = [];
  async claudeConfig(have: Array<{ name: string; hash: string }>): Promise<unknown | null> {
    this.calls.push(have);
    if (!this.next) return null;
    return {
      ...this.next,
      skills: this.next.skills.map((s) => (have.some((h) => h.name === s.name && h.hash === s.hash) ? { ...s, files: null } : s)),
    };
  }
}

let root: string;
let claudeDir: string;
let dataDir: string;
let web: FakeWeb;
let sync: CommonConfigSync;
const CREDENTIALS = '{"claudeAiOauth":{"accessToken":"ne-jamais-lire"}}';
const ACCOUNT = '{"oauthAccount":{"emailAddress":"camille@example.test"}}';

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'nuera-common-'));
  claudeDir = path.join(root, 'claude');
  dataDir = path.join(root, 'data');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(path.join(claudeDir, '.credentials.json'), CREDENTIALS, { mode: 0o600 });
  writeFileSync(path.join(claudeDir, '.claude.json'), ACCOUNT);
  writeFileSync(path.join(claudeDir, 'settings.json'), '{"theme":"dark"}');
  web = new FakeWeb();
  sync = new CommonConfigSync({ claudeConfigDir: claudeDir, dataDir, web, logger });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const untouched = () => {
  expect(readFileSync(path.join(claudeDir, '.credentials.json'), 'utf8')).toBe(CREDENTIALS);
  expect(readFileSync(path.join(claudeDir, '.claude.json'), 'utf8')).toBe(ACCOUNT);
  expect(readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}');
};

describe('configuration commune : écriture sur le serveur', () => {
  it('écrit les skills (marqués, en lecture seule) et les règles par défaut et imposées', async () => {
    web.next = payload({
      skills: [
        skill('revue', [
          { path: 'SKILL.md', content: '---\nname: revue\ndescription: Relecture\n---\nRelis.' },
          { path: 'references/guide.md', content: '# Guide' },
          { path: 'scripts/check.sh', content: 'echo ok', executable: true },
        ]),
      ],
      defaultMarkdown: '# Règles communes\n\nCommits sobres.',
      lockedMarkdown: '# Règles imposées\n\nJamais de secret.',
    });
    const status = await sync.sync('manual');
    expect(status.error).toBeNull();
    expect(status.skills).toEqual([{ name: 'revue', version: 1, hash: web.next.skills[0]!.hash }]);
    expect(status.rules).toEqual({ defaultFile: true, lockedFile: true, count: 0 });
    expect(readFileSync(path.join(claudeDir, 'skills', 'revue', 'SKILL.md'), 'utf8')).toContain('Relis.');
    expect(readFileSync(path.join(claudeDir, 'skills', 'revue', 'references', 'guide.md'), 'utf8')).toBe('# Guide');
    const marker = JSON.parse(readFileSync(path.join(claudeDir, 'skills', 'revue', COMMON_SKILL_MARKER), 'utf8'));
    expect(marker).toMatchObject({ managedBy: 'nuera-dev', name: 'revue', version: 1 });
    // Windows has no Unix mode bits: only « read-only » is meaningful there.
    const mode = (file: string) => statSync(path.join(claudeDir, 'skills', 'revue', file)).mode & (process.platform === 'win32' ? 0o200 : 0o777);
    expect([mode('SKILL.md'), mode('scripts/check.sh')]).toEqual(process.platform === 'win32' ? [0, 0] : [0o444, 0o555]);
    expect(readFileSync(path.join(claudeDir, 'rules', 'nuera-commun.md'), 'utf8')).toContain('Commits sobres.');
    expect(sync.lockedRulesFile()).toBe(path.join(dataDir, 'claude-commun', 'regles-imposees.md'));
    expect(readFileSync(sync.lockedRulesFile()!, 'utf8')).toContain('Jamais de secret.');
    untouched();
  });

  it("remplace une nouvelle version d'un coup, ne renvoie pas les fichiers connus, supprime ce qui ne s'applique plus", async () => {
    const v1 = skill('revue', [{ path: 'SKILL.md', content: 'v1' }, { path: 'old.md', content: 'ancien' }]);
    const other = skill('tests', [{ path: 'SKILL.md', content: 'tests' }]);
    web.next = payload({ skills: [v1, other], defaultMarkdown: 'règle' });
    await sync.sync();
    // Unchanged: the web omits the files, the folder stays.
    web.next = payload({ skills: [v1, other], defaultMarkdown: 'règle' });
    await sync.sync();
    expect(web.calls.at(-1)).toEqual(expect.arrayContaining([{ name: 'revue', hash: v1.hash }]));
    expect(readFileSync(path.join(claudeDir, 'skills', 'revue', 'old.md'), 'utf8')).toBe('ancien');
    // New version: old file gone, new content in place; `tests` removed; rules removed.
    const v2 = skill('revue', [{ path: 'SKILL.md', content: 'v2' }], 2);
    web.next = payload({ skills: [v2] });
    const status = await sync.sync();
    expect(status.skills.map((s) => [s.name, s.version])).toEqual([['revue', 2]]);
    expect(readFileSync(path.join(claudeDir, 'skills', 'revue', 'SKILL.md'), 'utf8')).toBe('v2');
    expect(existsSync(path.join(claudeDir, 'skills', 'revue', 'old.md'))).toBe(false);
    expect(existsSync(path.join(claudeDir, 'skills', 'tests'))).toBe(false);
    expect(existsSync(path.join(claudeDir, 'rules', 'nuera-commun.md'))).toBe(false);
    expect(sync.lockedRulesFile()).toBeNull();
    // No scratch folder left behind.
    expect(readdirSync(path.join(claudeDir, 'skills')).filter((name) => name.startsWith('.nuera-'))).toEqual([]);
    untouched();
  });

  it("ne touche jamais un skill ni une règle de l'utilisateur, et nettoie un dossier temporaire abandonné", async () => {
    mkdirSync(path.join(claudeDir, 'skills', 'revue'), { recursive: true });
    writeFileSync(path.join(claudeDir, 'skills', 'revue', 'SKILL.md'), 'le mien');
    mkdirSync(path.join(claudeDir, 'skills', 'perso'), { recursive: true });
    writeFileSync(path.join(claudeDir, 'skills', 'perso', 'SKILL.md'), 'perso');
    mkdirSync(path.join(claudeDir, 'skills', '.nuera-tmp-abandon'), { recursive: true });
    mkdirSync(path.join(claudeDir, 'rules'), { recursive: true });
    writeFileSync(path.join(claudeDir, 'rules', 'mes-regles.md'), 'les miennes');
    web.next = payload({ skills: [skill('revue', [{ path: 'SKILL.md', content: 'commun' }])] });
    const status = await sync.sync();
    expect(status.skills).toEqual([]);
    expect(status.conflicts).toEqual([{ name: 'revue', reason: expect.stringContaining('sans être géré par Nuera Dev') }]);
    expect(readFileSync(path.join(claudeDir, 'skills', 'revue', 'SKILL.md'), 'utf8')).toBe('le mien');
    expect(readFileSync(path.join(claudeDir, 'skills', 'perso', 'SKILL.md'), 'utf8')).toBe('perso');
    expect(existsSync(path.join(claudeDir, 'skills', '.nuera-tmp-abandon'))).toBe(false);
    // Empty configuration: the account's own skill and rules stay.
    web.next = payload({});
    await sync.sync();
    expect(readFileSync(path.join(claudeDir, 'skills', 'perso', 'SKILL.md'), 'utf8')).toBe('perso');
    expect(readFileSync(path.join(claudeDir, 'rules', 'mes-regles.md'), 'utf8')).toBe('les miennes');
    untouched();
  });

  it("refuse les chemins dangereux et n'écrit rien d'un skill refusé", async () => {
    const bad = skill('evasion', [{ path: 'SKILL.md', content: 'x' }]);
    bad.files!.push({ path: '../../.credentials.json', content: 'volé', executable: false });
    web.next = payload({ skills: [bad] });
    // The schema refuses the whole payload (unsafe path): previous copy kept, nothing written.
    const status = await sync.sync();
    expect(status.error).toMatch(/illisible/);
    expect(existsSync(path.join(claudeDir, 'skills', 'evasion'))).toBe(false);
    expect(validateSkillFiles({ files: [{ path: 'README.md', content: '', executable: false }] })).toBe('SKILL.md manquant.');
    expect(validateSkillFiles({ files: [{ path: 'SKILL.md', content: '', executable: false }, { path: COMMON_SKILL_MARKER, content: '', executable: false }] })).toMatch(/Chemin refusé/);
    untouched();
  });

  it("garde la copie précédente quand le web est injoignable, et n'écrit rien sans configuration", async () => {
    const empty = new CommonConfigSync({ claudeConfigDir: claudeDir, dataDir, web: new FakeWeb(), logger });
    const status = await empty.sync('start');
    expect(status.hash).toBeNull();
    expect(status.error).toMatch(/copie précédente/);
    expect(existsSync(path.join(claudeDir, 'skills'))).toBe(false);
    expect(existsSync(path.join(claudeDir, 'rules'))).toBe(false);
    untouched();
  });

  it('refuse un dossier skills qui est un lien vers ailleurs', async () => {
    if (process.platform === 'win32') return;
    const elsewhere = path.join(root, 'ailleurs');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, path.join(claudeDir, 'skills'));
    web.next = payload({ skills: [skill('revue', [{ path: 'SKILL.md', content: 'x' }])] });
    const status = await sync.sync();
    expect(status.error).toMatch(/lien refusé/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("ensure() ne resynchronise que si l'empreinte diffère, et l'état survit à un redémarrage", async () => {
    web.next = payload({ defaultMarkdown: 'règle', revision: 3 });
    await sync.ensure(web.next.hash);
    expect(web.calls).toHaveLength(1);
    await sync.ensure(web.next.hash);
    expect(web.calls).toHaveLength(1);
    const restarted = new CommonConfigSync({ claudeConfigDir: claudeDir, dataDir, web, logger });
    expect((await restarted.current()).revision).toBe(3);
    await restarted.ensure(web.next.hash);
    expect(web.calls).toHaveLength(1);
    await restarted.ensure('f'.repeat(64));
    expect(web.calls).toHaveLength(2);
  });

  it('deux synchronisations simultanées ne se chevauchent pas', async () => {
    web.next = payload({ skills: [skill('revue', [{ path: 'SKILL.md', content: 'x' }])] });
    const [a, b] = await Promise.all([sync.sync(), sync.sync()]);
    expect(a.skills).toHaveLength(1);
    expect(b.skills).toHaveLength(1);
    expect(readdirSync(path.join(claudeDir, 'skills')).sort()).toEqual(['revue']);
  });
});

describe('réglages de session : permissions et variables communes', () => {
  it('fusionne allow / ask / deny sans doublon et écrit les variables imposées', () => {
    const settings = buildSettings({
      permissionWaitSeconds: 120,
      denyRules: ['Bash(rm -rf /*)', 'Bash(rm -rf /*)'],
      allowRules: ['mcp__coolify-admin__list_applications'],
      askRules: ['Bash(git push:*)', 'mcp__coolify-admin__deploy'],
      env: { NUERA_NORME: 'stricte' },
    }) as { permissions: Record<string, string[]>; env: Record<string, string> };
    expect(settings.permissions).toEqual({
      allow: ['mcp__coolify-admin__list_applications'],
      ask: ['Bash(git push:*)', 'mcp__coolify-admin__deploy'],
      deny: ['Bash(rm -rf /*)'],
    });
    expect(settings.env).toEqual({ NUERA_NORME: 'stricte' });
    const bare = buildSettings({ permissionWaitSeconds: 120, denyRules: [] }) as Record<string, unknown>;
    expect(bare.permissions).toBeUndefined();
    expect(bare.env).toBeUndefined();
  });
});
