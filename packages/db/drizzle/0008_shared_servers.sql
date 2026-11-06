SET LOCAL lock_timeout = '10s';--> statement-breakpoint
-- Serveurs partagés (lot P1) : un serveur (une instance du runner) peut travailler pour plusieurs
-- comptes. Chaque compte garde son espace, ses projets, ses sessions et SA PROPRE connexion Claude
-- Code (le runner donne à chaque espace un dossier de configuration du CLI distinct). La colonne
-- environments.space_id reste le premier compte du serveur (« compte principal ») et a toujours sa
-- ligne ici.
CREATE TABLE "environment_spaces" (
	"environment_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environment_spaces_pkey" PRIMARY KEY("environment_id","space_id")
);
--> statement-breakpoint
ALTER TABLE "environment_spaces" ADD CONSTRAINT "environment_spaces_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_spaces" ADD CONSTRAINT "environment_spaces_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_spaces" ADD CONSTRAINT "environment_spaces_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "environment_spaces_space_idx" ON "environment_spaces" USING btree ("space_id");--> statement-breakpoint
-- Reprise de l'existant : le compte de chaque serveur attribué, puis (par sécurité) tout couple
-- serveur/espace déjà porté par un projet.
INSERT INTO "environment_spaces" ("environment_id", "space_id", "created_at")
SELECT e."id", e."space_id", e."created_at" FROM "environments" AS e WHERE e."space_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "environment_spaces" ("environment_id", "space_id")
SELECT DISTINCT p."environment_id", p."space_id" FROM "projects" AS p
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Le compte principal d'un serveur a toujours sa ligne : chaque attribution (environments.space_id)
-- l'écrit d'office, quel que soit le chemin (administration, invitation, configuration initiale).
CREATE FUNCTION "public"."nuera_environment_space_link"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  -- Comme l'ancienne clé étrangère projects (environment_id, space_id) → environments : le compte
  -- principal d'un serveur qui héberge ses projets n'est jamais remplacé (on retire le serveur).
  IF TG_OP = 'UPDATE' AND OLD."space_id" IS NOT NULL AND NEW."space_id" IS DISTINCT FROM OLD."space_id"
     AND EXISTS (SELECT 1 FROM "public"."projects" AS p WHERE p."environment_id" = OLD."id" AND p."space_id" = OLD."space_id") THEN
    RAISE EXCEPTION 'projects_env_space_fk : le serveur % héberge les projets de son compte principal', OLD."id"
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'projects_env_space_fk';
  END IF;
  IF NEW."space_id" IS NOT NULL THEN
    INSERT INTO "public"."environment_spaces" ("environment_id", "space_id")
    VALUES (NEW."id", NEW."space_id") ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."nuera_environment_space_link"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "environments_space_link" AFTER INSERT OR UPDATE OF "space_id" ON "environments"
FOR EACH ROW EXECUTE FUNCTION "public"."nuera_environment_space_link"();--> statement-breakpoint
-- Un projet vit sur un serveur qui travaille pour son espace (et non plus « le » serveur de l'espace).
ALTER TABLE "projects" DROP CONSTRAINT "projects_env_space_fk";--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_env_space_fk" FOREIGN KEY ("environment_id","space_id") REFERENCES "public"."environment_spaces"("environment_id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Deux comptes d'un même serveur peuvent suivre le même dépôt (dossiers distincts sur le disque ;
-- slug et chemin restent uniques par serveur).
DROP INDEX "projects_environment_repo_active_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "projects_environment_repo_active_idx" ON "projects" USING btree ("environment_id","space_id","github_full_name") WHERE "projects"."archived_at" is null;--> statement-breakpoint
-- Rôle restreint du runner (0004) : lecture seule des comptes de SON serveur (dossier de
-- configuration Claude par compte, espace des projets). Jamais INSERT/UPDATE/DELETE : seul le web
-- attribue un serveur.
GRANT SELECT ON "environment_spaces" TO "nuera_runner";--> statement-breakpoint
ALTER TABLE "environment_spaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "nuera_runner_scope" ON "environment_spaces" AS PERMISSIVE FOR SELECT TO "nuera_runner"
USING ("environment_id" = (SELECT "public"."nuera_runner_environment_id"()));--> statement-breakpoint
-- Réglages d'espace lisibles par le runner : ceux de chaque compte de son serveur (et non plus du
-- seul compte principal).
DROP POLICY "nuera_runner_scope" ON "space_settings";--> statement-breakpoint
CREATE POLICY "nuera_runner_scope" ON "space_settings" AS PERMISSIVE FOR SELECT TO "nuera_runner"
USING (
  EXISTS (
    SELECT 1 FROM "public"."environment_spaces" AS l
    WHERE l."space_id" = "space_settings"."space_id"
      AND l."environment_id" = (SELECT "public"."nuera_runner_environment_id"())
  )
);
