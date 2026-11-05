#!/usr/bin/env node
// TEST-ONLY — local test stack of Nuera Dev (web + runner + fake GitHub + fake Claude CLI).
//
//   node apps/web/e2e/harness/stack.mjs up --name harness --web-port 3201
//   node apps/web/e2e/harness/stack.mjs seed --name harness all
//   node apps/web/e2e/harness/stack.mjs login --name harness
//   node apps/web/e2e/harness/stack.mjs down --name harness [--purge]
//
// Plain Node ESM: registers tsx (devDependency of the runner) in-process, then runs cli.ts.
// See apps/web/e2e/harness/README.md.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// `stack.mjs status | head` closes the pipe early: not an error of the stack.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error.code === 'EPIPE') process.exit(process.exitCode ?? 0);
    throw error;
  });
}

const here = path.dirname(fileURLToPath(import.meta.url));
const tsxApi = path.resolve(here, '..', '..', '..', 'runner', 'node_modules', 'tsx', 'dist', 'esm', 'api', 'index.mjs');
const { register } = await import(pathToFileURL(tsxApi).href);
register();

const { main } = await import(pathToFileURL(path.join(here, 'cli.ts')).href);
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`\nÉchec : ${error instanceof Error ? error.message : String(error)}`);
  if (process.env.HARNESS_DEBUG === '1' && error instanceof Error) console.error(error.stack);
  process.exitCode = 1;
}
// Detached children keep running; nothing else must keep this process alive.
setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();
