ALTER TABLE "projects" DROP CONSTRAINT "projects_slug_unique";--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_path_unique";--> statement-breakpoint
ALTER TABLE "integrations" DROP CONSTRAINT "integrations_kind_unique";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP CONSTRAINT "mcp_servers_name_unique";--> statement-breakpoint
ALTER TABLE "push_subscriptions" DROP CONSTRAINT "push_subscriptions_endpoint_unique";--> statement-breakpoint
DROP INDEX "projects_github_full_name_active_idx";--> statement-breakpoint
DROP INDEX "worktrees_path_active_idx";--> statement-breakpoint
ALTER TABLE "command_runs" ALTER COLUMN "environment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "space_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "environment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "worktrees" ALTER COLUMN "environment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "environment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ALTER COLUMN "space_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ALTER COLUMN "space_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "operations" ALTER COLUMN "environment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "command_runs" ADD CONSTRAINT "command_runs_project_env_fk" FOREIGN KEY ("project_id","environment_id") REFERENCES "public"."projects"("id","environment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_env_space_fk" FOREIGN KEY ("environment_id","space_id") REFERENCES "public"."environments"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_github_source_fk" FOREIGN KEY ("github_source_id","space_id") REFERENCES "public"."github_sources"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worktrees" ADD CONSTRAINT "worktrees_project_env_fk" FOREIGN KEY ("project_id","environment_id") REFERENCES "public"."projects"("id","environment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_env_fk" FOREIGN KEY ("project_id","environment_id") REFERENCES "public"."projects"("id","environment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_project_env_fk" FOREIGN KEY ("project_id","environment_id") REFERENCES "public"."projects"("id","environment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "command_runs_environment_status_idx" ON "command_runs" USING btree ("environment_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_environment_slug_idx" ON "projects" USING btree ("environment_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_environment_path_idx" ON "projects" USING btree ("environment_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_environment_repo_active_idx" ON "projects" USING btree ("environment_id","github_full_name") WHERE "projects"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "projects_space_status_idx" ON "projects" USING btree ("space_id","status");--> statement-breakpoint
CREATE INDEX "projects_environment_status_idx" ON "projects" USING btree ("environment_id","status");--> statement-breakpoint
CREATE INDEX "worktrees_environment_status_idx" ON "worktrees" USING btree ("environment_id","status");--> statement-breakpoint
CREATE INDEX "sessions_environment_status_idx" ON "sessions" USING btree ("environment_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_space_kind_idx" ON "integrations" USING btree ("space_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_space_name_idx" ON "mcp_servers" USING btree ("space_id","name");--> statement-breakpoint
CREATE INDEX "audit_log_space_idx" ON "audit_log" USING btree ("space_id","id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_user_id","id");--> statement-breakpoint
CREATE INDEX "audit_log_subject_idx" ON "audit_log" USING btree ("subject_user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_user_dedup_unread_idx" ON "notifications" USING btree ("user_id","dedup_key") WHERE "notifications"."read_at" is null and "notifications"."dedup_key" is not null;--> statement-breakpoint
CREATE INDEX "notifications_user_read_created_idx" ON "notifications" USING btree ("user_id","read_at","created_at");--> statement-breakpoint
CREATE INDEX "operations_environment_status_idx" ON "operations" USING btree ("environment_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_user_endpoint_idx" ON "push_subscriptions" USING btree ("user_id","endpoint");--> statement-breakpoint
CREATE UNIQUE INDEX "worktrees_path_active_idx" ON "worktrees" USING btree ("environment_id","path") WHERE "worktrees"."removed_at" is null;