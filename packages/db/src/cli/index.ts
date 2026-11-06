import { loadRootEnv } from './env';
import { RECOVERY_LINK_USAGE, runRecoveryLinkCli } from './recovery-command';

// pnpm --filter @nuera/db cli <commande> … — commands of the database package.
loadRootEnv();

const [command, ...args] = process.argv.slice(2).filter((arg) => arg !== '--');
const io = { env: process.env, out: (line: string) => console.log(line), err: (line: string) => console.error(line) };

if (command === 'recovery-link') {
  process.exitCode = await runRecoveryLinkCli(args, io);
} else {
  io.err(command ? `Commande inconnue : ${command}` : 'Commande manquante.');
  io.err('Commandes : recovery-link');
  io.err(RECOVERY_LINK_USAGE);
  process.exitCode = 2;
}
