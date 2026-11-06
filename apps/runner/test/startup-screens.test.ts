import { describe, expect, it } from 'vitest';
import { startupScreenAction } from '../src/sessions/startup-screens';

const THEME_SCREEN = `Let's get started.

Choose the text style that looks best with your terminal
To change this later, run /theme

   Auto (match terminal)
 ❯ ✔ Dark mode
   Light mode
  ↓ 4 more

 1  function greet() {
 2 -  console.log("Hello, World!");
 2 +  console.log("Hello, Claude!");
 3  }`;

const TRUST_SCREEN = `Do you trust the files in this folder?

/srv/dev/nuera-dev

Claude Code may read, write, or execute files contained in this directory.

 ❯ 1. Yes, proceed
   2. No, exit

 Enter to confirm · Esc to exit`;

describe('écrans de démarrage du CLI', () => {
  it('thème : Entrée sur la valeur surlignée', () => {
    expect(startupScreenAction(THEME_SCREEN)).toMatchObject({ kind: 'theme', keys: '\r' });
  });

  it('confiance du dossier : Entrée quand « Yes » est surligné, « 1 » sinon', () => {
    expect(startupScreenAction(TRUST_SCREEN)).toMatchObject({ kind: 'trust', keys: '\r' });
    const cursorOnNo = TRUST_SCREEN.replace(' ❯ 1. Yes, proceed', '   1. Yes, proceed').replace('   2. No, exit', ' ❯ 2. No, exit');
    expect(startupScreenAction(cursorOnNo)).toMatchObject({ kind: 'trust', keys: '1' });
  });

  it('« Press Enter to continue » : Entrée', () => {
    expect(startupScreenAction('Login successful. Press Enter to continue…')).toMatchObject({ kind: 'continue', keys: '\r' });
  });

  it("jamais la connexion du compte, le mode sans autorisations ni Remote Control", () => {
    expect(startupScreenAction('Select login method:\n ❯ 1. Claude account with subscription\nPress Enter to continue')).toBeNull();
    expect(startupScreenAction('WARNING: Claude Code running in Bypass Permissions mode\n ❯ 1. No, exit\n   2. Yes, I accept')).toBeNull();
    expect(startupScreenAction('Enable Remote Control? (y/n)')).toBeNull();
  });

  it("écran normal : rien", () => {
    expect(startupScreenAction('╭──────────╮\n│ > Try "fix lint errors" │\n╰──────────╯\n  ? for shortcuts')).toBeNull();
  });
});
