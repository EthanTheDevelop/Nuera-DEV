# Nuera Dev

Espace de développement de Nuera Studio : retrouver, depuis n'importe quel appareil, les projets clonés sur **son
serveur** et les sessions **Claude Code** qui y travaillent — puis vérifier, committer, pousser et ouvrir les pull
requests sans changer d'outil. **Plusieurs comptes** travaillent en même temps, chacun dans son espace et sur son
serveur, sans jamais voir le travail des autres.

- **Comptes** : propriétaire, administrateurs, membres ; double authentification **obligatoire** pour tous ; comptes
  créés par invitation (lien unique), récupération par lien d'administrateur ou en ligne de commande.
- **Projets** : sources GitHub de l'espace (applications GitHub, accès limité aux dépôts choisis, plusieurs par
  espace), clonage sur le serveur, branches et worktrees, synchronisation, commandes du projet, `CLAUDE.md`, variables
  d'environnement chiffrées, serveurs MCP par projet.
- **Workspace** : une vraie session du CLI officiel Claude Code (tmux sur le serveur), lisible en *Conversation* ou en
  *Terminal brut*, autorisations traitées depuis le navigateur, fichiers, diff, commit, push et pull request.
- **Sessions** : sessions parallèles isolées dans leurs worktrees, reprise après interruption (`claude --resume`),
  historique filtrable.
- **Intégrations** (par espace) : GitHub, Figma (MCP), Coolify (développement uniquement), diagnostics automatiques.
- **Paramètres** : compte et sécurité, accès web révocables, journal personnel, réglages de l'espace, préférences,
  santé du serveur. **Administration** (propriétaire et administrateurs) : comptes, serveurs, instance, journal.

> Nuera Dev utilise le binaire officiel Claude Code, non modifié. Chaque personne connecte **elle-même** Claude Code
> sur **son** serveur, avec son propre abonnement, par la procédure d'Anthropic : une connexion n'est jamais partagée.
> Nuera Dev ne lit, ne stocke et ne relaie aucun identifiant Claude et n'appelle aucune API de chat.

---

## 1. État du projet — au 6 novembre 2026

**Résumé.** La version à propriétaire unique (phases 0 à 6) est terminée, poussée sur `main` (dernier commit
`974f493`) et **déployée** le 5 novembre 2026 sur NUERA-PERSO-01 (https://nuera-dev.perso.nuera.studio,
`docs/DEPLOY.md` fin de document). La **refonte multi-comptes** (jalon 7, référence `docs/MULTICOMPTE.md`) est
construite et relue lot par lot dans la copie de travail, puis durcie après trois audits de cloisonnement (lots X1 et
Y1–Y5 : push, verrous consultatifs et clés étrangères `0005`, socket tmux par serveur, adresse et rôles PostgreSQL des
serveurs, terminal de connexion MCP, flux global pendant une panne du runner). Vérification complète du 6 novembre :
`tsc` 0 erreur (4 paquets), oxlint 0 erreur, Vitest avec PostgreSQL exigé (shared 40, db 76, runner 106 + 1 ignoré
sous Windows, web 845), `next build` OK, Playwright à deux comptes et deux runners sur pile neuve : 186 réussis,
1 seul échec (Échap sous PTY Windows, mobile — connu, Windows seulement). La refonte est **committée sur `main` en
local, pas encore poussée** : le push redéploie la production et attend les actions du propriétaire du §4.0.

| # | Jalon | État | Détail |
|---|---|---|---|
| 0 | Découverte (Figma, recherches) | ✅ fait | §2.1 |
| 1 | Socle (monorepo, base, outillage) | ✅ fait | §2.2 |
| 2 | Fondations (design system, shell, composants, auth, runner, intégrations serveur) | ✅ fait, vérifié, poussé | §2.3–2.8 |
| 3 | Pages métier (6 domaines, bureau + mobile) + pile de test + terminal partagé | ✅ fait, vérifié, poussé | §3 |
| 4 | Les 5 parcours obligatoires de bout en bout + Playwright | ✅ fait (`apps/web/e2e/parcours-*.spec.ts`) | §4.2 |
| 5 | Revue globale (sécurité, fidélité Figma, boutons morts) et corrections | ✅ fait | §4.3 |
| 6 | Déploiement Coolify | ✅ images construites et essayées en local, version propriétaire unique déployée sur NUERA-PERSO-01 | §4.4 |
| 7 | Multi-comptes (espaces, serveurs, rôles, 2FA obligatoire, invitations, administration) | 🟡 construit, relu et durci (lots Y), Vitest vert par lot, e2e en cours, non committé | §2.10, §4.0 |

Suivi court : [docs/PROGRESS.md](docs/PROGRESS.md).

---

## 2. Ce qui est fait

### 2.1 Découverte (commit `88b530e`)

- Spécifications extraites de Figma (fichier `nlvRWAtD1x2fKf8gVgcM0g`, page « NUERA DEV — WEB APP ») :
  `docs/figma/*.md` — `overview.md` (principes, navigation, parcours A–D, carte des routes, paramètres d'URL),
  `screens-desktop-a.md` (shell + D01–D04), `screens-desktop-b.md` (D05–D08), `screens-mobile.md` (M01–M08),
  `states-flows.md` (A1–A4, D1–D2, T1–T8), `states-workspace.md` (W1–W7), `states-mobile-and-extensions.md`
  (S1–S5 + composants de la section 04), `design-system.md`, `workspace-survey.md`. L'administration et les écrans de
  comptes n'ont pas de maquette : ils sont construits avec les primitives existantes.
- Captures PNG, code de design brut et assets : `.design-refs/` (**non versionné** ; à régénérer avec le MCP Figma).
- Recherches : `docs/research/claude-code.md` (intégration conforme du CLI, hooks, autorisations, Remote Control,
  conditions d'usage), `docs/research/integrations.md` (GitHub App, Coolify, Figma, MCP), `docs/research/stack.md`.
- Architecture : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ; multi-comptes : [docs/MULTICOMPTE.md](docs/MULTICOMPTE.md).

### 2.2 Socle (commits `75ef1e3`, `44da00f`)

- Monorepo pnpm 9 : `apps/web` (Next.js 16.4, React 19.3, Tailwind 4.3, TypeScript 6.0 strict), `apps/runner`
  (Fastify 5), `packages/db` (Drizzle 0.45 + postgres.js), `packages/shared` (Zod 4, formatage fr-FR).
- PostgreSQL 17 local sans Docker (`embedded-postgres`, port 54329, données dans `.data/pg`) : `pnpm db:local`.
- Scripts : `scripts/setup-env.mjs` (`.env` avec secrets aléatoires), `scripts/create-db.mjs` (créer / `--reset`
  une base), `scripts/dev-db.mjs`. Lint : **oxlint 1.91** (`.oxlintrc.json`).
- `.env.example` documente les variables (obligatoires, optionnelles, réservées aux tests).

### 2.3 Base de données

- Schéma `packages/db/src/schema/` : `auth.ts` (Better Auth 1.7.17 + rôle, désactivation, suppression), `tenancy.ts`
  (espaces, membres, serveurs, invitations, réglages d'espace, préférences), `github.ts` (sources GitHub),
  `projects.ts`, `sessions.ts`, `integrations.ts`, `app.ts` — **30 tables**, statuts en `text` typés (`types.ts`).
- Migrations : `0000_material_hiroim.sql` (version déployée, **jamais modifiée ni régénérée**), puis
  `0001_tenancy_expand`, `0002_tenancy_backfill`, `0003_tenancy_enforce`, `0004_runner_roles` (rôle `nuera_runner`,
  RLS), `0005_runner_scope` (clés étrangères composites vers worktrees et sessions, verrous consultatifs retirés à
  `PUBLIC`, bail par `nuera_runner_try_lease()`). Une base existante est montée de version sans intervention (test de montée de version sur base remplie).
- CLI de secours `packages/db/src/cli` : `migrate`, `recovery-link`.

### 2.4 Paquet partagé

- `@nuera/shared/runner` : schémas Zod et types des routes du runner (`RUNNER_ROUTES`), **contrat v2**, raisons
  d'erreur, `uptimeServiceKey()`. `@nuera/shared/events` : événements SSE (dont `stream.hello`, `stream.reset`,
  `notification.created`). `@nuera/shared/paths`, `@nuera/shared/format`, `@nuera/shared/env` (variables interdites),
  `@nuera/shared/tokens` (jetons `nrt_`, empreintes).

### 2.5 Web — serveur, authentification, API

- Socle serveur `apps/web/src/server/` : `http.ts` (`apiRoute({ auth: 'space' | 'user' | 'admin' | false })` = session
  + contexte + Origin + Zod + erreurs JSON ; `internalRoute` = jeton du serveur appelant), `tenancy/` (contexte de
  requête, gardes de portée), `security/` (chiffrement lié à la ligne, audit, Origin, limites de débit, IP, garde
  SSRF, jetons des runners), `settings.ts` (réglages par portée), `admin/` (console d'administration).
- Authentification (Better Auth 1.7.17) : propriétaire créé par `/configuration` (`SETUP_TOKEN`), autres comptes par
  `/invitation/[jeton]`, récupération par `/recuperation/[jeton]` ; TOTP obligatoire pour tous, 8 codes de secours,
  clés d'accès ; expiration d'inactivité et absolue ; audit. Détail : [docs/SECURITY.md](docs/SECURITY.md).
- Client typé du runner **par serveur** `server/runner/` + relais SSE `/api/stream/*` (portée vérifiée avant le
  relais, canal web par compte) + terminaux `/api/terminals/**`.
- Intégrations par espace (`server/github`, `coolify`, `mcp`, `integrations`), routes internes `/api/internal/*`,
  notifications par destinataire + Web Push, planificateur web. Détail : [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

### 2.6 Web — interface

- Jetons de design (`src/styles/tokens.css`, `components.css`), thème clair / sombre / système (par compte),
  67 icônes, logo ; primitives `src/components/ui/` ; shell `src/components/shell/` (barre latérale, rail, barre
  d'onglets, palette ⌘K, cloche, T5, T6, W7, « Aucun serveur attribué », groupe « INSTANCE ») ; composites
  `src/components/dev/`. Inventaires : [apps/web/src/components/README.md](apps/web/src/components/README.md) et
  [apps/web/src/components/dev/README.md](apps/web/src/components/dev/README.md). Galeries `/kit` et
  `/kit/composites` (404 en production).
- Pages : Accueil (avec « Premiers pas »), Projets, Sessions, Workspace, Intégrations, Paramètres, Administration
  (`/administration?onglet=comptes|serveurs|instance|journal`), pages d'authentification, d'invitation et de
  récupération.

### 2.7 Runner

- `apps/runner` — seul composant qui touche au disque, à Git, aux PTY et aux processus ; **un runner par serveur**,
  identifié par l'empreinte de son jeton, avec attente, bail exclusif, marqueurs de dossiers et cloisonnement de chaque
  requête ; détail complet dans [apps/runner/README.md](apps/runner/README.md).
- Git (clone, fetch/pull, branches, worktrees, diff, commit, push protégé, `GIT_CONFIG_UNSAFE`, `core.autocrlf=false`),
  sessions Claude (tmux en Linux, PTY direct sous Windows, hooks officiels, autorisations bornées, reprise, status
  line, MCP par session), processus du projet, terminaux, métriques, disponibilité, battement du serveur.

### 2.8 Déploiement

- `deploy/docker/web.Dockerfile` (cibles `runtime` et `migrate`), `runner.Dockerfile`, `runner-entrypoint.sh`
  (installe le CLI officiel dans le HOME persistant ; substitue `RUNNER_DATABASE_URL`), `deploy/docker-compose.yml`
  (ressource principale : `migrate`, `web`, `runner`), `deploy/docker-compose.runner.yml` (serveur supplémentaire),
  `docker-compose.test.yml`, scripts de sauvegarde, restauration, essai et fumée.
- Images construites et essayées localement (version propriétaire unique), déployées sur NUERA-PERSO-01. Les fichiers
  multi-comptes (point d'entrée, compose du serveur supplémentaire) n'ont pas encore été construits (aucun Docker sur
  le poste de préparation). Procédure : [docs/DEPLOY.md](docs/DEPLOY.md).

### 2.9 Vérifications de la version propriétaire unique (fin de phase 5)

`tsc` 0 erreur sur les 4 paquets ; oxlint 0 erreur ; Vitest et Playwright verts (parcours 1 à 5, bureau + mobile) ;
`next build` OK ; captures comparées aux exports Figma à 1440 et 390 px ; essai Docker local (§10 de DEPLOY).

### 2.10 Multi-comptes (jalon 7, copie de travail)

Réalisé par lots parallèles à propriété de fichiers stricte, chaque lot construit puis relu indépendamment ; écarts de
chaque lot à la référence : `docs/MULTICOMPTE.md` §14.

| Lot | Contenu |
|---|---|
| D0 | `migrate` enregistre l'empreinte de `RUNNER_TOKEN` ; point d'entrée du runner (`RUNNER_DATABASE_URL`) ; `docker-compose.runner.yml` ; DEPLOY §12–14 |
| F1 | Schéma (espaces, serveurs, invitations, réglages d'espace, préférences, sources GitHub), migrations 0001–0004 (RLS), montée de version, CLI `recovery-link`, contrats partagés |
| C1 | Runner par serveur : identité, attente, bail, marqueurs, cloisonnement, rôle restreint, battement, identité Git, `CLAUDE_CONFIG_DIR` |
| C2a | Contexte de requête, gardes de portée, runner par serveur, routes internes par jeton, flux namespacés |
| C2b | Réglages par portée, notifications par destinataire, push par compte, journaux personnel et d'instance, chiffrement lié à la ligne |
| W1 | Projets par espace et par serveur, sélecteur de source GitHub, « Premiers pas » |
| W2 | Sessions, Workspace, terminaux par serveur ; identité Git du compte |
| W3 | Plusieurs sources GitHub par espace, Coolify et MCP par espace, garde SSRF, planificateur web, rechiffrement |
| W4 | Comptes, invitations, récupération, console d'administration (comptes, serveurs, instance, journal) |
| W5 | Paramètres par portée, shell (rôle, « Aucun serveur attribué », T5), push et garde d'identité multi-onglets |
| W6 | Playwright à deux comptes et deux runners (`docs/TESTING.md`) — **en cours** |
| X1 | Reliquats du runner et de la rotation : battement hors planificateur, relecture fatale, sonde d'identifiant de session, `ENVIRONMENT_STARTING`, promotion du jeton au premier usage |
| X4 | Documentation (ce README, `CLAUDE.md`, `docs/*`, inventaires) |
| Y1 | Push : renouvellement limité au compte connecté, services push seulement (`NUERA_PUSH_HOSTS`), sans redirection, abonnement lié à son accès web |
| Y2 | Migration `0005_runner_scope`, bail restreint par fonction, socket tmux par serveur et rattachement vérifié |
| Y3 | Administration des serveurs : adresse protégée (jeton renouvelé, propriétaire + mot de passe pour un autre compte), une adresse par serveur, `CONNECTION LIMIT` et délais des rôles, fermeture des connexions, « restreint » vérifié par PostgreSQL |
| Y4 | Terminal de connexion MCP réservé au propriétaire sur un serveur actif ; route `/api/internal/integrations/check` supprimée |
| Y5 | Flux global maintenu pendant une panne du runner (`runner.unavailable` / `runner.available`) ; retour à la garde de notification après déconnexion |
| Y6 | Documentation des lots X1 et Y1–Y5 |

Vérifié le 6 novembre 2026, avant les lots Y : `tsc --noEmit` 0 erreur sur les 4 paquets ; Vitest avec
`NUERA_REQUIRE_PG=1` : shared 40, db 72, runner 100 (+1 ignoré : tmux sous Windows), web 787. Après les lots Y (suites
de chaque lot seulement) : db 76, runner (unit, restricted, environments, lease-compat, sessions, http, maintenance)
verts, web admin 23, push 27, intégrations et MCP 65, temps réel et déconnexion 117 ; `tsc` 0 erreur sur
`@nuera/db` et `@nuera/runner`, une sur `@nuera/web` (§4.0, point 1). Décompte complet à refaire. Non vérifié : e2e
complet (W6 en cours), `next build` de la refonte, images Docker multi-comptes, backend tmux (Linux, dont le refus
d'une session tmux lancée pour une autre ligne), chemin sans superutilisateur de `0005`.

---

## 3. Phase 3 — pages métier (faite)

Réalisée par un workflow multi-agents ([docs/reprise/phase3-domaines.workflow.js](docs/reprise/phase3-domaines.workflow.js)) :
chaque lot construit puis relu indépendamment, intégré lot par lot sur `main`. Pile de test `apps/web/e2e/harness/`
([docs/TESTING.md](docs/TESTING.md)), terminal partagé, Accueil, Sessions, Projets, Workspace, Intégrations, Paramètres
(bureau + téléphone).

---

## 4. Ce qui reste à faire (précis)

### 4.0 Multi-comptes — pour terminer le jalon 7

1. ✅ Raccords finaux, vérification complète et campagne Playwright (6 novembre, §1). Seul échec restant : Échap
   sous PTY Windows (`workspace.spec.ts` W2, mobile), propre au poste Windows.
2. ✅ Committé sur `main` en local par domaine (base, contrats, runner, cœur web, comptes, intégrations, domaines,
   réglages, e2e, déploiement, docs). **Pas encore poussé** : le push déclenche le déploiement (point 4).
3. **Linux avant la mise en production** : suite tmux du runner (`apps/runner/test/tmux.test.ts`), images
   multi-comptes, essai du compose du serveur supplémentaire (`docs/DEPLOY.md` §11).
4. **Mise à jour de production** : `docs/DEPLOY.md` §12 (2FA du propriétaire, sauvegarde, aucune session, push), les
   contrôles du §12.6 (`0005` appliquée en superutilisateur, droit de fermer les connexions des rôles restreints),
   puis §14 (restreindre la base du serveur par défaut) **avant** toute invitation, puis §13 pour chaque autre
   personne (serveurs supplémentaires toujours redéployés avec la ressource principale).

Suivis connus (non bloquants, à traiter après la mise en route ; relevés par les relecteurs des lots, ceux des lots Y
revérifiés dans le code le 6 novembre ; revérifier les autres avant de s'y attaquer) :

- **Web** : variables de projet et MCP à l'ancien format chiffré rechiffrées seulement à la réécriture ;
  `applySettingsPatch` refuse une clé d'instance inchangée envoyée par un membre (aucun formulaire ne le fait
  aujourd'hui) ; renommage d'une source GitHub sans contrôle dans l'interface ; aucun bandeau de projet quand sa
  source GitHub est retirée ; projets et sessions d'un serveur retiré : listes « non vérifié », terminal injoignable,
  boîtes de dialogue qui nomment le serveur actuel de l'espace ; un délai du runner (`UPSTREAM`) fait encore échouer
  toute la liste des sessions actives ; ligne « Auteur : … » du commit non affichée ; sonde de `useSessionStream`
  après 3 échecs non construite ; « Nouvelle session » de la palette encore proposée sans serveur ; alertes du jeton
  de secours GitHub non résolues à l'ajout d'une source ; `listWebSessions` ne supprime pas aussitôt les abonnements
  push des accès expirés (l'envoi et les lectures les écartent déjà) ; le client push ne signale pas un abonnement
  que le navigateur garde et que le serveur a retiré ; un simple administrateur voit le champ d'adresse du serveur
  d'un autre compte (refus 403 à l'enregistrement) ; `requireLoginTerminalServer` (`claude-login`, `claude-status`)
  ne refuse pas un serveur suspendu ; commentaire de `server/terminals/index.ts` (l. 38-39) qui dit que
  `startMcpLogin` emploie `requireLoginTerminalServer` ; jointures `worktrees` ↔ `sessions` sans condition de serveur
  (défense en profondeur, déjà garantie par les clés étrangères de `0005`).
- **Sécurité (suites, `docs/SECURITY.md` §11)** : état « à vérifier » d'un serveur dont l'adresse a changé (colonne
  `token_unverified_at` dans une migration après `0005`) ; renouvellement du jeton du serveur d'un autre compte
  réservé au propriétaire de l'instance ; plafond et délais à appliquer aux rôles `nuera_env_…` créés avant le lot Y3
  (aucun en production) ; flux global qui ne revérifie pas l'accès (événement de révocation sur le bus du compte) ;
  nettoyage des abonnements push sans accès lié (`auth_session_id` nul).
- **Runner** : republie encore `notification.created` (ignoré par le navigateur) ; connexions PostgreSQL nommées sans
  l'id du serveur (`nuera-runner:<id>` attendu par le web) ; `NUERA_DB_POOL_MAX` accepte 50 alors que le rôle est
  plafonné à `NUERA_RUNNER_DB_CONNECTION_LIMIT` (20 par défaut) ; `pg_advisory_lock` bloquant de `migrate` sans
  délai (sans risque une fois `0005` appliquée en superutilisateur).
- **Exploitation** : commentaires de `hooks/useTheme.ts` et `lib/theme.ts` qui citent encore `app_settings.theme` ;
  `backup-db.sh` / `restore-db.sh` en `--no-privileges` (droits de `0004` et `0005` à rejouer après une restauration,
  `docs/DEPLOY.md` §9).
- **Hors v1 (par choix)** : espaces partagés, sélecteur de comptes (un compte par profil de navigateur), transfert de
  propriété, désattribution d'un serveur, plusieurs répliques du web.

Risques résiduels acceptés : [docs/SECURITY.md](docs/SECURITY.md) §11.

### 4.1 Suivis hérités des phases 2 et 3

Plusieurs ont été traités en phase 5 (commits `4a1c158`, `e401070`, `4cfc2a6`, `96e32c6`, `8782eb0`…) : **revérifier
dans le code** avant de reprendre un point.

- Runner : persister `command_runs.details` ; adoption d'un clone existant (A4) ; mises à jour du CLI / du système
  (D08 « Mise à jour système ») ; copie S5 et lien `#demande-<id>` des notifications d'autorisation ; politique de
  redémarrage (D01) ; renommer une session CLI vivante ; `sessions.claude_session_id` ; `GitService.changes()` lent sur
  un gros arbre ; charges de hook > 1 Mio ignorées.
- Web : archivage/renommage sans événement `session.status` ; « Reprendre » d'une session terminée ; `mcp_servers.config`
  (en-têtes non secrets, outils refusés) ; pas de route de pièce jointe (trombone masqué).
- Copie à arbitrer : « Coolify ne répond plus » vs « Coolify refuse le jeton », ligne « Expiration » de D07,
  « .mcp.json de chaque projet » (D1).
- Non couvert par les tests : cérémonies de clés d'accès, « approuver cet appareil 30 jours », backend tmux, flux
  GitHub, MCP et Claude contre les vrais services.

### 4.2 Phase 4 — les 5 parcours obligatoires (faits)

`apps/web/e2e/parcours-1…5` : GitHub → dépôt → clone → projet → Workspace ; branche / worktree → session →
instruction → autorisation → résultat ; diff → tests → commit → push → PR ; navigateur fermé → reprise au téléphone ;
MCP / secret → diagnostic.

### 4.3 Phase 5 — revue globale (faite)

Sécurité, fidélité Figma à 1440 et 390 px, boutons morts, copie française, accessibilité, avertissements oxlint.

### 4.4 Phase 6 — déploiement

Fait pour la version propriétaire unique (NUERA-PERSO-01). Reste à vérifier sur le serveur réel avec le vrai CLI : les
hooks acceptés via `--settings`, décision `PermissionRequest` avec `updatedPermissions`, collage entre crochets et
Échap à travers tmux, `--session-id` + `--name` + `--remote-control`, `claude auth status --json`, bac à sable
(bubblewrap / seccomp) ; essais ouverts S3, S4, S7, S8, S10 de `docs/research/integrations.md` §8.

### 4.5 Actions du propriétaire (bloquants externes — ne jamais contourner)

Récapitulatif complet : `docs/DEPLOY.md` §15.

- Avant la mise à jour multi-comptes : activer sa 2FA si `NUERA_REQUIRE_2FA=false` l'avait laissée de côté,
  sauvegarder la base, arrêter les sessions ; après : retirer `NUERA_REQUIRE_2FA` de Coolify et faire les contrôles de
  `docs/DEPLOY.md` §12.6 (verrous consultatifs retirés, `pg_signal_backend` si `DATABASE_URL` n'est pas
  superutilisateur).
- Fixer `APP_URL` (domaine `dev.nuera.studio`) et restreindre l'accès du serveur par défaut à la base **avant**
  d'inviter quiconque.
- Créer la ou les applications GitHub (Intégrations → « Connecter GitHub », flux *manifest*) et les installer.
- Se connecter à Claude Max sur son serveur dans le terminal de Nuera Dev (`claude auth login`) ; chaque autre
  personne fait de même sur **son** serveur.
- Pour chaque autre personne : une ressource Coolify de serveur supplémentaire (DEPLOY §13) et une invitation.
- Jeton Coolify limité (lecture), clés VAPID.

---

## 5. Reprise par un autre Claude — instructions exactes

### 5.1 Lire, dans cet ordre

1. [docs/reprise/BRIEF-ORIGINAL.md](docs/reprise/BRIEF-ORIGINAL.md) — le brief complet du propriétaire, **verbatim**.
2. `CLAUDE.md` (chargé automatiquement) — règles absolues (multi-comptes compris) + « Leçons et pièges confirmés ».
3. [docs/MULTICOMPTE.md](docs/MULTICOMPTE.md) (référence, §14 « Écarts »), puis ce README (§1 et §4.0),
   [docs/PROGRESS.md](docs/PROGRESS.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/SECURITY.md](docs/SECURITY.md).
4. Les inventaires avant d'écrire du code : `apps/web/src/components/README.md`, `apps/web/src/components/dev/README.md`,
   `apps/web/src/features/{sessions,workspace}/README.md`, `apps/runner/README.md`, `docs/INTEGRATIONS.md`,
   `docs/TESTING.md`.
5. Les spécifications Figma du domaine traité (`docs/figma/*.md`) et ses captures `.design-refs/screens/`.

### 5.2 Contraintes à ne jamais enfreindre (extraites du brief)

- Claude Max avec le CLI officiel uniquement, en session interactive : jamais `claude -p`, `stream-json`, Agent SDK
  `query()`, `setup-token`, `CLAUDE_CODE_OAUTH_TOKEN` ; ne jamais intercepter, extraire, réutiliser ni faire transiter
  les jetons OAuth de Claude ; ne jamais lire `~/.claude/.credentials.json`. Une connexion Claude par serveur et par
  personne, jamais partagée.
- Aucune donnée métier codée en dur, aucun faux succès, aucun bouton mort ; fixtures uniquement dans les tests.
- Cloisonnement : un identifiant d'un autre espace = la réponse exacte d'un inconnu ; l'espace vient du contexte.
- Le web n'est pas un shell privilégié ; pas d'accès root ni de socket Docker pour le conteneur web ; ne jamais
  exposer un runner ni un shell sur Internet.
- **Commits, descriptions de PR et notes de livraison : aucune mention d'IA, de Claude, d'agent ou d'outil de
  génération, aucun « Generated with », aucun trailer `Co-authored-by`.** Identité Git existante : Ethan Ngo
  `<ethan.ngo@viacesi.fr>`. Messages conventionnels sobres en français.
- Ne jamais déployer ni modifier un serveur sans accès et autorisation ; ne jamais prétendre avoir testé la production.
- Copie UI identique à Figma, apostrophe **droite** `'` (décision prise : la page NUERA DEV n'emploie jamais `’`).

### 5.3 Environnement de ce poste (Windows 11, 12 threads, 32 Go)

- Poste **très lent** en E/S et au démarrage des processus : commandes longues en arrière-plan, délais larges, une
  seule instance `next dev` par tâche avec son propre `NEXT_DIST_DIR` et son port.
- PostgreSQL local : `pnpm db:local` doit tourner (une seule instance pour tous, ne jamais la relancer en parallèle)
  avant tout test ou serveur. Base de dev : `nuera_dev` (`nuera`/`nuera`, port 54329). Les lots parallèles prennent
  leurs propres bases (préfixe du lot, `NUERA_DB_TEST_PREFIX`) et leurs ports ; après une base de dev recréée,
  supprimer les marqueurs `.nuera-environment` du runner.
- Ports réservés à l'orchestrateur : 3000 (web), 4100/4101 (runner par défaut), 4110/4111 (second runner de dev,
  `apps/runner/README.md`).
- Durées observées : typecheck web ~1–2 min, Vitest web ~1–3 min, runner ~1–10 min, `next build` ~35 s, oxlint 0,5 s.
- Commandes de vérification complètes :
  ```bash
  for p in packages/shared packages/db apps/runner apps/web; do node node_modules/typescript/bin/tsc --noEmit -p $p/tsconfig.json; done
  ./node_modules/.bin/oxlint
  export NUERA_REQUIRE_PG=1   # PostgreSQL exigé : sinon les suites base de données sont ignorées en silence
  pnpm --filter @nuera/shared test; pnpm --filter @nuera/db test; pnpm --filter @nuera/web test; pnpm --filter @nuera/runner test
  NEXT_DIST_DIR=.next-build pnpm --filter @nuera/web exec next build
  E2E_STACK=<pile> pnpm --filter @nuera/web e2e [spec]   # Playwright sur la pile de test (docs/TESTING.md)
  ```

### 5.4 Reprendre le jalon 7

1. Vérifier l'état réel : `git status`, `git log --oneline -5`. Tant que la refonte n'est pas committée, toute la
   copie de travail en fait partie : ne rien réinitialiser.
2. Suivre le §4.0 dans l'ordre. Les rapports des lots ont servi à écrire `docs/MULTICOMPTE.md` §14 et le §4.0 de ce
   README, qui sont la trace durable (les journaux des workflows étaient temporaires).
3. Conteneur Linux lancé en root : `embedded-postgres` refuse root → `mkdir -p .data/pg && chown postgres:postgres
   .data/pg` avant `pnpm db:local`.
4. Organisation qui a fonctionné : une copie de travail partagée, propriété stricte des fichiers par lot, contrats
   d'abord, aucun agent ne committe ni n'installe de dépendance, un relecteur indépendant par lot, rapports structurés
   (`files_changed`, `deviations`, `followups`, `known_gaps`, `proposed_commits`).

### 5.5 Intégrer un lot terminé (procédure suivie jusqu'ici)

1. Lire les rapports de chaque lot : `deviations` (→ `docs/MULTICOMPTE.md` §14), `followups`, `known_gaps`.
2. Corriger les incohérences entre lots. Schéma : modifier `packages/db/src/schema`, puis `pnpm db:generate` pour
   une **nouvelle** migration (`0000` à `0005` sont écrites pour la production : ne jamais les modifier ni les
   régénérer ; la suivante est `0006`) ; toute table ou colonne écrite par le runner reçoit ses `GRANT` et sa
   politique RLS dans la même migration.
3. Lancer toutes les vérifications du §5.3 ; tout doit être vert.
4. Contrôle avant commit : pas de secret (`ghp_`, `github_pat_`, `nrt_`, `PRIVATE KEY`…), aucune mention d'IA dans les
   messages, pas de fichier généré (`apps/web/AGENTS.md`, `.next-*`, captures, `.env.runner-b`).
5. Committer **lot par lot** avec un script qui s'arrête si `git add` échoue : pour chaque lot
   `git add -A -- <chemins> || exit 1` puis `git commit -m "<message>"`.
6. Avant de pousser sur `main` (qui redéploie la production) : sauvegarde de la base, aucune session en cours, suites
   vertes (`docs/DEPLOY.md` §8) ; `GCM_INTERACTIVE=never GIT_TERMINAL_PROMPT=0 git push origin main` ; mettre à jour
   `docs/PROGRESS.md` et ce README.

### 5.6 Décisions déjà prises (ne pas les rediscuter)

Sessions dans tmux (PTY direct sous Windows) avec `--session-id` = identifiant Nuera ; conversation reconstruite par
les hooks officiels + lecture tolérante du journal, Terminal brut comme référence ; autorisations par le hook
`PermissionRequest` à attente bornée, jamais d'auto-approbation ; SSE plutôt que WebSocket ; GitHub App par
*manifest* avec jetons réduits ; MCP par session avec `--strict-mcp-config` et `headersHelper` ; bouton Accent pour
les actions destructives ; oxlint ; TypeScript 6.0.x ; apostrophe droite. Multi-comptes : un serveur = un espace = une
personne = une connexion Claude ; 2FA obligatoire ; inscription fermée, invitations ; rôle PostgreSQL restreint + RLS
pour les runners ; horloge des intégrations dans le web ; un seul conteneur web. Détail :
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §14 et [docs/MULTICOMPTE.md](docs/MULTICOMPTE.md).

---

## 6. Démarrage local

Prérequis : Node.js ≥ 22.12 (testé sous 24), pnpm 9, Git. Docker n'est pas nécessaire.

```bash
pnpm install
pnpm setup:env          # crée .env avec des secrets aléatoires (affiche le jeton de configuration initiale)
pnpm db:local           # PostgreSQL 17 local (laisser tourner dans un terminal)
pnpm db:migrate         # applique les migrations (et l'empreinte de RUNNER_TOKEN du serveur par défaut)
pnpm dev                # web http://localhost:3000 + runner http://127.0.0.1:4100
```

Puis ouvrir `http://localhost:3000/configuration` (toujours `localhost`, pas `127.0.0.1` : sinon la page ne s'hydrate
pas en dev), saisir le jeton de configuration, créer le compte propriétaire et activer la double authentification.

- **Second compte** : Administration › Comptes › inviter, puis ouvrir le lien affiché dans un **autre profil** de
  navigateur (ou une fenêtre privée) : un compte par profil.
- **Second serveur** : Administration › Serveurs › ajouter (`http://127.0.0.1:4110`), copier le jeton dans
  `.env.runner-b`, lancer le second runner (`apps/runner/README.md` § « Plusieurs runners sur un poste Windows »),
  « Vérifier », puis l'attribuer (ou le pré-attribuer à l'invitation).
- **Lien de secours** : `pnpm --filter @nuera/db cli recovery-link --email <e-mail>`.

Sous Windows (sans tmux), le runner utilise des PTY directs : les sessions survivent à la fermeture du navigateur mais
pas à un redémarrage du runner (elles sont alors reprises via `claude --resume`). En production (Linux), tmux conserve
les sessions indépendamment du runner.

| Commande | Rôle |
|---|---|
| `pnpm dev` | web + runner en développement |
| `pnpm typecheck` / `pnpm lint` / `NUERA_REQUIRE_PG=1 pnpm test` | vérifications |
| `pnpm e2e` | parcours Playwright (bureau et téléphone, deux comptes et deux runners) |
| `pnpm db:generate` / `pnpm db:migrate` | migrations Drizzle |
| `pnpm build` | builds de production |

## 7. Documentation

[docs/MULTICOMPTE.md](docs/MULTICOMPTE.md) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
[docs/SECURITY.md](docs/SECURITY.md) · [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) · [docs/DEPLOY.md](docs/DEPLOY.md) ·
[docs/TESTING.md](docs/TESTING.md) · [docs/PROGRESS.md](docs/PROGRESS.md) · [apps/runner/README.md](apps/runner/README.md) ·
[docs/reprise/](docs/reprise/) (brief d'origine, scripts des phases 3 à 6).
