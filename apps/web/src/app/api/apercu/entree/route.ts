import type { NextRequest } from 'next/server';
import { servePreviewEntry } from '@/server/preview';

/**
 * `GET https://PREVIEW_HOST/__nuera/entree?jeton=` (rewritten here by src/proxy.ts): spends the
 * single-use handoff token, sets the host-only cookie `nuera_apercu` (12 h) and redirects to the
 * path asked. 404 on the application host.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = (request: NextRequest) => servePreviewEntry(request);
