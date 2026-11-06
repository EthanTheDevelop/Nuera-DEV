/**
 * Content-Security-Policy of the application pages (pure: used by `next.config.ts` for every
 * response, and by `src/proxy.ts`, which adds `frame-src <preview origin>` at run time when
 * PREVIEW_HOST is set — next.config headers are fixed at build time).
 * Scripts/styles are self-hosted (next/font self-hosts Google fonts); 'unsafe-inline' for styles is
 * required by Next.js style injection and Radix positioning.
 */
export function githubWebOrigin(env: Record<string, string | undefined> = process.env): string {
  try {
    return new URL(env.GITHUB_WEB_URL?.trim() || 'https://github.com').origin;
  } catch {
    return 'https://github.com';
  }
}

export function appContentSecurityPolicy(options: { isProd: boolean; githubOrigin: string; frameOrigin?: string | null }): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${options.isProd ? '' : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://avatars.githubusercontent.com",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    // « Aperçu »: the dev server of a worktree, on its own origin (never the application's).
    ...(options.frameOrigin ? [`frame-src ${options.frameOrigin}`] : []),
    "frame-ancestors 'none'",
    "base-uri 'self'",
    `form-action 'self' ${options.githubOrigin}`,
    "object-src 'none'",
  ].join('; ');
}
