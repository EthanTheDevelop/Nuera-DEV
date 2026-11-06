import 'server-only';

/**
 * HTML pieces of the preview host: the one-line script added to the previewed pages (it tells the
 * Workspace where the frame is, nothing else) and the sober pages shown in the frame when the
 * preview cannot be served.
 */

export const POSITION_MESSAGE = 'nuera-apercu:position';

/**
 * Added to the dev server's HTML pages, after `<head>`: posts `location` (path + query + hash) to
 * the application — and to it only (`targetOrigin`) — at load and on every client-side navigation,
 * so the path field and « Recharger » follow the page actually shown. Inert outside a frame.
 */
export function positionScript(appOrigin: string): string {
  const target = JSON.stringify(appOrigin).replace(/</g, '\\u003c');
  return (
    `<script data-nuera-apercu>(function(){if(window.parent===window)return;var o=${target};` +
    `function s(){try{window.parent.postMessage({type:${JSON.stringify(POSITION_MESSAGE)},path:location.pathname+location.search+location.hash},o)}catch(e){}}` +
    `s();addEventListener("popstate",s);addEventListener("hashchange",s);` +
    `["pushState","replaceState"].forEach(function(m){var f=history[m];history[m]=function(){var r=f.apply(this,arguments);s();return r}})})();</script>`
  );
}

const HEAD_TAG = /<head(?:\s[^>]*)?>/i;
const BODY_TAG = /<body(?:\s[^>]*)?>/i;
const SCAN_LIMIT = 64 * 1024;

/**
 * Inserts `snippet` right after the first `<head …>` (else `<body …>`) of a streamed HTML body,
 * looking at its first 64 KiB only; bytes are scanned as latin1 (1 byte = 1 char), so UTF-8 text is
 * never re-encoded. Without either tag in that window the body passes unchanged.
 */
export function injectAfterHead(body: ReadableStream<Uint8Array>, snippet: string): ReadableStream<Uint8Array> {
  const extra = new TextEncoder().encode(snippet);
  let pending: Uint8Array[] = [];
  let pendingSize = 0;
  let done = false;
  const flush = (controller: TransformStreamDefaultController<Uint8Array>) => {
    for (const chunk of pending) controller.enqueue(chunk);
    pending = [];
    pendingSize = 0;
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (done) return controller.enqueue(chunk);
        pending.push(chunk);
        pendingSize += chunk.length;
        const joined = Buffer.concat(pending);
        const text = joined.toString('latin1');
        const match = HEAD_TAG.exec(text) ?? BODY_TAG.exec(text);
        if (match) {
          const at = match.index + match[0].length;
          controller.enqueue(joined.subarray(0, at));
          controller.enqueue(extra);
          controller.enqueue(joined.subarray(at));
          pending = [];
          pendingSize = 0;
          done = true;
          return;
        }
        if (pendingSize >= SCAN_LIMIT) {
          flush(controller);
          done = true;
        }
      },
      flush(controller) {
        flush(controller);
      },
    }),
  );
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
}

/** Small page shown in the frame (or the tab) when the preview cannot be served. */
export function previewMessagePage(status: number, title: string, message: string): Response {
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;padding:16px;box-sizing:border-box}main{max-width:28rem}h1{font-size:17px;margin:0 0 6px}p{margin:0;opacity:.75}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
