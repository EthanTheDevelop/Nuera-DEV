// Production bundle of the runner: dist/index.mjs (Node 22+, ESM).
// Workspace packages (@nuera/*, consumed as TypeScript sources) are bundled together with the
// pure-JS dependencies they bring (postgres.js, drizzle-orm) — the runner does not declare them
// itself. Every other dependency stays external and is installed next to the bundle (native
// @lydell/node-pty, pino transports, fastify…). bin/*.mjs scripts are shipped as they are.
import { build } from 'esbuild';

const BUNDLED = [/^@nuera\//, /^postgres(\/|$)/, /^drizzle-orm(\/|$)/];

const externalDeps = {
  name: 'external-node-modules',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (BUNDLED.some((re) => re.test(args.path))) return undefined;
      return { path: args.path, external: true };
    });
  },
};

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  legalComments: 'none',
  plugins: [externalDeps],
  logLevel: 'info',
});
