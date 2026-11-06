import { parseArgs } from 'node:util';
import { createDb } from '../index';
import { createRecoveryLink, RECOVERY_LINK_TTL_HOURS, RecoveryLinkError } from '../recovery';

export const RECOVERY_LINK_USAGE =
  'Usage : pnpm --filter @nuera/db recovery-link --email <adresse> [--app-url <url>] [--remove-passkeys]\n' +
  '(en production : docker compose run --rm -e APP_URL=<url> migrate node_modules/.bin/tsx src/cli/recovery-link.ts --email <adresse>)';

export interface RecoveryCliIo {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/**
 * Break-glass recovery link (no administrator available): `--email <e>` [`--app-url <url>`, else
 * APP_URL] [`--remove-passkeys` when the device holding them is lost]. The single-use link is the
 * only line written to stdout (what was closed is in the journal, `admin.recovery_link_cli`); errors
 * go to stderr. Returns the process exit code.
 */
export async function runRecoveryLinkCli(argv: string[], io: RecoveryCliIo): Promise<number> {
  let values: { email?: string; 'app-url'?: string; 'remove-passkeys'?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv.filter((arg) => arg !== '--'),
      options: { email: { type: 'string' }, 'app-url': { type: 'string' }, 'remove-passkeys': { type: 'boolean' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(RECOVERY_LINK_USAGE);
    return 2;
  }
  const email = values.email?.trim();
  if (!email) {
    io.err('Adresse e-mail manquante (--email).');
    io.err(RECOVERY_LINK_USAGE);
    return 2;
  }
  const appUrl = values['app-url']?.trim() || io.env.APP_URL?.trim();
  if (!appUrl) {
    io.err('Adresse de Nuera Dev manquante : passez --app-url ou définissez APP_URL.');
    return 2;
  }
  const databaseUrl = io.env.DATABASE_URL;
  if (!databaseUrl) {
    io.err('DATABASE_URL manquant : copiez .env.example vers .env ou lancez `pnpm db:local`.');
    return 2;
  }

  const db = createDb(databaseUrl, { max: 1, applicationName: 'nuera-cli' });
  try {
    const link = await createRecoveryLink(db, { email, appUrl, removePasskeys: values['remove-passkeys'] === true });
    io.out(`Lien de récupération (valable ${RECOVERY_LINK_TTL_HOURS} h, à usage unique) : ${link.url}`);
    return 0;
  } catch (error) {
    if (error instanceof RecoveryLinkError) {
      io.err(error.message);
      return 1;
    }
    io.err(`Échec de la création du lien de récupération : ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}
