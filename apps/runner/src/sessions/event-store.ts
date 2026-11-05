import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import { sessionEvents, type Database } from '@nuera/db';
import type { SessionEventItem, SessionEventKindValue, SessionEventPayloadOf } from '@nuera/shared/runner';
import { sessionChannel, type EventBus } from '../events/bus';

type Row = typeof sessionEvents.$inferSelect;

/** Serialises async work per key (one queue per session). */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

export function rowToItem(row: Row): SessionEventItem {
  return {
    id: row.id,
    sessionId: row.sessionId,
    position: row.position,
    version: row.version,
    key: row.key,
    kind: row.kind,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  } as SessionEventItem;
}

/**
 * Normalised conversation items (session_events). `position` = display order (creation),
 * `version` = change order (bumped on every insert/update; used for catch-up).
 * Callers must hold the session queue (`queue.run(sessionId, …)`).
 */
export class SessionEventStore {
  readonly queue = new KeyedQueue();
  private readonly counters = new Map<string, { position: number; version: number }>();

  constructor(
    private readonly db: Database,
    private readonly bus: EventBus,
  ) {}

  private async next(sessionId: string): Promise<{ position: number; version: number }> {
    let c = this.counters.get(sessionId);
    if (!c) {
      const [row] = await this.db
        .select({
          position: sql<number>`coalesce(max(${sessionEvents.position}), 0)`,
          version: sql<number>`coalesce(max(${sessionEvents.version}), 0)`,
        })
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId));
      c = { position: Number(row?.position ?? 0), version: Number(row?.version ?? 0) };
      this.counters.set(sessionId, c);
    }
    return c;
  }

  forget(sessionId: string): void {
    this.counters.delete(sessionId);
  }

  private publish(item: SessionEventItem): SessionEventItem {
    this.bus.publish('session.event', { sessionId: item.sessionId, item }, { channels: [sessionChannel(item.sessionId)] });
    return item;
  }

  async append<K extends SessionEventKindValue>(sessionId: string, kind: K, payload: SessionEventPayloadOf<K>, key: string | null = null): Promise<SessionEventItem> {
    if (key) {
      const existing = await this.find(sessionId, key);
      if (existing) return this.update(sessionId, key, () => payload);
    }
    const c = await this.next(sessionId);
    c.position += 1;
    c.version += 1;
    const [row] = await this.db
      .insert(sessionEvents)
      .values({ sessionId, position: c.position, version: c.version, key, kind, payload: payload as Record<string, unknown> })
      .returning();
    return this.publish(rowToItem(row!));
  }

  async find(sessionId: string, key: string): Promise<SessionEventItem | null> {
    const [row] = await this.db
      .select()
      .from(sessionEvents)
      .where(and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.key, key)))
      .limit(1);
    return row ? rowToItem(row) : null;
  }

  /** Updates the payload of an item by key; returns null when it does not exist. */
  async update<K extends SessionEventKindValue>(
    sessionId: string,
    key: string,
    patch: (previous: SessionEventPayloadOf<K>) => SessionEventPayloadOf<K>,
  ): Promise<SessionEventItem> {
    const existing = await this.find(sessionId, key);
    if (!existing) throw new Error(`session event ${key} absent`);
    const c = await this.next(sessionId);
    c.version += 1;
    const payload = patch(existing.payload as SessionEventPayloadOf<K>);
    const [row] = await this.db
      .update(sessionEvents)
      .set({ payload: payload as Record<string, unknown>, version: c.version, updatedAt: new Date() })
      .where(and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.key, key)))
      .returning();
    return this.publish(rowToItem(row!));
  }

  async list(sessionId: string, afterVersion: number, limit: number): Promise<{ items: SessionEventItem[]; version: number; hasMore: boolean }> {
    const rows = await this.db
      .select()
      .from(sessionEvents)
      .where(and(eq(sessionEvents.sessionId, sessionId), gt(sessionEvents.version, afterVersion)))
      .orderBy(asc(sessionEvents.version))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const kept = rows.slice(0, limit);
    const version = kept.length ? kept[kept.length - 1]!.version : afterVersion;
    return { items: kept.map(rowToItem).sort((a, b) => a.position - b.position), version, hasMore };
  }

  /** Last items of a kind (dedup of assistant texts…). */
  async recent(sessionId: string, kind: SessionEventKindValue, limit: number): Promise<SessionEventItem[]> {
    const rows = await this.db
      .select()
      .from(sessionEvents)
      .where(and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.kind, kind)))
      .orderBy(desc(sessionEvents.position))
      .limit(limit);
    return rows.map(rowToItem);
  }
}
