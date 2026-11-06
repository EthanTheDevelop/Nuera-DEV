import 'server-only';
import { previewMessageHtml } from '@nuera/shared/runner';

/**
 * Sober page of the preview host shown in the frame (or the tab) when the preview cannot be served:
 * access refused, handoff expired, runner unreachable. The pages of the dev server itself, and the
 * runner's errors once the request reached it, are written by the runner (« direct » mode,
 * `@nuera/shared/runner` preview.ts).
 */
export function previewMessagePage(status: number, title: string, message: string): Response {
  return new Response(previewMessageHtml(title, message), { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
