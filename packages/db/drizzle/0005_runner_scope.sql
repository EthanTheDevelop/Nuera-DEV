SET LOCAL lock_timeout = '10s';--> statement-breakpoint
-- Runner rows only point to a worktree or a session of their own server (docs/MULTICOMPTE.md §11):
-- composite foreign keys (worktree_id, environment_id) → worktrees(id, environment_id) and
-- (session_id, environment_id) → sessions(id, environment_id). Before 0005 they checked the id
-- alone, as the table owner (row-level security does not apply to foreign key checks): a restricted
-- runner could link its rows to another server's worktree or session.
-- 1. A reference that does not match its row's server is cleared (what ON DELETE SET NULL would do).
UPDATE "sessions" AS s SET "worktree_id" = NULL
WHERE s."worktree_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "worktrees" AS w WHERE w."id" = s."worktree_id" AND w."environment_id" = s."environment_id");
--> statement-breakpoint
UPDATE "command_runs" AS r SET "worktree_id" = NULL
WHERE r."worktree_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "worktrees" AS w WHERE w."id" = r."worktree_id" AND w."environment_id" = r."environment_id");
--> statement-breakpoint
UPDATE "operations" AS o SET "worktree_id" = NULL
WHERE o."worktree_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "worktrees" AS w WHERE w."id" = o."worktree_id" AND w."environment_id" = o."environment_id");
--> statement-breakpoint
UPDATE "operations" AS o SET "session_id" = NULL
WHERE o."session_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "sessions" AS s WHERE s."id" = o."session_id" AND s."environment_id" = o."environment_id");
--> statement-breakpoint
-- 2. Targets of the composite keys.
ALTER TABLE "worktrees" ADD CONSTRAINT "worktrees_id_environment_key" UNIQUE("id","environment_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_id_environment_key" UNIQUE("id","environment_id");--> statement-breakpoint
-- 3. Composite keys. ON DELETE SET NULL with a column list (PostgreSQL 15+): only the reference is
-- cleared, the server (NOT NULL) stays.
ALTER TABLE "command_runs" DROP CONSTRAINT "command_runs_worktree_id_worktrees_id_fk";--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_worktree_id_worktrees_id_fk";--> statement-breakpoint
ALTER TABLE "operations" DROP CONSTRAINT "operations_worktree_id_worktrees_id_fk";--> statement-breakpoint
ALTER TABLE "operations" DROP CONSTRAINT "operations_session_id_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "command_runs" ADD CONSTRAINT "command_runs_worktree_env_fk" FOREIGN KEY ("worktree_id","environment_id") REFERENCES "public"."worktrees"("id","environment_id") ON DELETE SET NULL ("worktree_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_worktree_env_fk" FOREIGN KEY ("worktree_id","environment_id") REFERENCES "public"."worktrees"("id","environment_id") ON DELETE SET NULL ("worktree_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_worktree_env_fk" FOREIGN KEY ("worktree_id","environment_id") REFERENCES "public"."worktrees"("id","environment_id") ON DELETE SET NULL ("worktree_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_session_env_fk" FOREIGN KEY ("session_id","environment_id") REFERENCES "public"."sessions"("id","environment_id") ON DELETE SET NULL ("session_id") ON UPDATE no action;--> statement-breakpoint
-- 4. Advisory locks. PUBLIC may take any advisory lock by default: a restricted runner role could
-- hold the migration lock ('nuera:migrate': deploys hang), another server's lease or the web's
-- locks (integration checks, invitations, GitHub sources). The lock-taking functions are taken
-- away from PUBLIC and granted back to the migrating role and to the owner of the tables (the web
-- and a runner using the full DSN). Unlock functions stay public: a session only ever releases its
-- own locks. Only a superuser may change the privileges of pg_catalog: otherwise the step is
-- skipped with a warning (the locks stay open to every role, docs/DEPLOY.md). Privileges of
-- pg_catalog functions are per database: the other databases of the cluster are untouched.
DO $$
DECLARE
  fn regprocedure;
  app_owner name;
BEGIN
  IF NOT COALESCE((SELECT r."rolsuper" FROM pg_catalog.pg_roles AS r WHERE r."rolname" = current_user), false) THEN
    RAISE WARNING 'Nuera Dev : migration 0005 sans superutilisateur, les verrous consultatifs restent ouverts à tous les rôles.';
    RETURN;
  END IF;
  SELECT pg_catalog.pg_get_userbyid(c."relowner") INTO app_owner
  FROM pg_catalog.pg_class AS c WHERE c."oid" = 'public.environments'::regclass;
  FOR fn IN
    SELECT p."oid"::regprocedure
    FROM pg_catalog.pg_proc AS p
    WHERE p."pronamespace" = 'pg_catalog'::regnamespace
      AND p."proname" ~ '^pg_(try_)?advisory_(xact_)?lock(_shared)?$'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, current_user);
    IF app_owner IS NOT NULL AND app_owner <> current_user THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, app_owner);
    END IF;
  END LOOP;
END
$$;
--> statement-breakpoint
-- 5. The lease of a restricted runner (one live runner per server, apps/runner/src/environment.ts):
-- the only advisory lock it may take, that of its own server. Same key as a runner using the full
-- DSN: hashtextextended('nuera:environment:' || id, 0). The lock belongs to the calling session.
CREATE OR REPLACE FUNCTION "public"."nuera_runner_try_lease"() RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  env uuid := "public"."nuera_runner_environment_id"();
BEGIN
  IF env IS NULL THEN
    RETURN false;
  END IF;
  RETURN pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended('nuera:environment:' || env::text, 0));
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."nuera_runner_release_lease"() RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  env uuid := "public"."nuera_runner_environment_id"();
BEGIN
  IF env IS NULL THEN
    RETURN false;
  END IF;
  RETURN pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended('nuera:environment:' || env::text, 0));
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."nuera_runner_try_lease"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."nuera_runner_release_lease"() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."nuera_runner_try_lease"() TO "nuera_runner";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."nuera_runner_release_lease"() TO "nuera_runner";
