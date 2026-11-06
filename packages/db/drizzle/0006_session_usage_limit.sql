SET LOCAL lock_timeout = '10s';--> statement-breakpoint
-- « Reprise automatique après la limite d'utilisation » : réglage par défaut de l'espace et
-- instruction tapée à la reprise (lus par le web ; le runner lit déjà space_settings de son espace).
ALTER TABLE "space_settings" ADD COLUMN "auto_resume_after_limit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "space_settings" ADD COLUMN "auto_resume_instruction" text;--> statement-breakpoint
-- Limite d'utilisation atteinte par une session et calendrier de sa reprise (écrits par le runner),
-- choix propre à la session (écrit par le web ; null = défaut de l'espace).
ALTER TABLE "sessions" ADD COLUMN "usage_limit" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "auto_resume" boolean;--> statement-breakpoint
-- Le rôle restreint met à jour les sessions colonne par colonne (0004) : chaque nouvelle colonne
-- reçoit son droit ; la politique RLS de « sessions » (par serveur) s'applique déjà.
GRANT UPDATE ("usage_limit", "auto_resume") ON "sessions" TO "nuera_runner";
