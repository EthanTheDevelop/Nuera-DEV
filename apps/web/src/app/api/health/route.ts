import { sql } from 'drizzle-orm';
import { db } from '@/server/db';
import packageJson from '../../../../package.json';

/**
 * Healthcheck (Docker / Coolify / uptime): no authentication, no secret, no detail.
 * Always 200 so the reverse proxy keeps routing to the app (which shows its own « serveur
 * indisponible » state); `status: 'degraded'` and `db: false` when PostgreSQL does not answer.
 */
export const dynamic = 'force-dynamic';

const DB_TIMEOUT_MS = 3_000;
const version = process.env.NUERA_VERSION || packageJson.version;

async function pingDatabase(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), DB_TIMEOUT_MS);
    });
    await Promise.race([db.execute(sql`select 1`), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function GET(): Promise<Response> {
  const dbOk = await pingDatabase();
  return Response.json(
    { status: dbOk ? 'ok' : 'degraded', db: dbOk, version },
    { headers: { 'cache-control': 'no-store' } },
  );
}
