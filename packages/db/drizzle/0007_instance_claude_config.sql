SET LOCAL lock_timeout = '10s';--> statement-breakpoint
-- Configuration Claude commune (lot K1) : règles, skills, serveurs MCP et politique de permissions de
-- l'instance, versions, propositions des membres, choix des espaces et ce que chaque session a reçu.
-- Écrites par le web seulement : le runner lit la configuration effective de son serveur par la route
-- interne /api/internal/claude-config (jeton du serveur). Le rôle restreint « nuera_runner » ne reçoit
-- donc aucun droit sur ces tables (0004 n'accorde rien par défaut ; rls.test.ts le vérifie).
CREATE TABLE "instance_claude_policy" (
	"id" text PRIMARY KEY DEFAULT 'instance' NOT NULL,
	"allow_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ask_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deny_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"env" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_model" text,
	"model_enforcement" text DEFAULT 'default' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_claude_policy_single_row" CHECK ("instance_claude_policy"."id" = 'instance')
);
--> statement-breakpoint
CREATE TABLE "instance_config_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"target_id" uuid,
	"title" text NOT NULL,
	"payload" jsonb NOT NULL,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"author_user_id" text NOT NULL,
	"reviewer_user_id" text,
	"review_note" text,
	"applied_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "instance_config_versions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"item_kind" text NOT NULL,
	"item_id" text NOT NULL,
	"item_label" text NOT NULL,
	"version" integer NOT NULL,
	"action" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"author_user_id" text,
	"author_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instance_mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"kind" text DEFAULT 'custom' NOT NULL,
	"transport" text NOT NULL,
	"url" text,
	"command" text,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"auth_kind" text DEFAULT 'none' NOT NULL,
	"secrets_encrypted" text,
	"secret_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"audience" text DEFAULT 'all' NOT NULL,
	"enforcement" text DEFAULT 'default' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"last_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"abilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"abilities_source" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instance_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"audience" text DEFAULT 'all' NOT NULL,
	"enforcement" text DEFAULT 'default' NOT NULL,
	"project_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instance_skill_files" (
	"skill_id" uuid NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"executable" boolean DEFAULT false NOT NULL,
	"size_bytes" integer NOT NULL,
	CONSTRAINT "instance_skill_files_skill_id_path_pk" PRIMARY KEY("skill_id","path")
);
--> statement-breakpoint
CREATE TABLE "instance_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"audience" text DEFAULT 'all' NOT NULL,
	"enforcement" text DEFAULT 'default' NOT NULL,
	"allow_scripts" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"content_hash" text NOT NULL,
	"total_bytes" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_claude_config" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "space_claude_overrides" (
	"space_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"disabled" boolean DEFAULT true NOT NULL,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_claude_overrides_space_id_item_key_pk" PRIMARY KEY("space_id","item_key")
);
--> statement-breakpoint
ALTER TABLE "instance_claude_policy" ADD CONSTRAINT "instance_claude_policy_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_config_proposals" ADD CONSTRAINT "instance_config_proposals_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_config_proposals" ADD CONSTRAINT "instance_config_proposals_reviewer_user_id_user_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_config_versions" ADD CONSTRAINT "instance_config_versions_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_mcp_servers" ADD CONSTRAINT "instance_mcp_servers_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_mcp_servers" ADD CONSTRAINT "instance_mcp_servers_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_rules" ADD CONSTRAINT "instance_rules_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_rules" ADD CONSTRAINT "instance_rules_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_skill_files" ADD CONSTRAINT "instance_skill_files_skill_id_instance_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."instance_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_skills" ADD CONSTRAINT "instance_skills_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_skills" ADD CONSTRAINT "instance_skills_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_claude_config" ADD CONSTRAINT "session_claude_config_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_claude_config" ADD CONSTRAINT "session_claude_config_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_claude_overrides" ADD CONSTRAINT "space_claude_overrides_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_claude_overrides" ADD CONSTRAINT "space_claude_overrides_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "instance_config_proposals_status_idx" ON "instance_config_proposals" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "instance_config_proposals_author_idx" ON "instance_config_proposals" USING btree ("author_user_id","created_at");--> statement-breakpoint
CREATE INDEX "instance_config_versions_item_idx" ON "instance_config_versions" USING btree ("item_kind","item_id","version");--> statement-breakpoint
CREATE INDEX "instance_config_versions_created_idx" ON "instance_config_versions" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "instance_mcp_servers_name_idx" ON "instance_mcp_servers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "instance_rules_position_idx" ON "instance_rules" USING btree ("position");--> statement-breakpoint
CREATE UNIQUE INDEX "instance_skills_name_idx" ON "instance_skills" USING btree ("name");--> statement-breakpoint
-- Ligne unique de la politique (révision 0 : aucune règle, aucun réglage commun).
INSERT INTO "instance_claude_policy" ("id") VALUES ('instance') ON CONFLICT ("id") DO NOTHING;
