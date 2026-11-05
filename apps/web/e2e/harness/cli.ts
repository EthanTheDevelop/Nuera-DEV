/**
 * TEST-ONLY — command line of the local test stack (entry: stack.mjs, which registers tsx).
 * Usage: see `node apps/web/e2e/harness/stack.mjs help` and apps/web/e2e/harness/README.md.
 */
import { STACK_CLI_DISPLAY } from './paths';
import type { ComponentName } from './state';

const HELP = `Pile de test locale de Nuera Dev (web + runner + faux GitHub + faux CLI Claude)

  ${STACK_CLI_DISPLAY} <commande> --name <pile> [options]

Commandes
  up        démarre (ou réutilise) la pile : base créée et migrée, faux GitHub, runner (PTY,
            faux CLI), web (next dev), propriétaire créé par /configuration, application GitHub
            connectée par les vraies routes, pages préchauffées.
              --web-port N [--runner-port N --hook-port N --github-port N]   (défaut : N+1000/+1001/+1002)
              --db <nom>          base (défaut nuera_<pile>)
              --reset             repart de zéro (base, clones, propriétaire, GitHub)
              --pristine          sans propriétaire ni GitHub (première configuration à faire)
              --no-web            sans le web (runner + faux GitHub seulement)
              --scheduler         active les tâches périodiques du runner
              --seed a,b          lance aussi ces scénarios (voir seed)
              --warm /x,/y        compile aussi ces pages
  down      arrête tous les processus de la pile (arbres entiers) et libère ses ports
              --purge             supprime aussi son dossier, sa base et apps/web/.next-<pile>
  status    état et santé de chaque processus [--json]
  login     écrit .data/stacks/<pile>/storage-state.json (mot de passe + TOTP) [--out fichier]
  seed      <scénario…> : all | github | projects | sessions | changes | runs | notifications
  shot      <chemin> [--mobile] [--full] [--out fichier.png] [--wait ms] [--selector css] [--dark]
  restart   <github|runner|web>
  logs      <github|runner|web> [--lines N]
  claude    <connecte|deconnecte> : état de connexion du faux CLI (T6)
  github    <revoquer-cle|retablir-cle|suspendre <compte>|reactiver <compte>> : faux GitHub
  env       variables utiles aux tests (E2E_*) pour cette pile`;

interface Parsed {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: string[]): Parsed {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=', 2) as [string, string | undefined];
      if (inline !== undefined) flags.set(key, inline);
      else if (rest[i + 1] !== undefined && !rest[i + 1]!.startsWith('--') && !['reset', 'pristine', 'no-web', 'scheduler', 'purge', 'json', 'mobile', 'full', 'dark'].includes(key)) {
        flags.set(key, rest[i + 1]!);
        i += 1;
      } else flags.set(key, true);
    } else positional.push(arg);
  }
  return { command, positional, flags };
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

function component(value: string | undefined): ComponentName {
  if (value === 'github' || value === 'runner' || value === 'web') return value;
  throw new Error('Composant attendu : github, runner ou web.');
}

export async function main(argv: string[]): Promise<number> {
  const { command, positional, flags } = parseArgs(argv);
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
        webPort: num(flags, 'web-port'),
        runnerPort: num(flags, 'runner-port'),
        hookPort: num(flags, 'hook-port'),
        githubPort: num(flags, 'github-port'),
        db: str(flags, 'db'),
        reset: flags.has('reset'),
        pristine: flags.has('pristine'),
        web: flags.has('no-web') ? false : undefined,
        scheduler: flags.has('scheduler') ? true : undefined,
        warm: list(str(flags, 'warm')).map(pagePath),
        seed: list(str(flags, 'seed')),
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
      console.log(`Pile « ${name} » · web ${report.urls!.web} · runner ${report.urls!.runner} · GitHub ${report.urls!.githubWeb}`);
      for (const item of report.components) console.log(`  ${item.healthy ? 'OK ' : '-- '} ${item.component.padEnd(8)} ${item.pid ? `pid ${item.pid} · ` : ''}${item.detail}`);
      console.log(`  Propriétaire ${report.owner!.created ? report.owner!.email : 'non créé'} · GitHub ${report.github!.connected ? 'connecté' : 'non connecté'}`);
      const seeded = report.seeded ?? {};
      if (seeded.projects) console.log(`  Projets : ${Object.values(seeded.projects).map((p) => `${p.key}=${p.id}`).join(' · ')}`);
      if (seeded.sessions) console.log(`  Sessions : ${Object.values(seeded.sessions).map((s) => `${s.key}=${s.id}`).join(' · ')}`);
      if (seeded.runs) console.log(`  Exécutions : réussie=${seeded.runs.passed?.id ?? '-'} · en échec=${seeded.runs.failed?.id ?? '-'}`);
      return report.components.every((item) => item.healthy || item.detail.startsWith('désactivé')) ? 0 : 1;
    }
    case 'login':
      await stack.login(name, { out: str(flags, 'out') });
      return 0;
    case 'seed':
      await stack.seed(name, positional.length ? positional : ['all']);
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
      });
      return 0;
    case 'restart':
      await stack.restart(name, component(positional[0]));
      return 0;
    case 'logs':
      console.log(stack.logs(name, component(positional[0]), num(flags, 'lines') ?? 80));
      return 0;
    case 'claude': {
      const wanted = positional[0];
      if (wanted !== 'connecte' && wanted !== 'deconnecte') throw new Error('claude connecte | claude deconnecte');
      await stack.setClaudeLoggedIn(name, wanted === 'connecte');
      return 0;
    }
    case 'github': {
      const [action, account] = positional;
      const input =
        action === 'revoquer-cle'
          ? { rejectJwt: true }
          : action === 'retablir-cle'
            ? { rejectJwt: false }
            : action === 'suspendre' && account
              ? { suspend: { account, suspended: true } }
              : action === 'reactiver' && account
                ? { suspend: { account, suspended: false } }
                : null;
      if (!input) throw new Error('github revoquer-cle | retablir-cle | suspendre <compte> | reactiver <compte>');
      await stack.controlGithub(name, input);
      console.log('Faux GitHub mis à jour. « Vérifier la connexion » dans Intégrations (ou POST /api/integrations/github/check) applique le changement.');
      return 0;
    }
    case 'env': {
      const state = stack.loadState(name);
      console.log(
        [
          `E2E_STACK=${state.name}`,
          `E2E_WEB_PORT=${state.ports.web}`,
          `E2E_RUNNER_PORT=${state.ports.runner}`,
          `E2E_HOOK_PORT=${state.ports.hook}`,
          `E2E_GITHUB_PORT=${state.ports.github}`,
          `E2E_DATABASE=${state.database.name}`,
        ].join('\n'),
      );
      return 0;
    }
    default:
      console.log(HELP);
      return 2;
  }
}
