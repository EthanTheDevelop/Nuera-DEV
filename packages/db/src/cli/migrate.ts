import { runMigrations } from '../migrate';
import { loadRootEnv } from './env';

loadRootEnv();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL manquant : copiez .env.example vers .env ou lancez `pnpm db:local`.');
  process.exit(1);
}

runMigrations(url)
  .then(() => {
    console.log('Migrations appliquées.');
  })
  .catch((error: unknown) => {
    console.error('Échec des migrations :', error);
    process.exit(1);
  });
