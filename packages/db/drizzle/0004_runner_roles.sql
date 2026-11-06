-- Restricted database access for runners (docs/MULTICOMPTE.md §11). A server registered by an
-- administrator gets a login role nuera_env_<8 hex> IN ROLE nuera_runner, recorded in
-- environments.db_role: it reaches the runner tables only, and only the rows of its own server
-- (row-level security). The web and a runner using the full DSN connect as the table owner (or a
-- superuser) and bypass row-level security: nothing changes for them. No grant at all on the
-- account, invitation, GitHub source, integration, MCP, variable, notification, push and journal
-- tables. The runner never deletes a row: no DELETE, and never TRUNCATE (it ignores row-level
-- security). UPDATE is granted column by column, never on a whole table (that would allow LOCK
-- TABLE … IN ACCESS EXCLUSIVE MODE). Every new table touched by the runner must carry its GRANT and
-- its policy, every new column of its tables a GRANT UPDATE (packages/db/src/rls.test.ts pins the
-- exact grants and fails on a column added to a runner table without one).
-- Policies call the identity function through a scalar subquery: evaluated once per statement.
-- 1. Shared NOLOGIN role (roles are cluster-wide: created once, concurrent migrations tolerated).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'nuera_runner') THEN
    CREATE ROLE "nuera_runner" NOLOGIN;
  END IF;
EXCEPTION
  WHEN duplicate_object OR unique_violation THEN NULL;
END
$$;
--> statement-breakpoint
-- 2. Server of the connected runner role (null when unknown or retired).
CREATE OR REPLACE FUNCTION "public"."nuera_runner_environment_id"() RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT e."id"
  FROM "public"."environments" AS e
  WHERE e."db_role" = session_user AND e."status" <> 'retired'
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."nuera_runner_environment_id"() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."nuera_runner_environment_id"() TO "nuera_runner";
--> statement-breakpoint
-- 3. Least privilege.
GRANT USAGE ON SCHEMA "public" TO "nuera_runner";
--> statement-breakpoint
-- Its server row: everything but the token ciphertexts; it only writes its heartbeat.
GRANT SELECT (
  "id", "space_id", "name", "location", "status", "config_source", "is_default", "url", "token_hash",
  "next_token_hash", "token_rotated_at", "db_role", "max_concurrent_sessions", "max_concurrent_sessions_cap",
  "session_memory_limit_mb", "last_seen_at", "last_error", "runner_version", "contract_version", "backend",
  "capabilities", "created_at", "updated_at"
) ON "environments" TO "nuera_runner";
--> statement-breakpoint
GRANT UPDATE ("last_seen_at", "runner_version", "contract_version", "backend", "capabilities", "updated_at")
ON "environments" TO "nuera_runner";
--> statement-breakpoint
-- Projects: read, and write the clone and synchronisation state only (never the space or the server).
GRANT SELECT ON "projects" TO "nuera_runner";
--> statement-breakpoint
GRANT UPDATE (
  "status", "status_detail", "path", "default_branch", "current_branch", "commands", "sync_state", "ahead_by",
  "behind_by", "last_commit_sha", "last_commit_message", "last_commit_at", "claude_md_updated_at",
  "claude_md_commit_sha", "last_fetched_at", "last_synced_at", "updated_at"
) ON "projects" TO "nuera_runner";
--> statement-breakpoint
-- Work rows and availability: read and create at table level; UPDATE column by column (every
-- column), because a table-level UPDATE also allows LOCK TABLE … IN ACCESS EXCLUSIVE MODE, which
-- would freeze the table for every server and the web. A column added later needs its grant.
GRANT SELECT, INSERT
ON "worktrees", "sessions", "session_events", "permission_requests", "operations", "command_runs", "uptime_daily"
TO "nuera_runner";
--> statement-breakpoint
GRANT UPDATE (
  "id", "project_id", "name", "branch", "base_branch", "path", "is_primary", "status", "created_at", "last_used_at",
  "removed_at", "environment_id"
) ON "worktrees" TO "nuera_runner";
--> statement-breakpoint
GRANT UPDATE (
  "id", "project_id", "worktree_id", "title", "status", "backend", "tmux_name", "pid", "permission_mode", "model",
  "effort", "remote_control", "remote_control_url", "transcript_path", "claude_session_id", "hook_token_hash",
  "last_instruction", "current_activity", "plan_done", "plan_total", "cli_status", "resume_count", "exit_code",
  "error_code", "error_message", "last_activity_at", "started_at", "ended_at", "archived_at", "created_by_user_id",
  "created_at", "updated_at", "environment_id"
) ON "sessions" TO "nuera_runner";
--> statement-breakpoint
GRANT UPDATE ("id", "session_id", "position", "version", "key", "kind", "payload", "created_at", "updated_at")
ON "session_events" TO "nuera_runner";
--> statement-breakpoint
GRANT UPDATE (
  "id", "session_id", "tool_name", "tool_input", "title", "target", "detail", "suggestions", "status",
  "decision_message", "decided_at", "decided_by_user_id", "expires_at", "created_at"
) ON "permission_requests" TO "nuera_runner";
--> statement-breakpoint
GRANT UPDATE (
  "id", "kind", "status", "project_id", "worktree_id", "session_id", "title", "progress", "steps", "log", "error",
  "result", "actor_user_id", "created_at", "started_at", "finished_at", "environment_id"
) ON "operations" TO "nuera_runner";
--> statement-breakpoint
GRANT UPDATE (
  "id", "project_id", "worktree_id", "kind", "command", "status", "exit_code", "pid", "port", "summary", "output_tail",
  "details", "started_at", "finished_at", "environment_id", "actor_user_id"
) ON "command_runs" TO "nuera_runner";
--> statement-breakpoint
GRANT UPDATE ("day", "service", "up_minutes", "expected_minutes", "incidents", "last_beat_at")
ON "uptime_daily" TO "nuera_runner";
--> statement-breakpoint
GRANT USAGE ON SEQUENCE "session_events_id_seq" TO "nuera_runner";
--> statement-breakpoint
GRANT SELECT ON "space_settings" TO "nuera_runner";
--> statement-breakpoint
GRANT SELECT ("id", "force_block_bypass_permissions") ON "app_settings" TO "nuera_runner";
--> statement-breakpoint
-- 4. Row-level security: a restricted runner only sees and writes the rows of its own server.
ALTER TABLE "environments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "nuera_runner_scope" ON "environments" AS PERMISSIVE FOR ALL TO "nuera_runner"
USING ("id" = (SELECT "public"."nuera_runner_environment_id"()))
WITH CHECK ("id" = (SELECT "public"."nuera_runner_environment_id"()));
--> statement-breakpoint
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "nuera_runner_scope" ON "projects" AS PERMISSIVE FOR ALL TO "nuera_runner"
USING ("environment_id" = (SELECT "public"."nuera_runner_environment_id"()))
WITH CHECK ("environment_id" = (SELECT "public"."nuera_runner_environment_id"()));
--> statement-breakpoint
ALTER TABLE "worktrees" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "nuera_runner_scope" ON "worktrees" AS PERMISSIVE FOR ALL TO "nuera_runner"
USING ("environment_id" = (SELECT "public"."nuera_runner_environment_id"()))
WITH CHECK ("environment_id" = (SELECT "public"."nuera_runner_environment_id"()));
--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "nuera_runner_scope" ON "sessions" AS PERMISSIVE FOR ALL TO "nuera_runner"
USING ("environment_id" = (SELECT "public"."nuera_runner_environment_id"()))
WITH CHECK ("environment_id" = (SELECT "public"."nuera_runner_environment_id"()));
--> statement-breakpoint
ALTER TABLE "command_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "nuera_runner_scope" ON "command_runs" AS PERMISSIVE FOR ALL TO "nuera_runner"
USING ("environment_id" = (SELECT "public"."nuera_runner_environment_id"()))
WITH CHECK ("environment_id" = (SELECT "public"."nuera_runner_environment_id"()));
--> statement-breakpoint
ALTER TABLE "operations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "nuera_runner_scope" ON "operations" AS PERMISSIVE FOR ALL TO "nuera_runner"
USING ("environment_id" = (SELECT "public"."nuera_runner_environment_id"()))
WITH CHECK ("environment_id" = (SELECT "public"."nuera_runner_environment_id"()));
--> statement-breakpoint
ALTER TABLE "session_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "nuera_runner_scope" ON "session_events" AS PERMISSIVE FOR ALL TO "nuera_runner"
USING (
  EXISTS (
    SELECT 1 FROM "public"."sessions" AS s
    WHERE s."id" = "session_events"."session_id"
      AND s."environment_id" = (SELECT "public"."nuera_runner_environment_id"())
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM "public"."sessions" AS s
    WHERE s."id" = "session_events"."session_id"
      AND s."environment_id" = (SELECT "public"."nuera_runner_environment_id"())
  )
);
--> statement-breakpoint
ALTER TABLE "permission_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "nuera_runner_scope" ON "permission_requests" AS PERMISSIVE FOR ALL TO "nuera_runner"
USING (
  EXISTS (
    SELECT 1 FROM "public"."sessions" AS s
    WHERE s."id" = "permission_requests"."session_id"
      AND s."environment_id" = (SELECT "public"."nuera_runner_environment_id"())
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM "public"."sessions" AS s
    WHERE s."id" = "permission_requests"."session_id"
      AND s."environment_id" = (SELECT "public"."nuera_runner_environment_id"())
  )
);
--> statement-breakpoint
ALTER TABLE "space_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "nuera_runner_scope" ON "space_settings" AS PERMISSIVE FOR SELECT TO "nuera_runner"
USING (
  "space_id" = (
    SELECT e."space_id" FROM "public"."environments" AS e
    WHERE e."id" = (SELECT "public"."nuera_runner_environment_id"())
  )
);
--> statement-breakpoint
-- Availability key of a server: 'runner' for the default server, 'runner:<id>' for the others.
ALTER TABLE "uptime_daily" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "nuera_runner_scope" ON "uptime_daily" AS PERMISSIVE FOR ALL TO "nuera_runner"
USING (
  "service" = (
    SELECT CASE WHEN e."is_default" THEN 'runner' ELSE 'runner:' || e."id"::text END
    FROM "public"."environments" AS e
    WHERE e."id" = (SELECT "public"."nuera_runner_environment_id"())
  )
)
WITH CHECK (
  "service" = (
    SELECT CASE WHEN e."is_default" THEN 'runner' ELSE 'runner:' || e."id"::text END
    FROM "public"."environments" AS e
    WHERE e."id" = (SELECT "public"."nuera_runner_environment_id"())
  )
);
