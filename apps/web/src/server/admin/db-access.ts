import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '@/server/db';
import { RUNNER_GROUP_ROLE } from './db-roles';

/**
 * « Accès base restreint » checked by the web itself (docs/MULTICOMPTE.md §11). The runner's
 * heartbeat writes `capabilities.database = { role, restricted }`, but that column is writable by
 * the runner — and so by a Claude session that reads its DSN: a server still using the full
 * DATABASE_URL could pretend to be restricted. A server counts as restricted only when BOTH agree:
 *
 * 1. its heartbeat says `restricted` for the role recorded in `environments.db_role`;
 * 2. PostgreSQL says that role exists, can log in, is neither superuser nor BYPASSRLS, is a member
 *    of `nuera_runner` and has no privileges of the owner of the tables (`pg_roles`);
 * 3. the runner connections PostgreSQL shows agree (`pg_stat_activity`, this database only):
 *    a connection named after the server (`nuera-runner:<id>`, `nuera-runner-lease:<id>`) must use
 *    that role; and for the default server, no runner connection (`nuera-runner…`) may use a role
 *    other than a verified runner role — that is a runner connected with the full DSN. With no
 *    runner connection visible (runner stopped), the heartbeat and the role check decide.
 */

export interface DatabaseAccessRow {
  id: string;
  isDefault: boolean;
  dbRole: string | null;
  capabilities: unknown;
}

interface RoleFacts {
  name: string;
  login: boolean;
  superuser: boolean;
  bypassRls: boolean;
  member: boolean;
  tableOwner: boolean;
}

interface Backend {
  role: string | null;
  application: string;
}

const RUNNER_APPLICATION = /^nuera-runner(?:-lease)?(?::([0-9a-f-]{36}))?$/i;

function heartbeatOf(capabilities: unknown): { role: string | null; restricted: boolean } {
  const database = (
    capabilities as
      { database?: { role?: unknown; restricted?: unknown } | null } | null | undefined
  )?.database;
  return {
    role: typeof database?.role === 'string' ? database.role : null,
    restricted: database?.restricted === true,
  };
}

async function roleFacts(names: string[]): Promise<Map<string, RoleFacts>> {
  if (names.length === 0) return new Map();
  const rows = (await db.execute(sql`
    select r.rolname as name,
           r.rolcanlogin as login,
           r.rolsuper as superuser,
           r.rolbypassrls as bypass_rls,
           case when g.oid is null then false else pg_catalog.pg_has_role(r.oid, g.oid, 'MEMBER') end as member,
           case when c.oid is null then true else pg_catalog.pg_has_role(r.oid, c.relowner, 'MEMBER') end as table_owner
      from pg_catalog.pg_roles r
      left join pg_catalog.pg_roles g on g.rolname = ${RUNNER_GROUP_ROLE}
      left join pg_catalog.pg_class c on c.oid = pg_catalog.to_regclass('public.environments')
     where r.rolname in (${sql.join(
       names.map((name) => sql`${name}`),
       sql`, `,
     )})
  `)) as unknown as Array<{
    name: string;
    login: boolean;
    superuser: boolean;
    bypass_rls: boolean;
    member: boolean;
    table_owner: boolean;
  }>;
  return new Map(
    Array.from(rows, (row) => [
      row.name,
      {
        name: row.name,
        login: row.login,
        superuser: row.superuser,
        bypassRls: row.bypass_rls,
        member: row.member,
        tableOwner: row.table_owner,
      },
    ]),
  );
}

async function runnerBackends(): Promise<Backend[]> {
  const rows = (await db.execute(sql`
    select usename as role, application_name as application
      from pg_catalog.pg_stat_activity
     where datname = pg_catalog.current_database()
       and application_name like 'nuera-runner%'
  `)) as unknown as Array<{ role: string | null; application: string | null }>;
  return Array.from(rows, (row) => ({ role: row.role, application: row.application ?? '' })).filter(
    (row) => RUNNER_APPLICATION.test(row.application),
  );
}

function verified(facts: RoleFacts | undefined): boolean {
  return Boolean(
    facts &&
    facts.login &&
    !facts.superuser &&
    !facts.bypassRls &&
    facts.member &&
    !facts.tableOwner,
  );
}

/**
 * Whether each server's runner really uses its restricted role (id → boolean). Never throws: when
 * PostgreSQL cannot be asked, every server counts as unrestricted (the warning stays).
 */
export async function assessRestrictedAccess(
  rows: DatabaseAccessRow[],
): Promise<Map<string, boolean>> {
  const verdicts = new Map<string, boolean>(rows.map((row) => [row.id, false]));
  const candidates = rows.filter((row) => {
    const heartbeat = heartbeatOf(row.capabilities);
    return row.dbRole !== null && heartbeat.restricted && heartbeat.role === row.dbRole;
  });
  if (candidates.length === 0) return verdicts;
  let facts: Map<string, RoleFacts>;
  let backends: Backend[];
  try {
    backends = await runnerBackends();
    // The roles of every visible runner connection are checked too: another server's runner on its
    // own restricted role is not « a runner with the full DSN », even when its heartbeat is late.
    facts = await roleFacts([
      ...new Set([
        ...candidates.map((row) => row.dbRole!),
        ...backends.flatMap((backend) => (backend.role ? [backend.role] : [])),
      ]),
    ]);
  } catch (error) {
    console.warn(
      '[serveurs] accès base des serveurs non vérifiable',
      error instanceof Error ? error.message : error,
    );
    return verdicts;
  }
  const verifiedRoles = new Set([...facts.values()].filter(verified).map((item) => item.name));
  const unattributed = backends.filter(
    (backend) => !RUNNER_APPLICATION.exec(backend.application)?.[1],
  );
  const fullAccessRunner = unattributed.some(
    (backend) => !backend.role || !verifiedRoles.has(backend.role),
  );
  for (const row of candidates) {
    if (!verifiedRoles.has(row.dbRole!)) continue;
    const named = backends.filter(
      (backend) =>
        RUNNER_APPLICATION.exec(backend.application)?.[1]?.toLowerCase() === row.id.toLowerCase(),
    );
    if (named.some((backend) => backend.role !== row.dbRole)) continue;
    if (row.isDefault && fullAccessRunner) continue;
    verdicts.set(row.id, true);
  }
  return verdicts;
}
