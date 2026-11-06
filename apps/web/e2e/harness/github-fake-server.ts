/**
 * TEST-ONLY — process entry of the stack's fake GitHub (started by `stack.mjs up`):
 *   node --import <tsx loader> apps/web/e2e/harness/github-fake-server.ts --config <stack>/github/config.json
 */
import { readFileSync } from 'node:fs';
import { startFakeGithubFront, type FakeGithubConfig } from './github-front';

const index = process.argv.indexOf('--config');
const file = index === -1 ? null : process.argv[index + 1];
if (!file) {
  console.error('Usage : github-fake-server.ts --config <fichier>');
  process.exit(2);
}
const config = JSON.parse(readFileSync(file, 'utf8')) as FakeGithubConfig;
const front = await startFakeGithubFront(config);
console.log(`[faux GitHub] prêt : API ${front.apiUrl} · pages ${front.url}`);
for (const app of config.apps) {
  console.log(`[faux GitHub] application ${app.key} : ${app.slug} (${app.appId}) · propriétaire ${app.owner.login} · installations ${app.installations.map((item) => `${item.account}=${item.installationId}`).join(', ')}`);
}

let closing = false;
const stop = (signal: string) => {
  if (closing) return;
  closing = true;
  console.log(`[faux GitHub] arrêt (${signal})`);
  void front.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
