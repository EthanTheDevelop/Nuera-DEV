import { describe, expect, it } from 'vitest';
import { AUTO_ANSWERED_KINDS, detectScreen, SCREEN_PATTERNS } from '../src/sessions/screen-attention';
import { attentionNotificationCopy } from '../src/sessions/manager';

/**
 * Screens of the official CLI as the headless mirror renders them (ANSI already interpreted, frames
 * kept): first run, login, trust, bypass warning, Remote Control, `.mcp.json`, splash, menus — plus
 * normal screens that must NOT be reported.
 */
const SNAPSHOTS = {
  // First-run theme picker, numbered (2.x) and with the check mark first (as seen on a phone).
  theme: `╭───────────────────────────────────────────────╮
│ ✻ Welcome to Claude Code                      │
╰───────────────────────────────────────────────╯

 Let's get started.

 Choose the text style that looks best with your terminal
 To change this later, run /theme

 ❯ 1. Dark mode ✔
   2. Light mode
   3. Dark mode (colorblind-friendly)
   4. Light mode (colorblind-friendly)
   5. Dark mode (ANSI colors only)
   6. Light mode (ANSI colors only)

╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 1  function greet() {
 2 -  console.log("Hello, World!");
 2 +  console.log("Hello, Claude!");
 3  }
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌`,
  themeCheck: ` Let's get started.

 Choose the text style that looks best with your terminal

 ❯ ✔ Dark mode
     Light mode
     Dark mode (colorblind-friendly)`,
  login: ` Claude Code can be used with your Claude subscription or billed based on API usage through your Console account.

 Select login method:

 ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise
   2. Anthropic Console account · API usage billing
   3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI`,
  loginPaste: ` Browser didn't open? Use the url below to sign in (c to copy)

 https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&state=Zx8Qy2Rk7Pm3Lw9Ns4Tv6Ab1Cd5Ef0Gh

 Paste code here if prompted > aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd#efgh`,
  loginExpired: `> refactor the parser
  ⎿  Login expired · Please run /login

────────────────────────────────────────────────────────
>
────────────────────────────────────────────────────────
  ? for shortcuts`,
  trust: ` Accessing workspace:

 /srv/dev/devis-express/.worktrees/remise

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open
 source project, or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel`,
  trustOld: `╭──────────────────────────────────────────────╮
│ Do you trust the files in this folder?       │
│                                              │
│ /srv/dev/devis-express                       │
│                                              │
│ ❯ 1. Yes, proceed                            │
│   2. No, exit                                │
╰──────────────────────────────────────────────╯`,
  bypass: ` WARNING: Claude Code running in Bypass Permissions mode

 In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous
 commands.
 This mode should only be used in a sandboxed container/VM that has restricted internet access.

 By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.

 ❯ 1. No, exit
   2. Yes, I accept`,
  remote: ` Remote Control lets you continue this session from claude.ai/code or the Claude app.

 Enable Remote Control? (y/n)`,
  mcp: ` New MCP server found in .mcp.json: coolify

 MCP servers may execute code or access system resources. All tool calls require approval.

 ❯ 1. Use this and all future MCP servers in this project
   2. Use this MCP server
   3. Continue without using this MCP server`,
  splash: ` Security notes:

 1. Claude can make mistakes
    You should always review Claude's responses, especially when running code.

 2. Due to prompt injection risks, only use it with code you trust
    For more details see: https://code.claude.com/docs/en/security

 Press Enter to continue…`,
  terminalSetup: ` Use Claude Code's terminal setup?

 For the optimal coding experience, enable the recommended settings for your terminal: Shift+Enter for newlines

 ❯ 1. Yes, use recommended settings
   2. No, maybe later with /terminal-setup

 Enter to confirm · Esc to skip`,
  prompt: `✻ Welcome to Claude Code!

  /help for help, /status for your current setup

  cwd: /srv/dev/devis-express

────────────────────────────────────────────────────────
> Try "refactor parser.ts"
────────────────────────────────────────────────────────
  ? for shortcuts                       ⏵⏵ bypass permissions on (shift+tab to cycle)`,
  working: `> Ajoute un test pour la remise
● Je lis d'abord les conventions du dépôt.
● Read(CLAUDE.md)
  ⎿  Read 42 lines
✻ Cogitating… (12s · ↑ 1.2k tokens · esc to interrupt)`,
  answerWithList: `● Voici le plan :
  1. Lire CLAUDE.md
  2. Modifier src/index.ts
  3. Lancer les tests
────────────────────────────────────────────────────────
>
────────────────────────────────────────────────────────`,
};

describe('screen detection of the official CLI (snapshots, ANSI stripped)', () => {
  it.each([
    ['theme', 'theme'],
    ['themeCheck', 'theme'],
    ['login', 'login'],
    ['loginPaste', 'login'],
    ['loginExpired', 'login'],
    ['trust', 'trust'],
    ['trustOld', 'trust'],
    ['bypass', 'bypass_warning'],
    ['remote', 'remote_control'],
    ['mcp', 'mcp_servers'],
    ['splash', 'continue'],
    ['terminalSetup', 'menu'],
  ] as const)('%s → %s', (name, kind) => {
    const found = detectScreen(SNAPSHOTS[name]);
    expect(found?.kind).toBe(kind);
    expect(found!.text.length).toBeGreaterThan(0);
    expect(found!.text.length).toBeLessThanOrEqual(400);
    expect(found!.text).not.toMatch(/[│╭╮╰╯─]/);
  });

  it('reports nothing on the normal prompt, while Claude works, nor on a numbered answer', () => {
    expect(detectScreen(SNAPSHOTS.prompt)).toBeNull();
    expect(detectScreen(SNAPSHOTS.working)).toBeNull();
    expect(detectScreen(SNAPSHOTS.answerWithList)).toBeNull();
    expect(detectScreen('')).toBeNull();
  });

  it('answers automatically only the theme picker and the « Press Enter to continue » splash', () => {
    expect([...AUTO_ANSWERED_KINDS].sort()).toEqual(['continue', 'theme']);
    for (const name of ['login', 'loginPaste', 'trust', 'trustOld', 'bypass', 'remote', 'mcp', 'terminalSetup'] as const) {
      expect(AUTO_ANSWERED_KINDS.has(detectScreen(SNAPSHOTS[name])!.kind), name).toBe(false);
    }
  });

  it('never takes a screen that grants rights for a cosmetic one (fragments mixed)', () => {
    // A trust dialog that also says « Press Enter to continue » stays a trust dialog.
    expect(detectScreen(`${SNAPSHOTS.trust}\n Press Enter to continue…`)?.kind).toBe('trust');
    // Light/dark words next to a bypass warning: the warning wins.
    expect(detectScreen(`${SNAPSHOTS.bypass}\n Dark mode / Light mode`)?.kind).toBe('bypass_warning');
    // A splash with a choice is not « just continue ».
    expect(detectScreen(`${SNAPSHOTS.terminalSetup}\n Press Enter to continue`)?.kind).toBe('menu');
    // Every rights-granting kind comes before the cosmetic ones in the table.
    const order = SCREEN_PATTERNS.map((p) => p.kind);
    for (const kind of ['login', 'trust', 'bypass_warning', 'remote_control', 'mcp_servers'] as const) {
      expect(order.indexOf(kind)).toBeLessThan(order.indexOf('theme'));
      expect(order.indexOf(kind)).toBeLessThan(order.indexOf('continue'));
    }
  });

  it('keeps the folder of a trust dialog but never a login code nor OAuth parameters', () => {
    const trust = detectScreen(SNAPSHOTS.trust)!;
    expect(trust.text).toContain('/srv/dev/devis-express/.worktrees/remise');
    expect(trust.text).toContain('Yes, I trust this folder');
    const login = detectScreen(SNAPSHOTS.loginPaste)!;
    expect(login.text).toContain('https://claude.ai/oauth/authorize?…');
    expect(login.text).not.toContain('client_id');
    expect(login.text).not.toContain('aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789');
  });

  it('a login error printed in the conversation is reported but does not hold instructions (the prompt is there)', () => {
    expect(detectScreen(SNAPSHOTS.loginExpired)).toMatchObject({ kind: 'login', blocks: false });
    expect(detectScreen(SNAPSHOTS.login)).toMatchObject({ kind: 'login', blocks: true });
    expect(detectScreen(SNAPSHOTS.trust)).toMatchObject({ blocks: true });
  });

  it('gives a stable fingerprint for the same screen, another one when the cursor moves', () => {
    const a = detectScreen(SNAPSHOTS.terminalSetup)!;
    const b = detectScreen(SNAPSHOTS.terminalSetup)!;
    const moved = detectScreen(SNAPSHOTS.terminalSetup.replace('❯ 1.', '  1.').replace('  2. No', '❯ 2. No'))!;
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(moved.kind).toBe('menu');
    expect(moved.fingerprint).not.toBe(a.fingerprint);
  });

  it('notification copy (push, bell)', () => {
    expect(attentionNotificationCopy({ sessionTitle: 'Remise sur devis', projectName: 'Devis express', kind: 'trust' })).toEqual({
      title: 'Remise sur devis attend une réponse dans le terminal',
      body: 'Autorisez ce dossier dans le terminal · Devis express · touchez pour répondre',
    });
  });
});
