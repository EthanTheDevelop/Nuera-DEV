# Nuera Dev

Espace de développement personnel de Nuera Studio : retrouver, depuis n'importe quel appareil, les projets clonés sur
**VPS-3** et les sessions **Claude Code** qui y travaillent — puis vérifier, committer, pousser et ouvrir les pull
requests sans changer d'outil.

- **Projets** : application GitHub (accès limité aux dépôts choisis), clonage sur VPS-3, branches et worktrees,
  synchronisation, commandes du projet, `CLAUDE.md`, variables d'environnement chiffrées, serveurs MCP par projet.
- **Workspace** : une vraie session du CLI officiel Claude Code (tmux sur VPS-3), lisible en *Conversation* ou en
  *Terminal brut*, autorisations traitées depuis le navigateur, fichiers, diff, commit, push et pull request.
- **Sessions** : sessions parallèles isolées dans leurs worktrees, reprise après interruption (`claude --resume`),
  historique filtrable.
- **Intégrations** : GitHub, Figma (MCP), Coolify (développement uniquement), diagnostics automatiques.
- **Paramètres** : double authentification obligatoire, accès web révocables, journal de sécurité, santé du serveur.

> Nuera Dev utilise le binaire officiel Claude Code, non modifié, connecté par son propriétaire via la procédure
> d'Anthropic. Il ne lit, ne stocke et ne relaie aucun identifiant Claude et n'appelle aucune API de chat.

---

## 1. État du projet — au 5 novembre 2026

**Résumé : environ 75 % du projet.** La mécanique (base, authentification, design system, shell, composants,
moteur d'exécution, intégrations côté serveur) et les **six pages métier** (Accueil, Projets, Sessions, Workspace,
Intégrations, Paramètres, bureau et mobile) sont faites, vérifiées sur la pile de test locale et poussées sur `main`.
Restent les 5 parcours transversaux de bout en bout (phase 4), la revue globale (phase 5) et la construction réelle
des images de déploiement (phase 6). Rien n'est déployé.

| # | Jalon | État | Détail |
|---|---|---|---|
| 0 | Découverte (Figma, recherches) | ✅ fait | §2.1 |
| 1 | Socle (monorepo, base, outillage) | ✅ fait | §2.2 |
| 2 | Fondations (design system, shell, composants, auth, runner, intégrations serveur) | ✅ fait, vérifié, poussé | §2.3–2.8 |
| 3 | Pages métier (6 domaines, bureau + mobile) + pile de test + terminal partagé | ✅ fait, vérifié, poussé | §3 |
| 4 | Les 5 parcours obligatoires de bout en bout + Playwright | ✅ fait (`apps/web/e2e/parcours-*.spec.ts`) | §4.3 |
| 5 | Revue globale (sécurité, fidélité Figma, boutons morts) et corrections | ⬜ à faire | §4.4 |
| 6 | Déploiement Coolify / VPS-3 | ⏳ fichiers écrits, jamais testés, rien de déployé | §4.5 |

Phase 3 : commits `bef7e3d` (prérequis) → fin de la phase 3 sur `main` (voir `git log`). Le suivi court est tenu dans
[docs/PROGRESS.md](docs/PROGRESS.md).

---

## 2. Ce qui est fait

### 2.1 Découverte (commit `88b530e`)

- Spécifications extraites de Figma (fichier `nlvRWAtD1x2fKf8gVgcM0g`, page « NUERA DEV — WEB APP ») :
  `docs/figma/*.md` — `overview.md` (principes, navigation, parcours A–D, carte des routes, paramètres d'URL),
  `screens-desktop-a.md` (shell + D01–D04), `screens-desktop-b.md` (D05–D08), `screens-mobile.md` (M01–M08),
  `states-flows.md` (A1–A4, D1–D2, T1–T8), `states-workspace.md` (W1–W7), `states-mobile-and-extensions.md`
  (S1–S5 + composants de la section 04), `design-system.md`, `workspace-survey.md`.
- Captures PNG, code de design brut et assets : `.design-refs/` (**non versionné**, présent sur le poste ; à
  régénérer avec le MCP Figma si absent).
- Recherches : `docs/research/claude-code.md` (intégration conforme du CLI, hooks, autorisations, Remote Control),
  `docs/research/integrations.md` (GitHub App, Coolify, Figma, MCP), `docs/research/stack.md` (versions et pièges).
- Architecture : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (topologie, données, contrat du runner, sécurité,
  temps réel, arbitrages).

### 2.2 Socle (commits `75ef1e3`, `44da00f`)

- Monorepo pnpm 9 : `apps/web` (Next.js 16.4, React 19.3, Tailwind 4.3, TypeScript 6.0 strict), `apps/runner`
  (Fastify 5), `packages/db` (Drizzle 0.45 + postgres.js), `packages/shared` (Zod 4, formatage fr-FR).
- PostgreSQL 17 local sans Docker (`embedded-postgres`, port 54329, données dans `.data/pg`) : `pnpm db:local`.
- Scripts : `scripts/setup-env.mjs` (`.env` avec secrets aléatoires), `scripts/create-db.mjs` (créer / `--reset`
  une base), `scripts/dev-db.mjs`.
- Lint : **oxlint 1.91** (`.oxlintrc.json`) — ESLint a été retiré (plusieurs minutes par fichier sur ce poste).
- `.env.example` documente toutes les variables (obligatoires, optionnelles, réservées aux tests).

### 2.3 Base de données (commit `ab23c09`)

- Schéma `packages/db/src/schema/` : `auth.ts` (user avec index de propriétaire unique, session, account,
  verification, two_factor, passkey — Better Auth 1.7.17), `projects.ts` (projects, project_env_vars, worktrees,
  command_runs, pull_requests), `sessions.ts` (sessions, session_events, permission_requests), `integrations.ts`
  (integrations, mcp_servers, project_mcp_servers), `app.ts` (app_settings, operations, notifications,
  push_subscriptions, audit_log, uptime_daily) — **23 tables**, statuts en `text` typés (`types.ts`).
- Une seule migration `packages/db/drizzle/0000_material_hiroim.sql` (régénérée tant que rien n'est déployé ;
  **après le premier déploiement, ne plus jamais régénérer : ajouter des migrations**).
- Colonnes ajoutées à l'intégration mais **pas encore utilisées par le code** : `sessions.claude_session_id`,
  `command_runs.details`, `mcp_servers.config`, type de notification `integration_error` (utilisé), index
  `session_events_tool_idx`.

### 2.4 Paquet partagé (commit `e0f45a6`)

- `@nuera/shared/runner` : schémas Zod et types des **58 routes** du runner (`RUNNER_ROUTES`), raisons d'erreur.
- `@nuera/shared/events` : événements SSE (`session.status`, `session.event`, `session.permission`,
  `operation.progress`, `run.*`, `terminal.*`, `system.metrics`, `claude.status`, `notification.created`,
  `stream.reset`…).
- `@nuera/shared/paths` : garde des chemins, validation des branches/worktrees/dépôts.
- `@nuera/shared/format` : dates et nombres fr-FR (Europe/Paris), durées, tailles, initiales.

### 2.5 Web — serveur, authentification, API (commits `4305078` → `697c894`, `d220183`, `64ce510` → `7a2a510`)

- Socle serveur `apps/web/src/server/` : `db.ts`, `errors.ts` (`AppError`), `http.ts` (`apiRoute` = session +
  contrôle d'Origin + Zod + erreurs JSON ; `internalRoute` = jeton du runner), `security/` (chiffrement AES-256-GCM
  des secrets, audit, Origin, limites de débit, IP de confiance), `settings.ts` (réglages de l'application).
- Authentification (Better Auth 1.7.17) : propriétaire unique créé par `/configuration` avec `SETUP_TOKEN`, TOTP
  obligatoire, 8 codes de secours, clés d'accès (passkeys), expiration d'inactivité et absolue, audit des connexions.
  Pages : `/configuration` (+ `/double-facteur`, `/codes-de-secours`, `/cle-d-acces`), `/connexion`
  (+ `/deux-facteurs`), `/deconnexion`. `src/proxy.ts` = garde optimiste (chaque page revérifie avec `requireUser()`).
- Client typé du runner `server/runner/` + relais SSE `/api/stream/{events,sessions/[id],terminals/[id],runs/[id],
  operations/[id]}` + entrée/redimensionnement de terminal `/api/terminals/[id]/…`.
- Intégrations côté serveur (aucune page encore) :
  - GitHub App par flux *manifest*, installations, jetons réduits au dépôt et à l'opération, liste des dépôts,
    pull requests (`server/github/`, `/api/integrations/github/*`).
  - Coolify en lecture seule (`server/coolify/`), registre MCP activé projet par projet, diagnostics, connexion Figma
    par terminal, en-têtes secrets servis à la demande (`server/mcp/`, `/api/integrations/mcp/*`).
  - Vue d'ensemble `getIntegrationsOverview()` (`server/integrations/`), routes internes du runner `/api/internal/*`.
  - Notifications + Web Push (VAPID), manifeste PWA, icônes, service worker `public/sw.js`.
- Documentation : [docs/SECURITY.md](docs/SECURITY.md), [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

### 2.6 Web — interface (commits `0abd6a6` → `34b283a`)

- Jetons de design (`src/styles/tokens.css`, `components.css`), thème clair / sombre / système, 67 icônes, logo.
- Primitives `src/components/ui/` (boutons, champs, interrupteurs, onglets, dialogues, tiroir, feuille mobile, menus,
  toasts, bandeaux, états T1 chargement, T2 vide, T4 erreur, T8 confirmation, jauges, tableaux…).
- Shell `src/components/shell/` : barre latérale 248 px, rail 72 px du Workspace, barre d'onglets mobile, palette
  ⌘K / Ctrl K, cloche de notifications, états globaux T5 (serveur indisponible), T6 (Claude déconnecté), W7
  (connexion perdue), flux temps réel `src/hooks/useLiveEvents.tsx`. Layouts `(shell)` et `(workspace)`.
- Composites Nuera Dev `src/components/dev/` : fil de session, demande d'autorisation, saisie bureau/mobile, diff,
  cartes et lignes de listes (sessions, projets, branches, commandes, MCP, variables…).
- Inventaires : [apps/web/src/components/README.md](apps/web/src/components/README.md) et
  [apps/web/src/components/dev/README.md](apps/web/src/components/dev/README.md) (props + nœud Figma de chaque
  composant, notes de câblage). Galeries de développement `/kit` et `/kit/composites` (404 en production).
- Page d'accueil **provisoire** `src/app/(shell)/page.tsx` (salutation + date + disponibilité seulement).

### 2.7 Runner (commits `b3c3add`, `55633c7`)

- `apps/runner` — seul composant qui touche au disque, à Git, aux PTY et aux processus ; détail complet dans
  [apps/runner/README.md](apps/runner/README.md).
- Git : clone avec progression, fetch/pull, branches, worktrees, diff, stage, commit, push (branche par défaut
  toujours protégée), refus des réglages Git dangereux du dépôt (`GIT_CONFIG_UNSAFE`), jeton injecté par processus.
- Sessions Claude : CLI interactif dans tmux (Linux) ou PTY direct (Windows), hooks officiels → conversation,
  autorisations avec attente bornée de la décision du navigateur, interruption (Échap), arrêt, reprise
  (`--resume`), status line, MCP par session (`--mcp-config --strict-mcp-config`).
- Processus du projet (install/dev/build/test/lint) avec lecture des résultats de tests, terminaux (shell, connexion
  Claude, connexion MCP, `/status`), métriques système, disponibilité, planificateur.

### 2.8 Déploiement (commit `84ffd7d`) — écrit, **jamais construit ni testé** (pas de Docker sur le poste)

- `deploy/docker/web.Dockerfile`, `deploy/docker/runner.Dockerfile`, `deploy/docker/runner-entrypoint.sh`
  (installe le CLI officiel dans le HOME persistant), `deploy/docker-compose.yml` (services migrate, web, runner ;
  runner sans port public), `deploy/docker-compose.dev.yml`, `deploy/scripts/backup-db.sh`, `restore-db.sh`.
- Procédure : [docs/DEPLOY.md](docs/DEPLOY.md).

### 2.9 Vérifications réalisées (état `a79ea8d`)

| Vérification | Résultat |
|---|---|
| `tsc --noEmit` sur `@nuera/shared`, `@nuera/db`, `@nuera/runner`, `@nuera/web` | 0 erreur |
| `pnpm lint` (oxlint) | 0 erreur, ~50 avertissements à nettoyer |
| Vitest | shared 21, db 5, web 230, runner 64 (vrais dépôts Git, PTY réels, faux CLI de test) — tous verts |
| Playwright `apps/web/e2e/auth.spec.ts` | 11/11 (bureau + mobile) |
| `next build` (production) | OK en 33 s |
| Captures comparées aux exports Figma | par lot, à 1440 et 390 px (galeries, pages d'auth, shell) |

---

## 3. Phase 3 — pages métier (faite)

Réalisée par un workflow multi-agents ([docs/reprise/phase3-domaines.workflow.js](docs/reprise/phase3-domaines.workflow.js)) :
chaque lot construit puis relu indépendamment, intégré lot par lot sur `main`.

| Lot | Contenu | Vérification du lot |
|---|---|---|
| Pile de test | `apps/web/e2e/harness/` (`stack.mjs up/down/seed/login/shot…`, faux GitHub, vrais dépôts Git, runner, faux CLI, données), projets Playwright `desktop`/`mobile` — [docs/TESTING.md](docs/TESTING.md) | smoke + auth 20/20 |
| Terminal | `components/terminal` (xterm.js), `server/terminals`, `/api/terminals/**`, `/kit/terminal` | e2e 13/13 (+1 ignoré) |
| Accueil | D01/M01 en direct (`server/home`), recherche globale ⌘K (`/api/search`), correctif de boucle de la palette | e2e 12/12 |
| Sessions | D06/M06, `NewSessionDialog`/`NewSessionButton`, `StopSessionDialog`, `server/sessions`, `/api/sessions/**` | e2e 19/19 |
| Projets | D02/M02, ajout A1–A4/M03 (route interceptée), page projet D04/M04 à 7 onglets, `/api/projects/**`, `/api/runs/**` | e2e 14/14 (+4 ignorés) |
| Workspace | D05/M05, W1–W7, S1–S4 : conversation, autorisations, Terminal brut, fichiers, diff, commit/push/PR, `/api/permissions/**`, `/api/worktrees/**` | e2e 21/21 (+5 ignorés) |
| Intégrations | D07/M07, tiroir D1/D2 intercepté, ajout MCP, test, activation par projet, reconnexion Coolify/OAuth | e2e 15/15 (+1 ignoré) |
| Paramètres | D08/M08 : Claude Code (statut, reconnexion par terminal, /status), Compte et sécurité, Serveur, Préférences | e2e 24/24 (+8 ignorés) |

Vérification globale après intégration : `tsc` 0 erreur sur les 4 paquets ; oxlint 0 erreur ; Vitest shared 21,
db 5, web 412, runner 64 ; `next build` OK. Les « ignorés » sont des tests propres au bureau ou au téléphone.

---

## 4. Ce qui reste à faire (précis)

### 4.1 Phase 3 — faite (§3)

### 4.2 Suivis techniques (hérités des phases 2 et 3)

Relevés par les lots de la phase 3 (honnêtement remplacés par un état vrai dans l'UI en attendant) :

- Runner : persister `command_runs.details` ; route de suppression du clone principal (option T8 « Supprimer aussi le
  clone ») et d'adoption d'un clone existant (A4) ; taille disque des worktrees (D08 « · 2,4 Go », T8 « Libère … ») ;
  mises à jour du CLI / du système (D08 « Mise à jour système ») ; copie S5 et lien `#demande-<id>` des notifications
  d'autorisation ; politique de redémarrage (D01) ; renommer une session CLI vivante ; liste des tests de Claude.
- Web : liste des variables interdites à exporter de `@nuera/shared` (copiée dans `server/sessions/env.ts` et
  `server/projects/env.ts`) ; archivage/renommage sans événement `session.status` ; `useLiveEvents` rafraîchit sous
  une route interceptée (modal Projets, tiroir Intégrations) ; `GlobalSearch` désinscrite sous T5 ; `checkCoolify`
  pourrait marquer le serveur MCP Coolify `expired` ; « Reprendre » d'une session terminée jamais affiché.
- UI : `Banner` (texte qui ne passe pas à la ligne sur téléphone), `Dialog` centré sur la zone de contenu (D03),
  `McpServerCard` sur une ligne à 1440, `Pastille` 48 → icône 20 px, `ConfirmDialog` sans état désactivé ; faux
  GitHub sans `contents`/`size` (D03 « Détecté », « 84 Mo »).

Hérités de la phase 2 :


- Runner : lire/écrire `sessions.claude_session_id` (aujourd'hui dans `NUERA_DATA_DIR/sessions/<id>/launch.json`) et
  `command_runs.details` (résultats par test, aujourd'hui en mémoire seulement) ; politique au démarrage pour les
  sessions tmux `nuera-*` orphelines ; `GitService.changes()` lit tous les fichiers non suivis (lent sur un gros
  arbre) ; charges de hook > 1 Mio ignorées.
- Web : écrire l'audit des décisions d'autorisation, push, suppression de worktree et écriture de CLAUDE.md (le runner
  ne journalise pas) ; utiliser `mcp_servers.config` (en-têtes non secrets, outils refusés, préréglage) ; passer les
  branches protégées du projet au runner ; recharger les données sur `stream.reset` dans chaque page.
- UI : primitive Checkbox manquante (W5 « Fichier inclus ») ; `formatShortDay` à déplacer dans `@nuera/shared/format` ;
  pourcentages à 2 décimales (« 99,95 % » en D08) ; `NotificationItem` pourrait remplacer les lignes de
  `NotificationList` ; pas de route de pièce jointe (trombone masqué) ; ~50 avertissements oxlint.
- Copie à arbitrer par le propriétaire : « Coolify ne répond plus » vs « Coolify refuse le jeton » (une ligne dans
  `server/integrations`), ligne « Expiration » de D07, « .mcp.json de chaque projet » (D1).
- Non couvert par les tests : cérémonies de clés d'accès (authentificateur virtuel), « approuver cet appareil 30
  jours », backend tmux (aucun tmux sur Windows), flux GitHub et MCP contre les vrais services.

### 4.3 Phase 4 — les 5 parcours obligatoires (specs Playwright bureau + mobile sur la pile de test)

1. GitHub connecté → choix du dépôt → clonage → projet → Workspace.
2. Projet → branche / worktree → session → instruction → suivi en direct → autorisation ou erreur → résultat.
3. Modifications → diff → vérifications (tests) → commit → push → pull request.
4. Navigateur fermé → session conservée → reprise depuis le téléphone.
5. Configuration MCP / secret → vraie connexion ou « connexion requise » → diagnostic.

### 4.4 Phase 5 — revue globale

Audit sécurité (chaque route/action, Origin, secrets, audit, limites, exposition du runner, CSP, cookies), fidélité
Figma de tous les écrans à 1440 et 390 px, chasse aux boutons morts et aux données codées en dur, copie française
(apostrophe droite), accessibilité, absence de polling, nettoyage des avertissements oxlint ; corrections ; mise à jour
de `docs/` et de ce README.

### 4.5 Phase 6 — déploiement (VPS-3 via Coolify sur VPS-1, domaine `dev.nuera.studio`)

- Construire et tester réellement les images (`deploy/docker/*.Dockerfile`) sur une machine Linux avec Docker.
- Image runner : git ≥ 2.32, tmux ≥ 3.0, Node ≥ 22, CLI Claude officiel ≥ 2.1.317, `LANG=fr_FR.UTF-8` ; accepter une
  fois le dialogue de confiance du CLI pour `NUERA_PROJECTS_ROOT` ; le bac à sable du CLI (bubblewrap) peut ne pas
  fonctionner sous le seccomp par défaut de Docker (à documenter).
- Volumes persistants (`/srv/dev`, `/data`, `/home/nuera`), PostgreSQL Coolify non exposé, sauvegardes, HTTPS,
  `TRUSTED_IP_HEADER=x-real-ip` derrière Traefik, `APP_URL`, secrets, suppression de `SETUP_TOKEN` après la
  configuration.
- À vérifier sur VPS-3 avec le vrai CLI : les 14 hooks acceptés via `--settings`, décision `PermissionRequest` avec
  `updatedPermissions`, collage entre crochets et Échap à travers tmux, `--session-id` + `--name` +
  `--remote-control`, clés réelles de `claude auth status --json` ; essais ouverts S3, S4, S7, S8, S10 de
  `docs/research/integrations.md` §8.

### 4.6 Actions du propriétaire (bloquants externes — ne jamais contourner)

- Donner l'accès au VPS-3 / Coolify (aucun déploiement n'a été fait, aucune configuration serveur modifiée).
- Créer la GitHub App (bouton de création par *manifest* dans Intégrations, une fois la page faite) et l'installer sur
  `nuera-studio` et le compte personnel.
- Se connecter à Claude Max sur VPS-3 dans le terminal de Nuera Dev (`claude auth login`).
- Créer un jeton Coolify limité (lecture) et, si souhaité, les clés VAPID.
- Recommandé sur le poste Windows : exclusions Windows Defender pour le dépôt et le store pnpm (le poste est très lent
  en E/S).

---

## 5. Reprise par un autre Claude — instructions exactes

### 5.1 Lire, dans cet ordre

1. [docs/reprise/BRIEF-ORIGINAL.md](docs/reprise/BRIEF-ORIGINAL.md) — le brief complet du propriétaire, **verbatim**.
   C'est la commande à exécuter jusqu'au bout. Le propriétaire a demandé : « réalise ça sans t'arrêter, … ne pose pas
   de question ni confirmation ou vérification et ne t'arrête que quand le site est entièrement fait, fais
   régulièrement des commits et force push sur main, quand tu as atteint des gros jalons ».
2. `CLAUDE.md` (chargé automatiquement) — règles absolues + « Leçons et pièges confirmés ».
3. Ce README (§1–4), puis [docs/PROGRESS.md](docs/PROGRESS.md) et [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
4. Les inventaires avant d'écrire du code : `apps/web/src/components/README.md`, `apps/web/src/components/dev/README.md`,
   `apps/runner/README.md`, `docs/INTEGRATIONS.md`, `docs/SECURITY.md`.
5. Les spécifications Figma du domaine traité (`docs/figma/*.md`) et ses captures `.design-refs/screens/`.

### 5.2 Contraintes à ne jamais enfreindre (extraites du brief)

- Claude Max avec le CLI officiel uniquement, en session interactive : jamais `claude -p`, `stream-json`, Agent SDK
  `query()`, `setup-token`, `CLAUDE_CODE_OAUTH_TOKEN` ; ne jamais intercepter, extraire, réutiliser ni faire
  transiter les jetons OAuth de Claude Max ; ne jamais lire `~/.claude/.credentials.json`. Si une conversation native
  reconstruite n'est pas possible, ne pas la simuler : états « connexion requise » / « session indisponible ».
- Aucune donnée métier codée en dur, aucun faux succès, aucun bouton mort ; fixtures uniquement dans les tests.
- Le web n'est pas un shell privilégié ; pas d'accès root ni de socket Docker pour le conteneur web ; ne jamais
  exposer le runner ni un shell sur Internet.
- **Commits, descriptions de PR et notes de livraison : aucune mention d'IA, de Claude, d'agent ou d'outil de
  génération, aucun « Generated with », aucun trailer `Co-authored-by`.** Identité Git existante : Ethan Ngo
  `<ethan.ngo@viacesi.fr>`. Messages conventionnels sobres en français.
- Ne jamais déployer ni modifier un serveur sans accès et autorisation ; ne jamais prétendre avoir testé la production.
- Copie UI identique à Figma, apostrophe **droite** `'` (décision prise : la page NUERA DEV n'emploie jamais `’`).

### 5.3 Environnement de ce poste (Windows 11, 12 threads, 32 Go)

- Poste **très lent** en E/S et au démarrage des processus : commandes longues en arrière-plan, délais larges, une
  seule instance `next dev` par tâche avec son propre `NEXT_DIST_DIR` et son port.
- PostgreSQL local : `pnpm db:local` doit tourner (en arrière-plan) avant tout test ou serveur ; il s'est arrêté avec
  la session précédente. Base de dev : `nuera_dev` (user/mot de passe `nuera`/`nuera`, port 54329).
- Ports réservés à l'orchestrateur : 3000 (web), 4100/4101 (runner). Chaque lot parallèle utilise ses propres ports et
  sa propre base (convention dans le script de phase 3).
- Durées observées : typecheck web ~1–2 min, Vitest web ~3 min, runner ~10 min, `next build` ~35 s, oxlint 0,5 s.
- Commandes de vérification complètes :
  ```bash
  for p in packages/shared packages/db apps/runner apps/web; do node node_modules/typescript/bin/tsc --noEmit -p $p/tsconfig.json; done
  ./node_modules/.bin/oxlint
  pnpm --filter @nuera/shared test; pnpm --filter @nuera/db test; pnpm --filter @nuera/web test; pnpm --filter @nuera/runner test
  NEXT_DIST_DIR=.next-build pnpm --filter @nuera/web exec next build
  E2E_STACK=<pile> pnpm --filter @nuera/web e2e [spec]   # Playwright sur la pile de test (docs/TESTING.md)
  ```

### 5.4 Reprendre (phases 4 à 6)

1. Vérifier l'état réel : `git status`, `git log --oneline -5` ; la phase 3 est entièrement sur `main`.
2. Les phases suivantes sont orchestrées par [docs/reprise/phases4-6.workflow.js](docs/reprise/phases4-6.workflow.js)
   (argument `part` : `flows`, `review` ou `deploy`). Mettre à jour la ligne « STATE » (commit courant) avant de le
   lancer ; ses agents reprennent les fichiers existants plutôt que de les réécrire.
3. Conteneur Linux lancé en root : `embedded-postgres` refuse de tourner en root et initialise `.data/pg` avec
   l'utilisateur `postgres` → `mkdir -p .data/pg && chown postgres:postgres .data/pg` avant `pnpm db:local`.
4. Organisation qui a fonctionné en phase 2 : une copie de travail partagée, propriété stricte des fichiers par lot,
   contrats d'abord, aucun agent ne committe ni n'installe de dépendance, un relecteur indépendant par lot, rapports
   structurés (`files_changed`, `proposed_commits`, `followups`, `known_gaps`).

### 5.5 Intégrer une phase terminée (procédure suivie jusqu'ici)

1. Lire les rapports de chaque lot (journal `journal.jsonl` du workflow) : `followups`, `remaining`, `known_gaps`.
2. Corriger les incohérences entre lots et appliquer les suivis ; schéma : modifier `packages/db/src/schema`, puis
   `pnpm db:generate` (tant que rien n'est déployé, on peut supprimer `packages/db/drizzle` et régénérer une seule
   migration 0000) et `node scripts/create-db.mjs nuera_dev --reset && pnpm db:migrate`.
3. Lancer toutes les vérifications du §5.3 ; tout doit être vert.
4. Contrôle avant commit : pas de secret (`ghp_`, `github_pat_`, `PRIVATE KEY`…), aucune mention d'IA dans les
   messages, pas de fichier généré (`apps/web/AGENTS.md`, `.next-*`, captures).
5. Committer **lot par lot** avec un script qui s'arrête si `git add` échoue (un mauvais chemin a déjà fait committer
   un lot vide) : pour chaque lot `git add -A -- <chemins> || exit 1` puis `git commit -m "<message>"`.
6. Pousser : `GCM_INTERACTIVE=never GIT_TERMINAL_PROMPT=0 git push origin main` ; mettre à jour `docs/PROGRESS.md`
   et ce README à chaque jalon.

### 5.6 Décisions déjà prises (ne pas les rediscuter)

Sessions dans tmux (PTY direct sous Windows) avec `--session-id` = identifiant Nuera ; conversation reconstruite par
les hooks officiels + lecture tolérante du journal, Terminal brut comme référence ; autorisations par le hook
`PermissionRequest` à attente bornée, jamais d'auto-approbation ; SSE plutôt que WebSocket ; GitHub App par
*manifest* avec jetons réduits ; MCP par session avec `--strict-mcp-config` et `headersHelper` ; bouton Accent pour
les actions destructives (lacune Figma 1) ; oxlint au lieu d'ESLint ; TypeScript 6.0.x ; apostrophe droite. Détail et
justification : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §14.

---

## 6. Démarrage local

Prérequis : Node.js ≥ 22.12 (testé sous 24), pnpm 9, Git. Docker n'est pas nécessaire.

```bash
pnpm install
pnpm setup:env          # crée .env avec des secrets aléatoires (affiche le jeton de configuration initiale)
pnpm db:local           # PostgreSQL 17 local (laisser tourner dans un terminal)
pnpm db:migrate         # applique les migrations
pnpm dev                # web http://localhost:3000 + runner http://127.0.0.1:4100
```

Puis ouvrir `http://localhost:3000/configuration` (toujours `localhost`, pas `127.0.0.1` : sinon la page ne s'hydrate
pas en dev), saisir le jeton de configuration, créer le compte propriétaire et activer la double authentification.

Sous Windows (sans tmux), le runner utilise des PTY directs : les sessions survivent à la fermeture du navigateur mais
pas à un redémarrage du runner (elles sont alors reprises via `claude --resume`). En production (Linux), tmux conserve
les sessions indépendamment du runner.

| Commande | Rôle |
|---|---|
| `pnpm dev` | web + runner en développement |
| `pnpm typecheck` / `pnpm lint` / `pnpm test` | vérifications |
| `pnpm e2e` | parcours Playwright (bureau et téléphone) |
| `pnpm db:generate` / `pnpm db:migrate` | migrations Drizzle |
| `pnpm build` | builds de production |

## 7. Documentation

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/SECURITY.md](docs/SECURITY.md) ·
[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) · [docs/DEPLOY.md](docs/DEPLOY.md) · [docs/PROGRESS.md](docs/PROGRESS.md) ·
[docs/reprise/](docs/reprise/) (brief d'origine, script de la phase 3).
