-- Backfill of the multi-account model (docs/MULTICOMPTE.md §3.3). Runs in the same transaction as
-- 0001 (expand) and 0003 (enforce). Correct with 0, 1 or several accounts (the oldest becomes the
-- owner) and with or without an app_settings row. One statement per breakpoint.
-- 1. Instance settings row, with its defaults when it never existed.
INSERT INTO "app_settings" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
-- 2. The oldest account becomes the owner; the others stay members (column default).
UPDATE "user" SET "role" = 'owner'
WHERE "id" = (SELECT "id" FROM "user" ORDER BY "created_at", "id" LIMIT 1);
--> statement-breakpoint
-- 3. One personal space per account: « Espace d'Ethan », « Espace de Camille ».
INSERT INTO "spaces" ("name", "kind", "owner_user_id", "created_at", "updated_at")
SELECT
  CASE
    WHEN btrim(u."name") = '' THEN 'Espace personnel'
    WHEN position(left(btrim(u."name"), 1) IN 'AEIOUYHÀÂÄÉÈÊËÎÏÔÖÙÛÜŸÆŒaeiouyhàâäéèêëîïôöùûüÿæœ') > 0
      THEN 'Espace d''' || split_part(btrim(u."name"), ' ', 1)
    ELSE 'Espace de ' || split_part(btrim(u."name"), ' ', 1)
  END,
  'personal',
  u."id",
  u."created_at",
  now()
FROM "user" AS u;
--> statement-breakpoint
-- 4. Data without any account (only possible before /configuration): an ownerless space holds it,
--    adopted by the first owner.
INSERT INTO "spaces" ("name", "kind")
SELECT 'Espace initial', 'personal'
WHERE NOT EXISTS (SELECT 1 FROM "user")
  AND (EXISTS (SELECT 1 FROM "projects") OR EXISTS (SELECT 1 FROM "integrations") OR EXISTS (SELECT 1 FROM "mcp_servers"));
--> statement-breakpoint
-- 5. Each account owns its personal space.
INSERT INTO "space_members" ("space_id", "user_id", "role", "created_at")
SELECT s."id", s."owner_user_id", 'owner', s."created_at"
FROM "spaces" AS s
WHERE s."owner_user_id" IS NOT NULL;
--> statement-breakpoint
-- 6. Space settings copied from the former instance settings.
INSERT INTO "space_settings" (
  "space_id", "default_model", "default_effort", "default_permission_mode", "block_bypass_permissions",
  "permission_wait_seconds", "remote_control_by_default", "worktree_stale_days"
)
SELECT
  s."id", a."default_model", a."default_effort", a."default_permission_mode", a."block_bypass_permissions",
  a."permission_wait_seconds", a."remote_control_by_default", a."worktree_stale_days"
FROM "spaces" AS s
CROSS JOIN "app_settings" AS a
WHERE a."id" = 1;
--> statement-breakpoint
-- 7. Account preferences copied from the former instance settings (Git identity: the account's own).
INSERT INTO "user_preferences" ("user_id", "theme", "locale")
SELECT u."id", a."theme", a."locale"
FROM "user" AS u
CROSS JOIN "app_settings" AS a
WHERE a."id" = 1;
--> statement-breakpoint
-- 8. The existing runner becomes the default server (URL and token from RUNNER_URL / RUNNER_TOKEN),
--    attached to the owner's space when there is one.
INSERT INTO "environments" (
  "space_id", "name", "location", "status", "config_source", "is_default",
  "max_concurrent_sessions", "max_concurrent_sessions_cap", "session_memory_limit_mb"
)
SELECT
  p."id",
  a."server_name",
  a."server_location",
  CASE WHEN p."id" IS NULL THEN 'pending' ELSE 'active' END,
  'env',
  true,
  a."max_concurrent_sessions",
  greatest(16, a."max_concurrent_sessions"),
  a."session_memory_limit_mb"
FROM "app_settings" AS a
LEFT JOIN (
  SELECT s."id"
  FROM "spaces" AS s
  LEFT JOIN "user" AS u ON u."id" = s."owner_user_id"
  WHERE u."role" = 'owner' OR s."owner_user_id" IS NULL
  ORDER BY s."created_at", s."id"
  LIMIT 1
) AS p ON true
WHERE a."id" = 1
  AND NOT EXISTS (SELECT 1 FROM "environments" AS e WHERE e."is_default");
--> statement-breakpoint
-- 9. Every project belongs to the owner's space and lives on the default server.
UPDATE "projects"
SET
  "space_id" = (
    SELECT s."id"
    FROM "spaces" AS s
    LEFT JOIN "user" AS u ON u."id" = s."owner_user_id"
    WHERE u."role" = 'owner' OR s."owner_user_id" IS NULL
    ORDER BY s."created_at", s."id"
    LIMIT 1
  ),
  "environment_id" = (SELECT e."id" FROM "environments" AS e WHERE e."is_default")
WHERE "environment_id" IS NULL;
--> statement-breakpoint
-- 10. With a single account, that account created every project.
UPDATE "projects"
SET "created_by_user_id" = (SELECT "id" FROM "user" ORDER BY "created_at", "id" LIMIT 1)
WHERE "created_by_user_id" IS NULL AND (SELECT count(*) FROM "user") = 1;
--> statement-breakpoint
-- 11. Runtime rows copy the server of their project.
UPDATE "worktrees" AS w
SET "environment_id" = p."environment_id"
FROM "projects" AS p
WHERE p."id" = w."project_id" AND w."environment_id" IS NULL;
--> statement-breakpoint
UPDATE "sessions" AS t
SET "environment_id" = p."environment_id"
FROM "projects" AS p
WHERE p."id" = t."project_id" AND t."environment_id" IS NULL;
--> statement-breakpoint
UPDATE "command_runs" AS r
SET "environment_id" = p."environment_id"
FROM "projects" AS p
WHERE p."id" = r."project_id" AND r."environment_id" IS NULL;
--> statement-breakpoint
UPDATE "operations" AS o
SET "environment_id" = coalesce(
  (SELECT p."environment_id" FROM "projects" AS p WHERE p."id" = o."project_id"),
  (SELECT e."id" FROM "environments" AS e WHERE e."is_default")
)
WHERE o."environment_id" IS NULL;
--> statement-breakpoint
-- 12. With a single account, that account started every command.
UPDATE "command_runs"
SET "actor_user_id" = (SELECT "id" FROM "user" ORDER BY "created_at", "id" LIMIT 1)
WHERE "actor_user_id" IS NULL AND (SELECT count(*) FROM "user") = 1;
--> statement-breakpoint
-- 13. The GitHub App becomes a GitHub source of the owner's space, with the same id. The app id is
--     read from the JSON payload only when it is a plain integer (malformed values give null).
INSERT INTO "github_sources" (
  "id", "space_id", "kind", "label", "app_id", "owner_login", "owner_type", "status", "config",
  "secrets_encrypted", "last_checked_at", "last_success_at", "last_error", "expires_at", "created_at", "updated_at"
)
SELECT
  i."id",
  (
    SELECT s."id"
    FROM "spaces" AS s
    LEFT JOIN "user" AS u ON u."id" = s."owner_user_id"
    WHERE u."role" = 'owner' OR s."owner_user_id" IS NULL
    ORDER BY s."created_at", s."id"
    LIMIT 1
  ),
  'app',
  coalesce(i."label", i."config" ->> 'name'),
  CASE WHEN (i."config" ->> 'appId') ~ '^[0-9]{1,18}$' THEN (i."config" ->> 'appId')::bigint END,
  i."config" -> 'owner' ->> 'login',
  i."config" -> 'owner' ->> 'type',
  i."status",
  i."config",
  i."secrets_encrypted",
  i."last_checked_at",
  i."last_success_at",
  i."last_error",
  i."expires_at",
  i."created_at",
  i."updated_at"
FROM "integrations" AS i
WHERE i."kind" = 'github';
--> statement-breakpoint
-- 14. Projects use that source when it is the only one.
UPDATE "projects"
SET "github_source_id" = (SELECT g."id" FROM "github_sources" AS g ORDER BY g."created_at", g."id" LIMIT 1)
WHERE "github_source_id" IS NULL AND (SELECT count(*) FROM "github_sources") = 1;
--> statement-breakpoint
-- 15. The moved rows leave integrations (which keeps one Coolify / Figma row per space).
DELETE FROM "integrations" AS i
WHERE i."kind" = 'github' AND EXISTS (SELECT 1 FROM "github_sources" AS g WHERE g."id" = i."id");
--> statement-breakpoint
-- 16. Integrations and the MCP registry belong to the owner's space.
UPDATE "integrations"
SET "space_id" = (
  SELECT s."id"
  FROM "spaces" AS s
  LEFT JOIN "user" AS u ON u."id" = s."owner_user_id"
  WHERE u."role" = 'owner' OR s."owner_user_id" IS NULL
  ORDER BY s."created_at", s."id"
  LIMIT 1
)
WHERE "space_id" IS NULL;
--> statement-breakpoint
UPDATE "mcp_servers"
SET "space_id" = (
  SELECT s."id"
  FROM "spaces" AS s
  LEFT JOIN "user" AS u ON u."id" = s."owner_user_id"
  WHERE u."role" = 'owner' OR s."owner_user_id" IS NULL
  ORDER BY s."created_at", s."id"
  LIMIT 1
)
WHERE "space_id" IS NULL;
--> statement-breakpoint
-- 17. Without any account, nobody can ever read a notification.
DELETE FROM "notifications" WHERE NOT EXISTS (SELECT 1 FROM "user");
--> statement-breakpoint
-- 18. Notifications are addressed to the owner, about the owner's space.
UPDATE "notifications" AS n
SET "user_id" = u."id", "space_id" = s."id"
FROM "user" AS u
JOIN "spaces" AS s ON s."owner_user_id" = u."id" AND s."kind" = 'personal'
WHERE u."role" = 'owner' AND n."user_id" IS NULL;
--> statement-breakpoint
-- 19. GitHub dedup keys name their source: integration:github:<sourceId>:<state>, or
--     integration:github:fallback:<state> for the fallback token (no GitHub App).
UPDATE "notifications"
SET "dedup_key" = 'integration:github:'
  || coalesce((SELECT g."id"::text FROM "github_sources" AS g ORDER BY g."created_at", g."id" LIMIT 1), 'fallback')
  || ':' || substr("dedup_key", 20)
WHERE "dedup_key" LIKE 'integration:github:%' AND position(':' IN substr("dedup_key", 20)) = 0;
--> statement-breakpoint
-- 20. One unread notification per recipient and key: older duplicates are marked read.
UPDATE "notifications" AS n
SET "read_at" = now()
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "user_id", "dedup_key" ORDER BY "created_at" DESC, "id" DESC) AS "rn"
  FROM "notifications"
  WHERE "read_at" IS NULL AND "dedup_key" IS NOT NULL
) AS d
WHERE n."id" = d."id" AND d."rn" > 1;
--> statement-breakpoint
-- 21. Journal: e-mail of the author, frozen.
UPDATE "audit_log" AS a
SET "actor_label" = u."email"
FROM "user" AS u
WHERE u."id" = a."actor_user_id" AND a."actor_label" IS NULL;
--> statement-breakpoint
-- 22. Journal: account and security events concern their author…
UPDATE "audit_log"
SET "subject_user_id" = "actor_user_id"
WHERE "subject_user_id" IS NULL
  AND "actor_user_id" IS NOT NULL
  AND ("action" LIKE 'auth.%' OR "action" LIKE 'security.%');
--> statement-breakpoint
-- 23. …and a failed sign-in concerns the account of the e-mail it tried.
UPDATE "audit_log" AS a
SET "subject_user_id" = u."id"
FROM "user" AS u
WHERE a."subject_user_id" IS NULL
  AND a."action" LIKE 'auth.%'
  AND jsonb_typeof(a."metadata") = 'object'
  AND lower(a."metadata" ->> 'email') = lower(u."email");
--> statement-breakpoint
-- 24. Journal: business events (projects, sessions, Git, integrations…) belong to the owner's space.
UPDATE "audit_log"
SET "space_id" = (
  SELECT s."id"
  FROM "spaces" AS s
  LEFT JOIN "user" AS u ON u."id" = s."owner_user_id"
  WHERE u."role" = 'owner' OR s."owner_user_id" IS NULL
  ORDER BY s."created_at", s."id"
  LIMIT 1
)
WHERE "space_id" IS NULL
  AND "action" NOT LIKE 'auth.%'
  AND "action" NOT LIKE 'security.%'
  AND "action" NOT LIKE 'settings.%';
--> statement-breakpoint
-- 25. Journal: what ran on the runner happened on the default server.
UPDATE "audit_log"
SET "environment_id" = (SELECT e."id" FROM "environments" AS e WHERE e."is_default")
WHERE "environment_id" IS NULL
  AND "space_id" IS NOT NULL
  AND (
    "actor_kind" = 'runner'
    OR "action" LIKE 'git.%'
    OR "action" LIKE 'project.%'
    OR "action" LIKE 'session.%'
    OR "action" LIKE 'terminal.%'
    OR "action" LIKE 'permission.%'
    OR "action" LIKE 'maintenance.%'
  );
