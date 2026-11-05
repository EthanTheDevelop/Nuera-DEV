import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { uptimeDaily, type Database } from '@nuera/db';
import { parisDayKey, TIME_ZONE } from '@nuera/shared/format';
import type { UptimeResponse } from '@nuera/shared/runner';
import type { Logger } from 'pino';

type Incident = { start: string; end: string | null; reason: string };

/** Minutes elapsed since midnight (Europe/Paris) for a date. */
export function parisMinutesOfDay(date: Date): number {
  const parts = new Intl.DateTimeFormat('fr-FR', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

function incidentMinutes(incidents: Incident[], day: string): number {
  let total = 0;
  for (const i of incidents) {
    const start = Date.parse(i.start);
    const end = i.end ? Date.parse(i.end) : Date.now();
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;
    if (parisDayKey(new Date(start)) !== day && parisDayKey(new Date(end)) !== day) continue;
    total += Math.round((end - start) / 60_000);
  }
  return Math.min(1440, total);
}

/**
 * Availability per day (service `runner`), one heartbeat per minute. On start-up, a gap since the
 * last heartbeat (> 3 min) is recorded as an incident of the day it started.
 */
export class UptimeTracker {
  private readonly startedAt = Date.now();

  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
    private readonly service = 'runner',
  ) {}

  private async firstDay(): Promise<string | null> {
    const [row] = await this.db
      .select({ day: uptimeDaily.day })
      .from(uptimeDaily)
      .where(eq(uptimeDaily.service, this.service))
      .orderBy(uptimeDaily.day)
      .limit(1);
    return row?.day ?? null;
  }

  async detectGap(now = new Date()): Promise<Incident | null> {
    const [last] = await this.db
      .select()
      .from(uptimeDaily)
      .where(eq(uptimeDaily.service, this.service))
      .orderBy(desc(uptimeDaily.lastBeatAt))
      .limit(1);
    if (!last?.lastBeatAt) return null;
    const gapMs = now.getTime() - last.lastBeatAt.getTime();
    if (gapMs <= 3 * 60_000) return null;
    const incident: Incident = { start: last.lastBeatAt.toISOString(), end: now.toISOString(), reason: 'Runner indisponible (arrêt ou redémarrage)' };
    await this.db
      .update(uptimeDaily)
      .set({ incidents: [...(last.incidents ?? []), incident] })
      .where(and(eq(uptimeDaily.day, last.day), eq(uptimeDaily.service, this.service)));
    const today = parisDayKey(now);
    if (today !== last.day) {
      await this.db
        .insert(uptimeDaily)
        .values({ day: today, service: this.service, upMinutes: 0, expectedMinutes: 0, incidents: [incident] })
        .onConflictDoUpdate({
          target: [uptimeDaily.day, uptimeDaily.service],
          set: { incidents: sql`${uptimeDaily.incidents} || ${JSON.stringify([incident])}::jsonb` },
        });
    }
    this.logger.info({ gapMinutes: Math.round(gapMs / 60_000) }, 'indisponibilité détectée au démarrage');
    return incident;
  }

  /** One minute of availability (called every 60 s). */
  async beat(now = new Date()): Promise<void> {
    const day = parisDayKey(now);
    const first = (await this.firstDay()) ?? day;
    const minutesToday = parisMinutesOfDay(now) + 1;
    await this.db
      .insert(uptimeDaily)
      .values({ day, service: this.service, upMinutes: 1, expectedMinutes: first === day ? 1 : minutesToday, lastBeatAt: now })
      .onConflictDoUpdate({
        target: [uptimeDaily.day, uptimeDaily.service],
        set: {
          upMinutes: sql`least(1440, ${uptimeDaily.upMinutes} + 1)`,
          expectedMinutes:
            first === day
              ? sql`least(1440, greatest(${uptimeDaily.expectedMinutes}, ${uptimeDaily.upMinutes} + 1))`
              : sql`${minutesToday}`,
          lastBeatAt: now,
        },
      });
    // Close the previous days: a full day was expected once tracking had started.
    await this.db
      .update(uptimeDaily)
      .set({ expectedMinutes: 1440 })
      .where(and(eq(uptimeDaily.service, this.service), sql`${uptimeDaily.day} < ${day}`, sql`${uptimeDaily.day} > ${first}`, sql`${uptimeDaily.expectedMinutes} < 1440`));
  }

  async report(days: number, now = new Date()): Promise<UptimeResponse> {
    const today = parisDayKey(now);
    const from = parisDayKey(new Date(now.getTime() - (days - 1) * 86_400_000));
    const rows = await this.db
      .select()
      .from(uptimeDaily)
      .where(and(eq(uptimeDaily.service, this.service), gte(uptimeDaily.day, from)));
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const first = await this.firstDay();
    const result: UptimeResponse['days'] = [];
    let up = 0;
    let expected = 0;
    for (let i = days - 1; i >= 0; i -= 1) {
      const day = parisDayKey(new Date(now.getTime() - i * 86_400_000));
      const row = byDay.get(day);
      let expectedMinutes = row?.expectedMinutes ?? 0;
      if (first && day > first && day < today && !row) expectedMinutes = 1440; // whole day missing
      if (day === today && first && first < today) expectedMinutes = parisMinutesOfDay(now) + 1;
      if (row && day === first) expectedMinutes = Math.max(expectedMinutes, row.upMinutes + incidentMinutes(row.incidents ?? [], day));
      const upMinutes = Math.min(row?.upMinutes ?? 0, expectedMinutes || (row?.upMinutes ?? 0));
      up += upMinutes;
      expected += expectedMinutes;
      result.push({
        day,
        upMinutes,
        expectedMinutes,
        availability: expectedMinutes > 0 ? Math.min(100, Math.round((upMinutes / expectedMinutes) * 10_000) / 100) : null,
        incidents: row?.incidents ?? [],
      });
    }
    return {
      service: this.service,
      days: result,
      availabilityPercent: expected > 0 ? Math.min(100, Math.round((up / expected) * 10_000) / 100) : null,
      runningSinceSec: Math.round((Date.now() - this.startedAt) / 1000),
    };
  }
}
