import { fileURLToPath } from 'node:url';
import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';
import { APP_PERMISSIONS_POLICY, appContentSecurityPolicy, githubWebOrigin } from './src/lib/security-headers';

// Monorepo: the single .env lives at the repository root (see .env.example).
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
// forceReload: @next/env caches Next's own first call (on apps/web, which has no .env), so without
// it this call is a no-op and `next dev` starts without the root variables.
loadEnvConfig(repoRoot, process.env.NODE_ENV !== 'production', undefined, true);

const isProd = process.env.NODE_ENV === 'production';

/**
 * Content-Security-Policy (src/lib/security-headers.ts). Fixed at build time: the « Aperçu » frame
 * source (PREVIEW_HOST, a run-time variable) is added to the page responses by src/proxy.ts.
 * Browser redirects of the GitHub App flows go to github.com (a local fake in e2e: GITHUB_WEB_URL).
 */
const csp = appContentSecurityPolicy({ isProd, githubOrigin: githubWebOrigin() });

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Microphone for the app origin only (dictation); the preview host replaces it (src/lib/preview.ts).
  { key: 'Permissions-Policy', value: APP_PERMISSIONS_POLICY },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ...(isProd
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }]
    : []),
];

const nextConfig: NextConfig = {
  // Standalone output needs symlink rights on Windows: enabled for Docker/Linux builds only.
  ...(process.env.NEXT_OUTPUT_STANDALONE === '1' ? { output: 'standalone' as const } : {}),
  // Separate build dirs let several dev/e2e servers run side by side (NEXT_DIST_DIR=.next-e2e …).
  distDir: process.env.NEXT_DIST_DIR || '.next',
  reactStrictMode: true,
  // `next dev` would otherwise write apps/web/AGENTS.md on every start.
  agentRules: false,
  poweredByHeader: false,
  transpilePackages: ['@nuera/db', '@nuera/shared'],
  serverExternalPackages: ['postgres', 'web-push', 'shiki'],
  outputFileTracingRoot: repoRoot,
  // src/proxy.ts sees each request as the browser sent it: the preview host hands it to the runner
  // with its exact query (an RSC request's `?_rsc=`, even empty) and its RSC headers.
  skipProxyUrlNormalize: true,
  experimental: {
    // « Aperçu »: the preview host is an external rewrite to the runner (src/proxy.ts); Next's proxy
    // would cut it after 30 s of silence (a first `next dev` compile can take longer). The runner
    // cuts at 60 s itself, with its own page: 70 s here.
    proxyTimeout: 70_000,
    // src/proxy.ts sees every request: Next buffers its body up to this size (10 Mo by default, cut
    // beyond). « Joindre » sends up to 20 Mo per file (+ multipart envelope); every route keeps its
    // own, smaller limit (apiRoute: 1 Mo JSON by default).
    proxyClientMaxBodySize: 21 * 1024 * 1024,
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
