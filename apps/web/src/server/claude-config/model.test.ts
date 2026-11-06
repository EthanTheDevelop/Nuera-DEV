import { describe, expect, it } from 'vitest';
import {
  classifyCoolifyTool,
  commonConfigHash,
  computeEffective,
  coolifyPermissionRules,
  instanceCoolifyRefusal,
  policyEnv,
  policyEnvSchema,
  policyPermissionRules,
  policyRuleSchema,
  renderRules,
  summaryLine,
  type InstanceConfigRows,
  type McpItem,
} from './model';
import { parseFrontmatter, skillFromZip, validateSkillFiles } from './skill-files';
import { buildZip } from './test/zip';

/*
 * Configuration Claude commune — pure parts (lot K1): who receives what (audience, « Imposé » /
 * « Par défaut », choices of the space), what the CLI is given (rules Markdown, permission rules,
 * variables), Coolify classification and refusal, and the validation of an imported skill (.zip).
 */

const now = '2026-11-06T10:00:00.000Z';

function mcp(overrides: Partial<McpItem>): McpItem {
  return {
    id: 'mcp-1',
    name: 'docs',
    label: 'Docs',
    description: null,
    kind: 'custom',
    transport: 'http',
    url: 'https://docs.example.test/mcp',
    command: null,
    args: [],
    authKind: 'none',
    hasSecrets: false,
    secretKeys: [],
    config: {},
    audience: 'all',
    enforcement: 'default',
    enabled: true,
    status: 'unknown',
    lastCheckedAt: null,
    lastError: null,
    lastTools: [],
    abilities: [],
    abilitiesSource: null,
    version: 1,
    ...overrides,
  };
}

const coolify = mcp({
  id: 'mcp-coolify',
  name: 'coolify-admin',
  label: 'Coolify (administrateurs)',
  kind: 'coolify',
  url: 'https://coolify.example.test',
  authKind: 'bearer',
  hasSecrets: true,
  // Stored « all » by mistake: the model still keeps it for administrators.
  audience: 'all',
  lastTools: ['list_applications', 'get_application', 'deploy', 'get_env_values', 'delete_application'],
  abilities: ['read', 'read:sensitive', 'deploy'],
  abilitiesSource: 'mcp_tools',
  config: { allowWrite: true },
});

function rows(): InstanceConfigRows {
  return {
    rules: [
      { id: 'rule-b', title: 'Tests', body: 'Lance les tests.', enabled: true, position: 1, audience: 'all', enforcement: 'default', version: 2, updatedAt: now },
      { id: 'rule-a', title: 'Secrets', body: 'Jamais de secret dans un commit.', enabled: true, position: 0, audience: 'all', enforcement: 'locked', version: 1, updatedAt: now },
      { id: 'rule-c', title: 'Production', body: 'Coolify : demander avant tout déploiement.', enabled: true, position: 2, audience: 'admins', enforcement: 'locked', version: 1, updatedAt: now },
      { id: 'rule-d', title: 'Brouillon', body: 'Pas encore.', enabled: false, position: 3, audience: 'all', enforcement: 'default', version: 1, updatedAt: now },
    ],
    skills: [
      { id: 'skill-1', name: 'revue', description: 'Relecture', enabled: true, audience: 'all', enforcement: 'default', allowScripts: false, version: 1, contentHash: 'a'.repeat(64), totalBytes: 10, fileCount: 1, updatedAt: now },
      { id: 'skill-2', name: 'nuera-infra', description: 'Infra', enabled: true, audience: 'admins', enforcement: 'locked', allowScripts: true, version: 3, contentHash: 'b'.repeat(64), totalBytes: 10, fileCount: 3, updatedAt: now },
    ],
    mcp: [mcp({}), coolify],
    policy: {
      allow: [{ id: 'perm-allow', rule: 'Bash(npm test:*)', enforcement: 'default' }],
      ask: [{ id: 'perm-ask', rule: 'Bash(git push:*)', enforcement: 'locked' }],
      deny: [{ id: 'perm-deny', rule: 'Bash(rm -rf /*)', enforcement: 'locked' }],
      env: [
        { id: 'env-locked', name: 'NUERA_NORME', value: 'stricte', enforcement: 'locked' },
        { id: 'env-default', name: 'TZ', value: 'Europe/Paris', enforcement: 'default' },
      ],
      defaultModel: 'opus',
      modelEnforcement: 'default',
      version: 4,
      revision: 12,
      updatedAt: now,
    },
  };
}

describe('configuration effective', () => {
  it("un membre ne reçoit jamais ce qui est réservé aux administrateurs, ni Coolify même mal enregistré", () => {
    const member = computeEffective(rows(), 'member', new Set());
    expect(member.rules.map((rule) => rule.title)).toEqual(['Secrets', 'Tests']);
    expect(member.skills.map((skill) => skill.name)).toEqual(['revue']);
    expect(member.mcp.map((server) => server.name)).toEqual(['docs']);
    const admin = computeEffective(rows(), 'admin', new Set());
    expect(admin.rules.map((rule) => rule.title)).toEqual(['Secrets', 'Tests', 'Production']);
    expect(admin.skills.map((skill) => skill.name)).toEqual(['nuera-infra', 'revue']);
    expect(admin.mcp.map((server) => [server.name, server.audience])).toEqual([
      ['coolify-admin', 'admins'],
      ['docs', 'all'],
    ]);
  });

  it("l'espace désactive un élément « Par défaut », jamais un élément « Imposé »", () => {
    const effective = computeEffective(rows(), 'owner', new Set(['rule:rule-b', 'rule:rule-a', 'perm:perm-allow', 'perm:perm-deny', 'env:env-default', 'skill:skill-1']));
    expect(effective.rules.find((rule) => rule.id === 'rule-b')).toMatchObject({ applied: false, disabledBySpace: true });
    expect(effective.rules.find((rule) => rule.id === 'rule-a')).toMatchObject({ applied: true, locked: true, disabledBySpace: false });
    expect(policyPermissionRules(effective)).toEqual({ allow: [], ask: ['Bash(git push:*)'], deny: ['Bash(rm -rf /*)'] });
    expect(policyEnv(effective)).toEqual({ locked: { NUERA_NORME: 'stricte' }, defaults: {} });
    expect(effective.counts).toMatchObject({ rules: 2, skills: 1 });
    expect(summaryLine({ rules: 2, skills: 1, mcp: 2 })).toBe('2 règles · 1 skill · 2 MCP');
  });

  it('rend les règles par défaut et imposées séparément, dans leur ordre', () => {
    const effective = computeEffective(rows(), 'admin', new Set());
    const locked = renderRules(effective.rules, 'locked')!;
    const defaults = renderRules(effective.rules, 'default')!;
    expect(locked).toContain("# Règles imposées par l'administration de Nuera Dev");
    expect(locked.indexOf('## Secrets')).toBeLessThan(locked.indexOf('## Production'));
    expect(locked).not.toContain('## Tests');
    expect(defaults).toContain('## Tests');
    expect(defaults).not.toContain('## Secrets');
    expect(renderRules([], 'default')).toBeNull();
    const a = commonConfigHash({ defaultMarkdown: defaults, lockedMarkdown: locked, skills: [{ name: 'revue', hash: 'a'.repeat(64), version: 1 }] });
    expect(commonConfigHash({ defaultMarkdown: defaults, lockedMarkdown: locked, skills: [{ name: 'revue', hash: 'a'.repeat(64), version: 1 }] })).toBe(a);
    expect(commonConfigHash({ defaultMarkdown: defaults, lockedMarkdown: locked, skills: [{ name: 'revue', hash: 'a'.repeat(64), version: 2 }] })).not.toBe(a);
  });

  it("le modèle n'est imposé que s'il est renseigné", () => {
    const data = rows();
    data.policy.modelEnforcement = 'locked';
    expect(computeEffective(data, 'member', new Set()).model).toEqual({ value: 'opus', locked: true });
    data.policy.defaultModel = null;
    expect(computeEffective(data, 'member', new Set()).model).toEqual({ value: null, locked: false });
  });
});

describe('Coolify (administrateurs)', () => {
  it('classe les outils : lecture autorisée, secrets et écritures demandés, destructeurs refusés', () => {
    expect(classifyCoolifyTool('list_applications')).toBe('read');
    expect(classifyCoolifyTool('get_env_values')).toBe('sensitive');
    expect(classifyCoolifyTool('deploy')).toBe('write');
    expect(classifyCoolifyTool('restart_application')).toBe('write');
    expect(classifyCoolifyTool('manage_application')).toBe('write');
    expect(classifyCoolifyTool('delete_application')).toBe('destructive');
    expect(classifyCoolifyTool('outil_inconnu')).toBe('write');
    expect(coolifyPermissionRules('coolify-admin', coolify.lastTools, { allowWrite: true })).toEqual({
      allow: ['mcp__coolify-admin__get_application', 'mcp__coolify-admin__list_applications'],
      ask: ['mcp__coolify-admin__deploy', 'mcp__coolify-admin__get_env_values'],
      deny: ['mcp__coolify-admin__delete_application'],
    });
    expect(coolifyPermissionRules('coolify-admin', coolify.lastTools, { allowWrite: true, allowDestructive: true }).ask).toContain('mcp__coolify-admin__delete_application');
    expect(coolifyPermissionRules('coolify-admin', coolify.lastTools, { allowWrite: false }).deny).toEqual([
      'mcp__coolify-admin__delete_application',
      'mcp__coolify-admin__deploy',
    ]);
  });

  it("n'est servi qu'après un test réussi, et un jeton qui écrit seulement si l'écriture est proposée", () => {
    expect(instanceCoolifyRefusal({ ...coolify, abilitiesSource: null })).toMatch(/non vérifiés/);
    expect(instanceCoolifyRefusal({ ...coolify, lastTools: [] })).toMatch(/non vérifiés/);
    expect(instanceCoolifyRefusal({ ...coolify, abilities: ['read', 'write'], config: {} })).toMatch(/droit write/);
    expect(instanceCoolifyRefusal({ ...coolify, abilities: ['read', 'write'], config: { allowWrite: true } })).toBeNull();
    expect(instanceCoolifyRefusal({ ...coolify, hasSecrets: false })).toMatch(/Jeton/);
    const admin = computeEffective({ ...rows(), mcp: [{ ...coolify, abilitiesSource: null }] }, 'owner', new Set());
    expect(admin.mcp[0]!.unavailable).toMatch(/non vérifiés/);
    expect(admin.counts.mcp).toBe(0);
  });
});

describe('validation des réglages communs', () => {
  it('accepte les règles de permission Claude Code et refuse le reste', () => {
    for (const rule of ['Bash(git push:*)', 'Bash(rm -rf /*)', 'Edit(src/**)', 'WebFetch', 'mcp__coolify-admin__deploy', 'mcp__github', 'Read(./.env)']) {
      expect(policyRuleSchema.safeParse({ rule }).success, rule).toBe(true);
    }
    for (const rule of ['bash(ls)', 'Bash(a\nb)', '', 'mcp__x__y z', 'Bash(()']) {
      expect(policyRuleSchema.safeParse({ rule }).success, rule).toBe(false);
    }
  });

  it('refuse les variables secrètes ou réservées', () => {
    expect(policyEnvSchema.safeParse({ name: 'TZ', value: 'Europe/Paris' }).success).toBe(true);
    for (const name of ['GITHUB_TOKEN', 'API_KEY', 'DB_PASSWORD', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'PATH', 'GIT_AUTHOR_NAME']) {
      expect(policyEnvSchema.safeParse({ name, value: 'x' }).success, name).toBe(false);
    }
  });
});

describe('import de skill (.zip)', () => {
  const skillMd = '---\nname: nuera-demo\ndescription: >\n  Démo de test\n  sur deux lignes.\n---\n\n# Démo\n';

  it('lit un dossier unique avec SKILL.md, références et scripts (scripts refusés sauf autorisation)', () => {
    const zip = buildZip([
      { name: 'nuera-demo/SKILL.md', content: skillMd },
      { name: 'nuera-demo/references/fiche.md', content: '# Fiche\n' },
      { name: 'nuera-demo/scripts/check.sh', content: '#!/usr/bin/env bash\necho ok\n' },
      { name: 'nuera-demo/scripts/check.ps1', content: 'Write-Output ok\n', stored: true },
      { name: '__MACOSX/nuera-demo/._SKILL.md', content: 'bruit' },
    ]);
    expect(() => skillFromZip(zip, { allowScripts: false })).toThrow(/2 scripts : scripts\/check\.ps1, scripts\/check\.sh/);
    const skill = skillFromZip(zip, { allowScripts: true });
    expect(skill.name).toBe('nuera-demo');
    expect(skill.description).toBe('Démo de test sur deux lignes.');
    expect(skill.files.map((file) => [file.path, file.executable])).toEqual([
      ['SKILL.md', false],
      ['references/fiche.md', false],
      ['scripts/check.ps1', false],
      ['scripts/check.sh', true],
    ]);
    expect(skill.scripts).toEqual(['scripts/check.ps1', 'scripts/check.sh']);
    expect(skill.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuse les archives dangereuses ou invalides', () => {
    const base = [{ name: 'SKILL.md', content: skillMd }];
    expect(() => skillFromZip(buildZip([...base, { name: '../evasion.md', content: 'x' }]), { allowScripts: false })).toThrow(/Chemin refusé/);
    expect(() => skillFromZip(buildZip([...base, { name: '.env', content: 'SECRET=1' }]), { allowScripts: false })).toThrow(/Chemin refusé/);
    expect(() => skillFromZip(buildZip([...base, { name: 'lien', content: '/etc/passwd', mode: 0o120777 }]), { allowScripts: false })).toThrow(/Lien symbolique/);
    expect(() => skillFromZip(buildZip([...base, { name: 'outil.bin', content: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1]) }]), { allowScripts: true })).toThrow(/binaire/);
    expect(() => skillFromZip(buildZip([{ name: 'SKILL.md', content: skillMd, encrypted: true }]), { allowScripts: false })).toThrow(/chiffrée/);
    expect(() => skillFromZip(buildZip([{ name: 'README.md', content: '# rien' }]), { allowScripts: false })).toThrow(/SKILL\.md introuvable/);
    expect(() => skillFromZip(buildZip([{ name: 'SKILL.md', content: '---\nname: Mauvais Nom\ndescription: x\n---\n' }]), { allowScripts: false })).toThrow(/Nom de skill invalide/);
    expect(() => skillFromZip(buildZip([{ name: 'SKILL.md', content: '---\nname: ok\n---\n' }]), { allowScripts: false })).toThrow(/description requis/);
    expect(() => skillFromZip(Buffer.from('pas un zip'), { allowScripts: false })).toThrow(/pas une archive/);
    const corrupted = buildZip(base);
    corrupted[40] = (corrupted[40]! + 1) % 256;
    expect(() => skillFromZip(corrupted, { allowScripts: false })).toThrow();
  });

  it("valide aussi un skill saisi dans l'éditeur (nom attendu)", () => {
    expect(() => validateSkillFiles([{ path: 'SKILL.md', content: skillMd }], { allowScripts: false, expectedName: 'autre' })).toThrow(/ne correspond pas/);
    expect(parseFrontmatter(skillMd)).toEqual({ name: 'nuera-demo', description: 'Démo de test sur deux lignes.', hasFrontmatter: true });
  });
});
