import type { NextRequest } from 'next/server';
import { servePreviewRequest } from '@/server/preview';

/**
 * Preview host only (src/proxy.ts rewrites every request of PREVIEW_HOST here, the original path in
 * `x-nuera-apercu-path`): cookie `nuera_apercu` → access re-checked → relay to the dev server of the
 * run, through its server's runner. 404 on the application host. No application session involved.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const handle = (request: NextRequest) => servePreviewRequest(request);

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
