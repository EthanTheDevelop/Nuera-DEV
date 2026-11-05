import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { SessionManager } from './manager';

const ParamsSchema = z.object({ sessionId: z.uuid() });
const McpHeadersBodySchema = z.object({ serverName: z.string().max(64), serverUrl: z.string().max(2048).nullish() });

function bearer(header: string | undefined): string | null {
  const m = header ? /^Bearer\s+([A-Za-z0-9_-]{20,128})$/.exec(header.trim()) : null;
  return m?.[1] ?? null;
}

/**
 * Local listener for the CLI side (127.0.0.1 only): `bin/nuera-hook.mjs`, `bin/nuera-statusline.mjs`
 * and `bin/nuera-mcp-headers.mjs`. Each call carries the per-session token (only its sha256 is
 * stored). Unknown session or wrong token → 404 without detail; the scripts then print nothing.
 */
export function buildHookServer(manager: SessionManager, logger: Logger): FastifyInstance {
  const app: FastifyInstance = Fastify({
    // Request logs of the hook listener are noise (one per tool call): warnings only.
    loggerInstance: logger.child({ listener: 'hooks' }, { level: 'warn' }) as unknown as FastifyBaseLogger,
    bodyLimit: 1024 * 1024,
    // A PermissionRequest hook waits for the owner's decision (up to permissionWaitSeconds).
    requestTimeout: 0,
    connectionTimeout: 0,
    keepAliveTimeout: 5000,
  });

  const authenticate = (sessionId: string, authorization: string | undefined) => manager.authenticate(sessionId, bearer(authorization));

  app.post('/internal/hooks/:sessionId', async (request, reply) => {
    const params = ParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send();
    const live = authenticate(params.data.sessionId, request.headers.authorization);
    if (!live) return reply.code(404).send();
    const body = request.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return reply.code(400).send();
    // The hook process went away (CLI hook timeout, session killed) while we were waiting.
    // Note: `request.raw` emits 'close' as soon as the body is read; only the response tells.
    const abort = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableEnded) abort.abort();
    };
    reply.raw.on('close', onClose);
    try {
      const output = await manager.handleHook(live, body as Record<string, unknown>, abort.signal);
      if (abort.signal.aborted) return reply.code(204).send();
      if (output === null) return reply.code(204).send();
      return reply.code(200).header('content-type', 'application/json').send(JSON.stringify(output));
    } catch (error) {
      request.log.warn({ err: error, sessionId: live.id }, 'hook non traité');
      return reply.code(204).send();
    } finally {
      reply.raw.off('close', onClose);
    }
  });

  app.post('/internal/statusline/:sessionId', async (request, reply) => {
    const params = ParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send();
    const live = authenticate(params.data.sessionId, request.headers.authorization);
    if (!live) return reply.code(404).send();
    await manager.handleStatusLine(live, request.body);
    return reply.code(204).send();
  });

  app.post('/internal/mcp-headers/:sessionId', async (request, reply) => {
    const params = ParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send();
    const live = authenticate(params.data.sessionId, request.headers.authorization);
    if (!live) return reply.code(404).send();
    const body = McpHeadersBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send();
    const headers = await manager.mcpHeaders(live, { serverName: body.data.serverName, serverUrl: body.data.serverUrl ?? null });
    return reply.code(200).header('cache-control', 'no-store').send({ headers });
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send();
  });
  return app;
}
