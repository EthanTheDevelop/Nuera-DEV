import { defineConfig } from 'drizzle-kit';
import { loadRootEnv } from './src/cli/env';

loadRootEnv();

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://nuera:nuera@127.0.0.1:54329/nuera_dev',
  },
  strict: true,
  verbose: true,
});
