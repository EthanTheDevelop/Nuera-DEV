import { fileURLToPath } from 'node:url';
import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';

// Monorepo: the single .env lives at the repository root (see .env.example).
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
loadEnvConfig(repoRoot);

const isProd = process.env.NODE_ENV === 'production';

/**
 * Content-Security-Policy. Scripts/styles are self-hosted (next/font self-hosts Google fonts).
 * 'unsafe-inline' for styles is required by Next.js style injection and Radix positioning.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://avatars.githubusercontent.com",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self' https://github.com",
  'object-src \'none\'',
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
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
  poweredByHeader: false,
  transpilePackages: ['@nuera/db', '@nuera/shared'],
  serverExternalPackages: ['postgres', 'web-push', 'shiki'],
  outputFileTracingRoot: repoRoot,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
