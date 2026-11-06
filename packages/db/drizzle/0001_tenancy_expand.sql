SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid,
	"name" text NOT NULL,
	"location" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"config_source" text DEFAULT 'db' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"url" text,
	"token_encrypted" text,
	"token_hash" text,
	"next_token_encrypted" text,
	"next_token_hash" text,
	"token_rotated_at" timestamp with time zone,
	"db_role" text,
	"max_concurrent_sessions" integer DEFAULT 4 NOT NULL,
	"max_concurrent_sessions_cap" integer DEFAULT 16 NOT NULL,
	"session_memory_limit_mb" integer,
	"last_seen_at" timestamp with time zone,
	"last_error" text,
	"runner_version" text,
	"contract_version" integer,
	"backend" text,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environments_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "environments_next_token_hash_unique" UNIQUE("next_token_hash"),
	CONSTRAINT "environments_db_role_unique" UNIQUE("db_role"),
	CONSTRAINT "environments_id_space_key" UNIQUE("id","space_id")
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text DEFAULT 'invite' NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"user_id" text,
	"environment_id" uuid,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by_user_id" text,
	"accepted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "space_members" (
	"space_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_members_space_id_user_id_pk" PRIMARY KEY("space_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "space_settings" (
	"space_id" uuid PRIMARY KEY NOT NULL,
	"default_model" text,
	"default_effort" text,
	"default_permission_mode" text DEFAULT 'manual' NOT NULL,
	"block_bypass_permissions" boolean DEFAULT true NOT NULL,
	"permission_wait_seconds" integer DEFAULT 120 NOT NULL,
	"remote_control_by_default" boolean DEFAULT false NOT NULL,
	"worktree_stale_days" integer DEFAULT 30 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'personal' NOT NULL,
	"owner_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"theme" text DEFAULT 'light' NOT NULL,
	"locale" text DEFAULT 'fr' NOT NULL,
	"git_author_name" text,
	"git_author_email" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"kind" text DEFAULT 'app' NOT NULL,
	"label" text,
	"app_id" bigint,
	"owner_login" text,
	"owner_type" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets_encrypted" text,
	"last_checked_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"expires_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_sources_id_space_key" UNIQUE("id","space_id")
);
--> statement-breakpoint
DROP INDEX "user_single_owner_idx";--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "command_runs" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "command_runs" ADD COLUMN "actor_user_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "space_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "github_source_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "worktrees" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "space_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "space_id" uuid;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "invitation_ttl_hours" integer DEFAULT 48 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "force_block_bypass_permissions" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "space_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "subject_user_id" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_label" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "space_id" uuid;--> statement-breakpoint
ALTER TABLE "operations" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD COLUMN "auth_session_id" text;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_settings" ADD CONSTRAINT "space_settings_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_sources" ADD CONSTRAINT "github_sources_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_sources" ADD CONSTRAINT "github_sources_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "environments_default_idx" ON "environments" USING btree ((true)) WHERE "environments"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "environments_space_active_idx" ON "environments" USING btree ("space_id") WHERE "environments"."space_id" is not null and "environments"."status" <> 'retired';--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_pending_email_idx" ON "invitations" USING btree ("kind","email") WHERE "invitations"."accepted_at" is null and "invitations"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "space_members_user_idx" ON "space_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "spaces_personal_owner_idx" ON "spaces" USING btree ("owner_user_id") WHERE "spaces"."kind" = 'personal';--> statement-breakpoint
CREATE UNIQUE INDEX "github_sources_app_id_idx" ON "github_sources" USING btree ("app_id") WHERE "github_sources"."app_id" is not null;--> statement-breakpoint
CREATE INDEX "github_sources_space_idx" ON "github_sources" USING btree ("space_id");--> statement-breakpoint
ALTER TABLE "command_runs" ADD CONSTRAINT "command_runs_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_owner_idx" ON "user" USING btree ((true)) WHERE "user"."role" = 'owner';--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_id_environment_key" UNIQUE("id","environment_id");