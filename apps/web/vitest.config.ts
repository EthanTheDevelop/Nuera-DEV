import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));
const EMPTY_MODULE = '\0nuera:empty-module';

/**
 * `server-only` throws outside the `react-server` condition; unit tests import server modules
 * directly, so both guards resolve to an empty module here (the Next build keeps the real ones).
 */
const serverOnlyStub: Plugin = {
  name: 'nuera:server-only-stub',
  enforce: 'pre',
  resolveId(id) {
    return id === 'server-only' || id === 'client-only' ? EMPTY_MODULE : null;
  },
  load(id) {
    return id === EMPTY_MODULE ? 'export {};' : null;
  },
};

export default defineConfig({
  plugins: [serverOnlyStub],
  resolve: {
    alias: [{ find: /^@\//, replacement: `${path.join(root, 'src').replace(/\\/g, '/')}/` }],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', '.next/**', '.next-*/**'],
    // The development machine can be slow to load modules (antivirus, disk): generous timeouts.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    restoreMocks: true,
    unstubEnvs: true,
  },
});
