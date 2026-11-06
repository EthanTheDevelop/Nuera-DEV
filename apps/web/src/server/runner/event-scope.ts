import 'server-only';
import { environmentSpaces, environments, projects, sessions } from '@nuera/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/server/db';

/**
 * Space filter of the global stream (lot P1, shared servers). A runner publishes on `/v1/events` the
 * events of EVERY account it works for (session statuses, permission requests, operations, runs,
 * notifications); the web relays to an account only those of its own space:
 *
 * - resource events are kept when their project / session belongs to the space (one indexed query per
 *   new id, cached for the life of the stream: a project never changes space);
 * - `claude.status` only when it is this account's (`spaceId`; the runner already filters with
 *   `/v1/events?spaceId=`); without `spaceId` (older runner) only on a server that is not shared;
 * - server-wide events (heartbeats, `stream.*`, `system.metrics`) always — the load of the server is
 *   shared, its content is not;
 * - an operation without project, or an unknown event type: only for the server's first account
 *   (unshared server: unchanged behaviour). Anything unreadable is dropped (fail closed).
 */

export type FrameFilter = (frame: string) => boolean | Promise<boolean>;

const ALWAYS = new Set(['heartbeat', 'stream.reset', 'stream.error', 'stream.hello', 'system.metrics']);
const NEVER_GLOBAL = new Set(['terminal.snapshot', 'terminal.data', 'terminal.resize', 'terminal.exit', 'run.output', 'session.event']);
const SERVER_TTL_MS = 30_000;

type Json = Record<string, unknown>;
const isObj = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === 'string' && value.length <= 64 ? value : null);

/** `data:` payload of a complete SSE frame (null: no data line, e.g. `retry:`). */
export function frameData(frame: string): string | null {
  const lines = frame.split('\n').filter((line) => line.startsWith('data:'));
  if (lines.length === 0) return null;
  return lines.map((line) => line.slice(5).replace(/^ /, '').replace(/\r$/, '')).join('\n');
}

export interface SpaceEventLookups {
  projectInSpace(projectId: string): Promise<boolean>;
  sessionInSpace(sessionId: string): Promise<boolean>;
  /** `{ shared, primary }` of the server for this space. */
  server(): Promise<{ shared: boolean; primary: boolean }>;
}

/** Database lookups of {@link spaceFrameFilter} (scoped to the space AND the server). */
export function spaceEventLookups(input: { spaceId: string; environmentId: string }): SpaceEventLookups {
  return {
    async projectInSpace(projectId) {
      const [row] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.spaceId, input.spaceId), eq(projects.environmentId, input.environmentId)))
        .limit(1);
      return Boolean(row);
    },
    async sessionInSpace(sessionId) {
      const [row] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .innerJoin(projects, and(eq(projects.id, sessions.projectId), eq(projects.environmentId, sessions.environmentId)))
        .where(and(eq(sessions.id, sessionId), eq(sessions.environmentId, input.environmentId), eq(projects.spaceId, input.spaceId)))
        .limit(1);
      return Boolean(row);
    },
    async server() {
      const [row] = await db
        .select({
          primarySpaceId: environments.spaceId,
          accounts: sql<number>`(select count(*)::int from ${environmentSpaces} as l where l.environment_id = ${environments}.${sql.identifier('id')})`,
        })
        .from(environments)
        .where(eq(environments.id, input.environmentId))
        .limit(1);
      return { shared: Number(row?.accounts ?? 0) > 1, primary: row?.primarySpaceId === input.spaceId };
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Frame filter of one global stream (caches live as long as the stream). */
export function spaceFrameFilter(input: { spaceId: string; lookups: SpaceEventLookups }): FrameFilter {
  const projectsSeen = new Map<string, Promise<boolean>>();
  const sessionsSeen = new Map<string, Promise<boolean>>();
  let server: { at: number; value: Promise<{ shared: boolean; primary: boolean }> } | null = null;

  const remember = (cache: Map<string, Promise<boolean>>, id: string | null, lookup: (value: string) => Promise<boolean>): Promise<boolean> => {
    if (!id || !UUID.test(id)) return Promise.resolve(false);
    const key = id.toLowerCase();
    let found = cache.get(key);
    if (!found) {
      found = lookup(key).catch(() => {
        // Database hiccup: dropped (fail closed), asked again next time.
        cache.delete(key);
        return false;
      });
      cache.set(key, found);
    }
    return found;
  };
  const project = (id: string | null) => remember(projectsSeen, id, (value) => input.lookups.projectInSpace(value));
  const session = (id: string | null) => remember(sessionsSeen, id, (value) => input.lookups.sessionInSpace(value));
  const serverInfo = () => {
    if (!server || Date.now() - server.at > SERVER_TTL_MS) {
      server = { at: Date.now(), value: input.lookups.server().catch(() => ({ shared: true, primary: false })) };
    }
    return server.value;
  };
  const ownerOnly = async () => {
    const info = await serverInfo();
    return info.primary || !info.shared;
  };

  return (frame) => {
    const raw = frameData(frame);
    if (raw === null) return true;
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!isObj(event) || typeof event.type !== 'string') return false;
    const type = event.type;
    const data = isObj(event.data) ? event.data : {};
    if (ALWAYS.has(type)) return true;
    if (NEVER_GLOBAL.has(type)) return false;
    switch (type) {
      case 'claude.status': {
        const spaceId = str(data.spaceId);
        if (spaceId) return spaceId.toLowerCase() === input.spaceId.toLowerCase();
        return serverInfo().then((info) => !info.shared);
      }
      case 'session.status':
        return project(str(data.projectId));
      case 'session.permission':
        return session(str(data.sessionId));
      case 'operation.progress': {
        const operation = isObj(data.operation) ? data.operation : {};
        const projectId = str(operation.projectId);
        if (projectId) return project(projectId);
        const sessionId = str(operation.sessionId);
        if (sessionId) return session(sessionId);
        return ownerOnly();
      }
      case 'run.status': {
        const run = isObj(data.run) ? data.run : {};
        return project(str(run.projectId));
      }
      case 'notification.created': {
        const projectId = str(data.projectId);
        if (projectId) return project(projectId);
        const sessionId = str(data.sessionId);
        if (sessionId) return session(sessionId);
        return ownerOnly();
      }
      default:
        return ownerOnly();
    }
  };
}
