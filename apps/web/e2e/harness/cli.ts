/**
 * TEST-ONLY — command line of the local test stack (entry: stack.mjs, which registers tsx).
 * Usage: see `node apps/web/e2e/harness/stack.mjs help` and apps/web/e2e/harness/README.md.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { assertStackKey, type StackKey } from './config';
import { STACK_CLI_DISPLAY, WEB_ROOT } from './paths';
import { isRunnerComponent, type ComponentName } from './state';

const HELP = `Pile de test locale de Nuera Dev (web + runners + faux GitHub + faux CLI Claude)

  ${STACK_CLI_DISPLAY} <commande> --name <pile> [options]

Comptes et serveurs : compte a = propriétaire (Camille Laurent, /configuration) sur le serveur par
défaut « VPS-3 » (runner) ; compte b = membre invité (Hugo Martin, /invitation/<jeton>) sur « VPS-4 »
(runner-b, enregistré par l'administration, rôle PostgreSQL restreint)…

Commandes
  up        démarre (ou réutilise) la pile : base créée et migrée, faux GitHub, runners (PTY,
            faux CLI), web (next dev), propriétaire créé par /configuration, sources GitHub
            connectées par les vraies routes, serveurs et comptes suivants par l'administration
            et la page d'invitation, pages préchauffées.
              --accounts N        comptes (= serveurs) de la pile (défaut : 2 pour e2e, 1 sinon)
              --web-port N [--runner-port N --hook-port N --github-port N]
                                  (défaut : N+1000/+1001/+1002 ; serveur b : N+1010/+1011)
              --db <nom>          base (défaut nuera_<pile>)
              --reset             repart de zéro (base, rôles, clones, comptes, GitHub)
              --pristine          sans propriétaire ni GitHub (première configuration à faire)
              --shared            serveur partagé : les comptes suivants sont invités sur « VPS-3 »
                                  (chacun sa connexion Claude Code), sans runner b
              --no-web            sans le web (runners + faux GitHub seulement)
              --scheduler         active les tâches périodiques (runner et web)
              --seed a,b          lance aussi ces scénarios pour le compte a (voir seed)
              --seed-b a,b        … et ceux-ci pour le compte b
              --warm /x,/y        compile aussi ces pages
  down      arrête tous les processus de la pile (arbres entiers) et libère ses ports
              --purge             supprime aussi son dossier, sa base, ses rôles et apps/web/.next-<pile>
  status    état et santé de chaque processus [--json]
  login     écrit le storage state d'un compte (mot de passe + TOTP) [--as b] [--out fichier]
  seed      <scénario…> [--as b] : all | github | projects | sessions | changes | runs | notifications
  shot      <chemin> [--as b] [--mobile] [--full] [--out fichier.png] [--wait ms] [--selector css] [--dark]
  restart   <github|runner|runner-b|web>
  stop      <github|runner|runner-b|web>   (p. ex. « VPS-4 ne répond pas » ; up ou restart le relance)
  logs      <github|runner|runner-b|web> [--lines N]
  claude    <connecte|deconnecte> [--serveur b] : état de connexion du faux CLI d'un serveur (T6)
  github    <revoquer-cle|retablir-cle|suspendre <compte>|reactiver <compte>> [--app b] : faux GitHub
  env       variables utiles aux tests (E2E_*) pour cette pile [--format posix|powershell|cmd]
  e2e       [--accounts N] -- <arguments Playwright> : lance la suite sur cette pile (PowerShell,
            cmd et Git Bash : aucune syntaxe VAR=valeur requise)`;

interface Parsed {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
  /** Arguments after `--` (passed through, e.g. to Playwright). */
  rest: string[];
}

const BOOLEAN_FLAGS = ['shared', 'reset', 'pristine', 'no-web', 'scheduler', 'purge', 'json', 'mobile', 'full', 'dark'];

export function parseArgs(argv: string[]): Parsed {
  const separator = argv.indexOf('--');
  const head = separator === -1 ? argv : argv.slice(0, separator);
  const passthrough = separator === -1 ? [] : argv.slice(separator + 1);
  const [command = 'help', ...rest] = head;
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=', 2) as [string, string | undefined];
      if (inline !== undefined) flags.set(key, inline);
      else if (rest[i + 1] !== undefined && !rest[i + 1]!.startsWith('--') && !BOOLEAN_FLAGS.includes(key)) {
        flags.set(key, rest[i + 1]!);
        i += 1;
      } else flags.set(key, true);
    } else positional.push(arg);
  }
  return { command, positional, flags, rest: passthrough };
}

function str(flags: Parsed['flags'], key: string): string | undefined {
  const value = flags.get(key);
  return typeof value === 'string' ? value : undefined;
}

function num(flags: Parsed['flags'], key: string): number | undefined {
  const value = str(flags, key);
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`--${key} attend un nombre entier.`);
  return n;
}

function account(flags: Parsed['flags'], key = 'as'): StackKey | undefined {
  const value = str(flags, key);
  return value === undefined ? undefined : assertStackKey(value);
}

const list = (value: string | undefined) => (value ? value.split(/[,;]/).map((item) => item.trim()).filter(Boolean) : []);

/**
 * Page path from the command line. Git Bash rewrites `/projets` into `C:/Program Files/Git/projets`
 * (MSYS path conversion): that prefix is removed, and `projets` is accepted for `/projets`.
 */
export function pagePath(value: string | undefined): string {
  if (!value) return '/';
  const msys = /^[A-Za-z]:[\\/](?:.*[\\/])?Git(?:[\\/](.*))?$/.exec(value);
  const raw = msys ? `/${msys[1] ?? ''}` : value;
  const normalized = raw.replace(/\\/g, '/');
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

export function component(value: string | undefined): ComponentName {
  if (value === 'github' || value === 'web') return value;
  if (value && isRunnerComponent(value)) return value;
  throw new Error('Composant attendu : github, runner, runner-b, runner-c ou web.');
}

/** `KEY=value` lines in the syntax of a shell. Exported for tests. */
export function formatEnv(vars: Record<string, string>, format: string): string {
  const entries = Object.entries(vars);
  if (format === 'powershell') return entries.map(([key, value]) => `$env:${key} = '${value.replace(/'/g, "''")}'`).join('\n');
  if (format === 'cmd') return entries.map(([key, value]) => `set "${key}=${value}"`).join('\n');
  if (format !== 'posix') throw new Error('--format attend posix, powershell ou cmd.');
  return entries.map(([key, value]) => `${key}=${value}`).join('\n');
}

export async function main(argv: string[]): Promise<number> {
  const { command, positional, flags, rest } = parseArgs(argv);
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return 0;
  }
  const name = str(flags, 'name') ?? process.env.E2E_STACK;
  if (!name) throw new Error('Précisez --name <pile>.');
  // The fixtures (owner.json…) follow the selected stack.
  process.env.E2E_STACK = name;
  const stack = await import('./stack');

  switch (command) {
    case 'up':
      await stack.up({
        name,
        accounts: num(flags, 'accounts'),
        webPort: num(flags, 'web-port'),
        runnerPort: num(flags, 'runner-port'),
        hookPort: num(flags, 'hook-port'),
        githubPort: num(flags, 'github-port'),
        db: str(flags, 'db'),
        reset: flags.has('reset'),
        pristine: flags.has('pristine'),
        shared: flags.has('shared') ? true : undefined,
        web: flags.has('no-web') ? false : undefined,
        scheduler: flags.has('scheduler') ? true : undefined,
        warm: list(str(flags, 'warm')).map(pagePath),
        seed: list(str(flags, 'seed')),
        seedAccounts: { b: list(str(flags, 'seed-b')), c: list(str(flags, 'seed-c')) },
      });
      return 0;
    case 'down':
      await stack.down(name, { purge: flags.has('purge') });
      return 0;
    case 'status': {
      const report = await stack.status(name);
      if (flags.has('json')) {
        console.log(JSON.stringify(report, null, 2));
        return report.exists ? 0 : 1;
      }
      if (!report.exists) {
        console.log(`Aucune pile « ${name} ».`);
        return 1;
      }
      console.log(`Pile « ${name} » · web ${report.urls!.web} · GitHub ${report.urls!.githubWeb}`);
      for (const item of report.components) console.log(`  ${item.healthy ? 'OK ' : '-- '} ${item.component.padEnd(9)} ${item.pid ? `pid ${item.pid} · ` : ''}${item.detail}`);
      for (const item of report.accounts ?? []) console.log(`  Compte ${item.key} ${item.created ? `${item.email} (${item.role})` : 'non créé'} · serveur ${item.server} · GitHub ${item.github ? 'connecté' : 'non connecté'}`);
      const seeded = report.seeded ?? {};
      if (seeded.projects) console.log(`  Projets : ${Object.values(seeded.projects).map((p) => `${p.key}=${p.id}`).join(' · ')}`);
      if (seeded.sessions) console.log(`  Sessions : ${Object.values(seeded.sessions).map((s) => `${s.key}=${s.id}`).join(' · ')}`);
      if (seeded.runs) console.log(`  Exécutions : réussie=${seeded.runs.passed?.id ?? '-'} · en échec=${seeded.runs.failed?.id ?? '-'}`);
      return report.components.every((item) => item.healthy || item.detail.startsWith('désactivé')) ? 0 : 1;
    }
    case 'login':
      await stack.login(name, { out: str(flags, 'out'), account: account(flags) });
      return 0;
    case 'seed':
      await stack.seed(name, positional.length ? positional : ['all'], { account: account(flags) });
      console.log(stack.summary(stack.loadState(name)));
      return 0;
    case 'shot':
      await stack.shot(name, {
        path: pagePath(positional[0]),
        out: str(flags, 'out'),
        mobile: flags.has('mobile'),
        full: flags.has('full'),
        waitMs: num(flags, 'wait'),
        selector: str(flags, 'selector'),
        dark: flags.has('dark'),
        account: account(flags),
      });
      return 0;
    case 'restart':
      await stack.restart(name, component(positional[0]));
      return 0;
    case 'stop':
      await stack.stop(name, component(positional[0]));
      return 0;
    case 'logs':
      console.log(stack.logs(name, component(positional[0]), num(flags, 'lines') ?? 80));
      return 0;
    case 'claude': {
      const wanted = positional[0];
      if (wanted !== 'connecte' && wanted !== 'deconnecte') throw new Error('claude connecte | claude deconnecte [--serveur b]');
      await stack.setClaudeLoggedIn(name, wanted === 'connecte', undefined, account(flags, 'serveur') ?? 'a');
      return 0;
    }
    case 'github': {
      const [action, login] = positional;
      const app = str(flags, 'app');
      const input =
        action === 'revoquer-cle'
          ? { rejectJwt: true }
          : action === 'retablir-cle'
            ? { rejectJwt: false }
            : action === 'suspendre' && login
              ? { suspend: { account: login, suspended: true } }
              : action === 'reactiver' && login
                ? { suspend: { account: login, suspended: false } }
                : null;
      if (!input) throw new Error('github revoquer-cle | retablir-cle | suspendre <compte> | reactiver <compte> [--app b]');
      await stack.controlGithub(name, { ...input, ...(app ? { app } : {}) });
      console.log('Faux GitHub mis à jour. « Vérifier la connexion » dans Intégrations (ou POST /api/integrations/github/check) applique le changement.');
      return 0;
    }
    case 'env': {
      console.log(formatEnv(stackEnv(stack.loadState(name)), str(flags, 'format') ?? 'posix'));
      return 0;
    }
    case 'e2e': {
      const state = stack.loadState(name);
      const vars = stackEnv(state);
      const accounts = num(flags, 'accounts');
      if (accounts !== undefined) vars.E2E_ACCOUNTS = String(accounts);
      // Node runs Playwright's own CLI: no shell, so arguments (`--grep "a|b"`) reach it untouched on every OS.
      const args = [path.join(WEB_ROOT, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', ...rest];
      console.log(`Playwright sur la pile ${name} (${vars.E2E_ACCOUNTS} compte(s)) : playwright ${args.slice(1).join(' ')}`);
      return new Promise<number>((resolve) => {
        const child = spawn(process.execPath, args, { cwd: WEB_ROOT, env: { ...process.env, ...vars }, stdio: 'inherit' });
        child.on('exit', (code) => resolve(code ?? 1));
        child.on('error', (error) => {
          console.error(error.message);
          resolve(1);
        });
      });
    }
    default:
      console.log(HELP);
      return 2;
  }
}

function stackEnv(state: import('./state').StackState): Record<string, string> {
  const vars: Record<string, string> = {
    E2E_STACK: state.name,
    E2E_ACCOUNTS: String(state.accountCount),
    E2E_WEB_PORT: String(state.ports.web),
    E2E_RUNNER_PORT: String(state.ports.runner),
    E2E_HOOK_PORT: String(state.ports.hook),
    E2E_GITHUB_PORT: String(state.ports.github),
    E2E_DATABASE: state.database.name,
  };
  for (const runner of state.runners.filter((item) => item.key !== 'a')) {
    vars[`E2E_RUNNER_${runner.key.toUpperCase()}_PORT`] = String(runner.ports.runner);
    vars[`E2E_HOOK_${runner.key.toUpperCase()}_PORT`] = String(runner.ports.hook);
  }
  return vars;
}
