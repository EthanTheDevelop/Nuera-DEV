import { loadRootEnv } from './env';
import { runRecoveryLinkCli } from './recovery-command';

// pnpm --filter @nuera/db recovery-link --email <adresse> [--app-url <url>]
loadRootEnv();

process.exitCode = await runRecoveryLinkCli(process.argv.slice(2), {
  env: process.env,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
