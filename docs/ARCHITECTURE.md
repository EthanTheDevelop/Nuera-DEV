# Nuera Dev — Architecture

> Référence d'implémentation. Les maquettes Figma (`docs/figma/*`) font autorité pour le visuel et les parcours ;
> ce document fixe les choix techniques, les contrats entre modules et les règles de sécurité.
> Les arbitrages sont tracés en fin de document (§14). Version **multi-comptes** : `docs/MULTICOMPTE.md` fait foi
> pour les comptes, espaces, serveurs et rôles (ses écarts sont au §14 de ce document-là) ; ce document en résume
> les conséquences.

## 1. Principes non négociables

| # | Principe | Conséquence technique |
|---|---|---|
| P1 | Aucune API de chat privée sur l'abonnement Max (Figma `241:6085`). | Chaque session est un processus **interactif** du CLI officiel `claude`, non modifié, dans un PTY (tmux en production). La vue *Conversation* est une mise en forme des signaux officiels (hooks, journal de session) ; la vue *Terminal brut* est le TUI lui-même. Jamais de `claude -p`, de `stream-json`, d'Agent SDK `query()` ni de `CLAUDE_CODE_OAUTH_TOKEN`. |
| P2 | Aucun formulaire de jeton Claude (Figma `241:6089`). | La connexion Claude passe par `claude auth login` lancé dans un terminal web éphémère (non enregistré). Nuera Dev ne lit jamais `~/.claude/.credentials.json` ni les champs de compte de `~/.claude.json`. |
| P3 | Aucune métrique de coût/quota/jetons inventée (Figma `241:6093`). | On n'affiche que ce que le CLI expose (statut `auth status --json`, JSON de la *status line* : `rate_limits`, contexte, modèle). « Capacité » = capacité **serveur** (sessions parallèles, CPU/RAM). |
| P4 | Aucune action de production Coolify à portée de Claude (Figma `241:6097`). | Le serveur MCP Coolify reçoit un jeton restreint à un périmètre de développement ; l'UI n'expose aucune action de production. |
| S1 | Le backend web n'est pas un shell privilégié. | Git, terminaux, processus et Claude passent par le **runner** (service séparé, non-root, réseau privé, chemins autorisés, limites de ressources, journalisation). |
| S2 | Rien n'est faux. | Aucun mock permanent, aucun faux « connecté », aucun bouton mort. Les fixtures n'existent que dans les tests. |
| M1 | Cloisonnement des espaces. | Chaque compte travaille dans son espace ; l'espace vient du contexte de requête, jamais du client ; un identifiant d'un autre espace reçoit la réponse exacte d'un inconnu (404), sans appel au runner, sans écriture. Les administrateurs ne voient jamais le contenu d'un espace. |
| M2 | Un serveur = un espace = une personne = une connexion Claude (conditions d'Anthropic). | Un runner par serveur, avec son disque, son tmux, son CLI et la connexion Claude de la seule personne à qui il est attribué ; un serveur utilisé n'est jamais réattribué. |
| M3 | 2FA obligatoire pour tous les comptes. | TOTP + codes de secours (clés d'accès en option) ; aucune variable ne la désactive. |

## 2. Topologie

```
 Navigateurs (bureau / téléphone, PWA) — un compte par profil de navigateur
      │ HTTPS — cookies de session Better Auth (Secure, HttpOnly, SameSite=Lax), vérification d'Origin
      ▼
 apps/web — Next.js 16 (App Router, standalone)           ← seul service exposé (un seul conteneur)
      │  • UI, Server Components, Server Actions, Route Handlers, console d'administration
      │  • Comptes (Better Auth + 2FA TOTP + passkeys, invitations, récupération), audit, chiffrement des secrets
      │  • Contexte de requête (compte → espace → serveur), gardes de portée, réglages par portée
      │  • Intégrations par espace : sources GitHub (Octokit), Coolify, MCP, Web Push ; planificateur des vérifications
      │  • Relais SSE/HTTP vers le runner de chaque serveur (jamais exposé) + canal web par compte
      │ HTTP privé + Bearer <jeton du serveur> (réseau Docker interne / 127.0.0.1 en dev)
      ├──────────────────────────────┬───────────────────────────────┐
      ▼                              ▼                               ▼
 runner « VPS-3 » (par défaut)   runner du serveur B             runner du serveur C …   ← non exposés, non-root
 RUNNER_TOKEN, DSN complet        jeton nrt_…, rôle nuera_env_…   (une ressource Coolify par serveur)
 tant que non restreint           (RLS par serveur)
      │  • Git (execFile, sans shell), worktrees, fichiers (lecture), diff
      │  • Terminaux PTY (@lydell/node-pty) + miroir @xterm/headless (reprise d'écran)
      │  • Sessions Claude : tmux (Linux) ou PTY direct (dev Windows), hooks, status line
      │  • Processus du projet, métriques, disponibilité ; ne voit que les lignes de **son** serveur
      ▼
 PostgreSQL 17 (service distinct, non exposé)   Volumes par serveur : projets (clones + worktrees),
                                                données (runtime, logs), HOME (~/.claude du CLI)
```

Un espace a au plus un serveur actif (v1) ; un compte sans serveur garde Accueil, Intégrations, Paramètres et (s'il
est administrateur) Administration, et voit « Aucun serveur attribué » partout où un runner est requis (jamais T5).
Un redéploiement de `web` ne touche ni aux dépôts ni aux sessions (elles vivent dans `runner`/tmux).
Un redéploiement de `runner` interrompt les processus mais pas les données : les sessions passent
« Interrompue · reprise possible » et se reprennent par `claude --resume <sessionId>`.

## 3. Monorepo

```
apps/
  web/                 Next.js (UI + API + auth)            @nuera/web
  runner/              service d'exécution                   @nuera/runner
packages/
  db/                  schéma Drizzle, migrations, client    @nuera/db
  shared/              contrats Zod runner⇄web, types, utilitaires purs (formatage FR, chemins)  @nuera/shared
deploy/                Dockerfiles, compose Coolify, scripts de sauvegarde/restauration
scripts/               base locale (embedded-postgres), outils de dev
docs/                  figma/ (spécifications extraites), research/, ARCHITECTURE.md, PROGRESS.md, DEPLOY.md
```

Les paquets internes sont consommés **en source TypeScript** (`exports` vers `src/*.ts`, `transpilePackages` côté Next,
`tsx` côté runner en dev, bundle `tsup`/`esbuild` pour la prod du runner).

## 4. Couches dans `apps/web`

```
src/app/                       routes (App Router) — composition uniquement, pas de logique métier
  (auth)/                      connexion, configuration initiale, 2FA, /invitation/[jeton], /recuperation/[jeton]
  (shell)/                     pages avec barre latérale 248 px / barre d'onglets mobile (dont /administration)
  (workspace)/workspace/[sessionId]   rail 72 px, pas de barre d'onglets
  api/                         route handlers (SSE, webhooks GitHub setup, auth, actions JSON)
src/components/ui/             primitives du design system (Button, Badge, Card/Tile, Field, Switch, Tabs, Dialog,
                               Drawer, Sheet, Toast, Banner, Skeleton, EmptyState, StatusDot, Icon…)
src/components/shell/          Sidebar, SidebarRail, TabBar, CommandPalette, ServerCard, UserCard, états globaux T5/T6
src/features/<domaine>/        composants et hooks client propres à un domaine (home, projects, workspace, sessions,
                               integrations, settings, admin, search)
src/server/                    code serveur uniquement (`import 'server-only'`)
  auth/                        Better Auth, comptes, invitations et liens, autorisations d'enrôlement, garde 2FA
  tenancy/                     contexte de requête (`requireContext`), gardes de portée (`scopeOf*`, `ofSpace`,
                               `auditIn`), appelant runner des routes internes
  admin/                       comptes, invitations, serveurs (jetons, rôles PostgreSQL), instance, journal d'instance
  security/                    origin/CSRF, rate limit, chiffrement AES-256-GCM lié à la ligne, audit, garde SSRF,
                               jetons des runners
  runner/                      client typé du runner **par serveur** (`getRunnerForEnvironment`, contrats @nuera/shared)
  github/                      sources GitHub (manifest, installations, jetons), Octokit
  coolify/ mcp/ push/ integrations/   intégrations par espace, planificateur
  <domaine>/                   services métier (projects, sessions, settings, notifications…) — seuls à toucher la DB
src/lib/                       utilitaires isomorphes (format FR, cn, zod helpers)
```

Règles : les pages lisent via les services serveur (Server Components) qui reçoivent d'abord `ctx`
(`RequestContext = { user, space, environment | null }`) ; les mutations passent par Server Actions (formulaires) ou
route handlers `apiRoute({ auth })` validés Zod ; toute mutation vérifie la session **et** journalise si sensible.
Les listes filtrent par l'espace, les recherches par id passent par une garde de portée (404 d'un inconnu pour un id
étranger), les appels au runner passent par le serveur de la ressource.

## 5. Données (PostgreSQL + Drizzle)

Schéma dans `packages/db/src/schema/*.ts` (30 tables), migrations versionnées dans `packages/db/drizzle/` : `0000`
(jamais modifiée), puis `0001_tenancy_expand`, `0002_tenancy_backfill`, `0003_tenancy_enforce`, `0004_runner_roles`
(une livraison atomique ; test de montée de version depuis une base 0000 remplie). Tables Better Auth : `user` (+
`role`, `disabled_at`, `deleted_at` ; un seul `owner`), `session`, `account`, `verification`, `two_factor`, `passkey`.

| Table | Rôle | Écrite par |
|---|---|---|
| `spaces`, `space_members` | espaces (v1 : un espace personnel par compte) et leurs membres | web |
| `environments` | serveurs (instances du runner) : espace, statut `pending`/`active`/`suspended`/`retired`, URL, jeton chiffré + empreinte (et suivant pendant une rotation), rôle PostgreSQL, plafonds, battement (`last_seen_at`, versions, `capabilities`) | web (runner : battement seulement) |
| `invitations` | invitations et liens de récupération (empreinte du jeton, validité, serveur pré-attribué) | web |
| `app_settings` | ligne d'instance : durées des accès web, validité des invitations, blocage forcé du mode sans autorisations (les anciennes colonnes déplacées restent, dépréciées et jamais lues) | web |
| `space_settings` | réglages d'espace : modèle, effort, mode d'autorisation, blocage du mode sans autorisations, attente d'une autorisation, Remote Control, worktrees inactifs | web |
| `user_preferences` | préférences du compte : thème, langue, identité Git | web |
| `github_sources` | sources GitHub de l'espace (application, installations, secrets chiffrés, statut) | web |
| `integrations` | Coolify, Figma… par espace : statut, config non secrète, secrets chiffrés, dernière vérification, expiration | web |
| `mcp_servers`, `project_mcp_servers` | registre MCP par espace et activation par projet | web |
| `projects`, `project_env_vars` | dépôts suivis (espace, serveur immuable, source GitHub, chemin, branches, commandes, options, favori, archivage) ; variables (valeurs chiffrées) | web (+ runner : synchro) |
| `worktrees` | worktrees Git par projet (serveur, nom, branche, chemin, état) | runner |
| `sessions`, `session_events`, `permission_requests` | sessions Claude, flux normalisé, demandes d'autorisation | runner (web : titre, archivage, décisions) |
| `operations` | opérations longues (clone, pull, push, commit, worktree, PR…) avec progression et journal | runner / web |
| `command_runs` | lancements install/dev/build/test (statut, sortie, résumé, port, auteur) | runner |
| `pull_requests` | PR créées/suivies | web |
| `notifications`, `push_subscriptions` | une notification par destinataire (`user_id`, `space_id`) ; abonnements Web Push par compte | web |
| `audit_log` | journal (auteur, espace, serveur, compte visé, e-mail figé de l'auteur) | web |
| `uptime_daily` | disponibilité par jour et par service (`runner` pour le serveur par défaut, `runner:<id>` pour les autres) | runner |

`worktrees`, `sessions`, `command_runs`, `operations` portent `environment_id` (copie de celui du projet, FK composite
`(project_id, environment_id)`) ; les unicités d'instance sont devenues **par serveur** (slug, chemin, dépôt actif).
Les tables du runner portent leurs `GRANT` et leur politique RLS pour le rôle `nuera_runner` (§9).

Statuts de session (`sessions.status`) : `new` (W1, avant la 1re instruction), `running`, `waiting_permission`,
`waiting_input` (tour terminé, attend une instruction), `stopped` (arrêtée par l'utilisateur), `interrupted`
(processus disparu : redémarrage, crash), `failed`, `finished` (fin propre du processus), `archived`.
« Reprise possible » est calculé : worktree présent **et** conversation enregistrée.

## 6. Runner : contrat

Toutes les routes exigent `Authorization: Bearer <jeton du serveur>` (`RUNNER_TOKEN` du runner ; comparaison à temps
constant) et valident leurs entrées avec les schémas Zod de `@nuera/shared/runner`. Erreurs :
`{ error: { code, message, detail?, raw?, untouched?, reason? } }` (`raw` = sortie brute de la commande, affichée « à
un clic » — règle T4). **Contrat v2** (`RUNNER_CONTRACT_VERSION`, exposé par `/v1/health` avec `environment { id,
name }` et `state` `ready`/`starting`/`unregistered`/`disabled`) ; le web refuse poliment une route plus récente que
le contrat du runner (`RUNNER_OUTDATED`).

**Identité et cycle de vie** (détail : `apps/runner/README.md`, `docs/MULTICOMPTE.md` §4) : le runner trouve son
serveur par `sha256(RUNNER_TOKEN)` dans `environments.token_hash` (ou `next_token_hash`) ; inconnu ou retiré → attente
(`/v1/health` seule, 503 `ENVIRONMENT_UNREGISTERED` ailleurs, nouvel essai toutes les 15 s) ; puis bail exclusif
(verrou consultatif sur une connexion réservée ; pour un rôle restreint, par `nuera_runner_try_lease()`, seule voie
depuis `0005`), marqueurs `.nuera-environment` dans ses dossiers, reprise limitée à son serveur (503
`ENVIRONMENT_STARTING` en attendant), écoute, planificateur ; battement toutes les 60 s, indépendant du planificateur,
et toute relecture qui trouve le jeton sur un autre serveur arrête le runner. Chaque requête filtre `environment_id = son serveur` ; un id d'un
autre serveur reçoit la réponse d'un inconnu. `suspended` → `ENVIRONMENT_DISABLED` pour tout nouveau travail. Les
politiques de session (blocage du mode sans autorisations, attente, identité Git) arrivent dans les options de
lancement ; plafonds lus dans sa ligne `environments`.

| Domaine | Routes (préfixe `/v1`) |
|---|---|
| Santé | `GET /health` (runner, git, tmux, claude, disque), `GET /system/metrics`, `GET /system/uptime` |
| Événements | `GET /events` (SSE global : statuts, opérations, métriques, notifications, `seq` + `Last-Event-ID`) |
| Git — dépôts | `POST /repos/clone` (opération async), `POST /repos/:project/fetch|pull`, `GET /repos/:project/status`, `GET …/branches`, `POST …/branches`, `POST …/checkout`, `GET …/log` |
| Git — worktrees | `GET/POST /repos/:project/worktrees`, `DELETE /worktrees/:id` |
| Git — changements | `GET /worktrees/:id/changes` (fichiers +/−), `GET /worktrees/:id/diff?path=`, `POST …/stage|unstage`, `POST …/commit`, `POST …/push`, `GET …/ahead-behind` |
| Fichiers | `GET /worktrees/:id/tree?path=`, `GET /worktrees/:id/file?path=` (lecture, taille max, binaire détecté), `PUT /projects/:id/claude-md` (écriture contrôlée de CLAUDE.md + commit) |
| Terminaux | `POST /terminals` (shell dans un worktree, ou `claude auth login`, ou `claude mcp login`), `GET /terminals/:id/stream` (SSE : `snapshot` sérialisé puis `data`), `POST /terminals/:id/input`, `POST /terminals/:id/resize`, `DELETE /terminals/:id` |
| Sessions Claude | `POST /sessions` (worktree + tmux + `claude`), `POST /sessions/:id/resume`, `POST /sessions/:id/instruction` (collage entre crochets + Entrée), `POST /sessions/:id/interrupt` (Échap), `POST /sessions/:id/stop`, `GET /sessions/:id/stream` (SSE conversation + statut), `GET /sessions/:id/terminal` (= terminal de la session), `POST /permissions/:id/decision` |
| Processus projet | `POST /runs` (install/dev/build/test dans un worktree), `GET /runs/:id/stream`, `DELETE /runs/:id` |
| Claude CLI | `GET /claude/status` (`claude --version`, `claude auth status --json`, `claude agents --json`), `POST /claude/mcp/sync` (`claude mcp add-json/remove --scope user`), `GET /claude/mcp/:name` (`claude mcp get`) |
| Hooks (écoute 127.0.0.1 uniquement) | `POST /internal/hooks/:sessionId`, `POST /internal/statusline/:sessionId`, `POST /internal/mcp-headers/:sessionId` — appelés par `bin/nuera-*.mjs` avec le jeton de la session en **en-tête Bearer** (jamais dans l'URL ni l'argv) |

Écarts avec la première version de ce contrat, retenus à l'implémentation (référence : `apps/runner/README.md` et
`packages/shared/src/runner/routes.ts`, 58 routes) : routes ajoutées `POST /repos/check-destination`,
`POST /events/publish` (diffusion des notifications créées par le web), `GET /operations/:id` et
`GET /operations/:id/stream`, `GET /repos/:id/sync`, `GET /worktrees/:id/status`, `GET /projects/:id/claude-md`,
`GET /sessions`, `GET /sessions/:id`, `POST /sessions/:id/start`, `GET /sessions/:id/events?afterVersion=`, `GET|DELETE
/terminals` ; tmux utilise un socket dédié par serveur, `-L nuera` pour le serveur par défaut et `-L nuera-<8 hex de
l'id du serveur>` pour les autres (`NUERA_TMUX_SOCKET` l'emporte ; attache SSH : `tmux -L <socket> attach -t <nom>`),
et ne rattache une session tmux que si son `NUERA_SESSION_ID` est l'id de la ligne ; les worktrees
vivent dans `<NUERA_PROJECTS_ROOT>/.worktrees/<slug>/<nom>` ; le push vers la branche par défaut est toujours refusé
(`BRANCH_PROTECTED`) ; toute commande Git réseau refuse d'abord les réglages dangereux du dépôt (`GIT_CONFIG_UNSAFE`).

Sécurité du runner : chemins résolus (`realpath`) et confinés à `NUERA_PROJECTS_ROOT` / `NUERA_DATA_DIR` ; `execFile`
avec tableau d'arguments (jamais de shell) ; `GIT_TERMINAL_PROMPT=0` ; jeton GitHub (installation, réduit au dépôt
et à l'opération) injecté **par processus git** via `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`
(`http.https://github.com/.extraheader`), assistants d'identification réinitialisés, hooks du dépôt désactivés —
jamais dans une URL, l'argv, `.git/config` ou un magasin d'identifiants ; environnement des processus nettoyé
(suppression de `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`,
`RUNNER_TOKEN`, `DATABASE_URL`…) ; limite de sessions concurrentes ; surveillance RSS/CPU par arbre de processus
avec arrêt au-delà du plafond configuré ; `nice` pour les sessions ; limites mémoire/CPU du conteneur.

## 7. Intégration Claude Code (détail : `docs/research/claude-code.md` §13)

* **Démarrage** : `tmux new-session -d -s nuera-<slug>-<worktree> -c <worktree> -- claude --session-id <uuid>
  --name "<titre>" --permission-mode <mode> [--model] [--effort] --settings <runtime/sessions/<id>/settings.json>
  [--mcp-config <runtime/sessions/<id>/mcp.json> --strict-mcp-config] [--remote-control "<nom>"]`.
  En dev Windows (pas de tmux) : PTY direct, même commande. Le runner garde **un** PTY par session (client
  `tmux attach` ou processus direct) + un miroir `@xterm/headless` pour servir un instantané à chaque reconnexion.
* **Reprise** : `claude --resume <uuid>` dans le même worktree (même `--settings`/`--mcp-config`).
* **Signaux** (fichier `settings.json` par session) : hooks `command` → `node bin/nuera-hook.mjs` (lit stdin, POST vers
  l'écoute locale du runner avec un jeton propre à la session, ne bloque jamais sauf `PermissionRequest`) ;
  `statusLine` → `bin/nuera-statusline.mjs` (transmet le JSON officiel, imprime une ligne courte).
* **Vue Conversation** : éléments normalisés `session_events` issus de `UserPromptSubmit` (instruction),
  `PreToolUse`/`PostToolUse(Failure)` (lignes d'outil, `TodoWrite` → plan de travail), `PermissionRequest`,
  `Notification`, `Stop` (`last_assistant_message`), `SessionStart/End`, complétés par une lecture **tolérante**
  du journal de session (`transcript_path`) pour les messages intermédiaires de Claude. Formes inconnues ignorées ;
  en cas d'échec, la vue Terminal brut reste la référence (repli prévu par Figma V1).
* **Autorisations** : le hook `PermissionRequest` attend la décision prise dans Nuera Dev (Autoriser / Toujours /
  Refuser — clics authentifiés, journalisés) pendant `space_settings.permission_wait_seconds` (option de lancement
  `permissionWaitSeconds`) ; sans réponse il rend la main et le dialogue officiel s'affiche dans le terminal
  (« Répondre dans le terminal »). Jamais d'auto-approbation ; `bypassPermissions` bloqué sauf si l'espace l'autorise
  **et** que l'instance ne le bloque pas.
* **Une connexion Claude par serveur** : chaque runner a son HOME (ou `CLAUDE_CONFIG_DIR` en dev), donc la connexion
  Claude de la seule personne à qui le serveur est attribué ; les commits de Claude sont signés de l'identité Git du
  compte qui démarre ou reprend la session (`gitIdentity` → `GIT_AUTHOR_*`/`GIT_COMMITTER_*`).
* **Interrompre** : Échap envoyé au PTY. **Arrêter** : `/exit` puis arrêt du PTY/tmux après délai.
* **Connexion** : `claude auth status --json` (au chargement, après une erreur d'authentification, ≤ toutes les
  10 min) ; « Se reconnecter » = terminal éphémère `claude auth login` sans enregistrement de la sortie.
* **Remote Control** : option par session (`--remote-control`) ; lien `claude.ai/code` affiché quand le CLI le fournit.
* **MCP** (détail : `docs/research/integrations.md` §5.7) : chaque session reçoit un `--mcp-config` généré (serveurs
  activés pour **son** projet uniquement) + `--strict-mcp-config` + `ENABLE_CLAUDEAI_MCP_SERVERS=false` et
  `disableClaudeAiConnectors` dans ses settings. Aucun secret dans ces fichiers : les en-têtes d'authentification sont
  fournis à la demande par `bin/nuera-mcp-headers.mjs` (`headersHelper`) qui interroge l'écoute locale du runner avec
  le jeton de la session. Règles `permissions.deny` pour les outils d'écriture refusés (Coolify production, Figma
  écriture). Figma = MCP distant OAuth : connexion par `claude mcp login figma --no-browser` dans un terminal web ;
  Nuera ne stocke aucun secret Figma. Diagnostics non mutants : `initialize`/`tools/list` HTTP, `claude mcp get`.

## 8. GitHub

Plusieurs **sources GitHub** par espace (`github_sources`, 10 au plus), chacune une application GitHub créée par le
**flux manifest** depuis Intégrations (aucun jeton saisi ; nom unique « Nuera Dev <4 hex> · <hôte> », **privée par
défaut**, état signé lié au compte, à l'espace et à la source) : conversion du code
(`POST /app-manifests/{code}/conversions`) → identifiants chiffrés dans la source → installation sur les dépôts
choisis → jetons d'installation (1 h, **réduits par opération et par dépôt**, en mémoire uniquement) pour l'API
(Octokit, `X-GitHub-Api-Version: 2026-03-10`) et pour Git (en-tête injecté par processus, cf. §6, servi au runner pour
la source **du projet**). Permissions : `contents: write`, `pull_requests: write`, `metadata: read`, `checks: read`,
`statuses: read`, `issues: read`. Statut par source + agrégat (pire statut) ; déconnexion refusée tant qu'un projet
actif utilise la source ; sélecteur de source à l'ajout d'un projet. Repli documenté (non proposé dans l'UI) : PAT à
granularité fine (`GITHUB_FALLBACK_TOKEN`), réservé à l'espace du serveur par défaut, jamais servi au MCP.
`GITHUB_API_URL` surchargeable (tests). Détail : `docs/INTEGRATIONS.md` §2, `docs/research/integrations.md` §2.

## 9. Sécurité

Référence complète : `docs/SECURITY.md` (dont les risques résiduels, §11).

* **Comptes** : Better Auth (e-mail + mot de passe, TOTP **obligatoire pour tous** + codes de secours, passkeys en
  option) ; rôles `owner` (un seul) · `admin` · `member`. Inscription fermée : le propriétaire est créé par
  `/configuration` (`SETUP_TOKEN`), les autres par **invitation** (lien unique affiché une fois, acceptation en une
  transaction, activation 2FA) ; **récupération** par lien d'administrateur, ou en ligne de commande
  (`recovery-link`) pour le propriétaire. Désactivation, réactivation, suppression (anonymisation) gardées : le
  propriétaire n'est jamais touché, le dernier administrateur actif est protégé, personne ne se verrouille soi-même.
  Accès web : expiration après 12 h d'inactivité et au plus 30 jours (réglages d'instance).
* **Requêtes** : `proxy.ts` redirige les visiteurs non authentifiés ; chaque route/action revérifie le compte et son
  contexte côté serveur (`requireContext()`, `apiRoute({ auth: 'space' | 'user' | 'admin' })`), exige la 2FA ;
  mutations : vérification d'`Origin`/`Host` (CSRF) + SameSite=Lax. Cloisonnement : principe M1.
* **Runners** : jeton par serveur ; les runners des serveurs non par défaut se connectent avec un rôle PostgreSQL
  restreint `nuera_env_<8 hex>` (membre de `nuera_runner` : tables du runner seulement, UPDATE colonne par colonne,
  ni DELETE ni TRUNCATE, RLS par serveur) ; le serveur par défaut garde le DSN complet jusqu'à sa restriction
  (`docs/DEPLOY.md` §14).
* **Abus** : limitation de débit (auth via Better Auth ; actions et routes via limiteur mémoire par IP/compte).
* **Secrets** : AES-256-GCM (`APP_ENCRYPTION_KEY`, identifiant de clé préfixé pour rotation), **liés à leur ligne**
  (table + propriétaire en données associées) ; jamais renvoyés au navigateur.
* **Requêtes sortantes** : garde SSRF commune (Coolify, serveurs MCP) — boucle locale, lien-local, hôtes des runners et
  de la base refusés, sauf `NUERA_PRIVATE_HOSTS` ; transport épinglé.
* **Audit** : connexions, 2FA, invitations, récupérations, actions d'administration, serveurs, décisions
  d'autorisation, push/PR, suppression de worktree, archivage, changements d'intégration ; journal personnel
  (Paramètres) et journal d'instance (Administration).
* **En-têtes** : CSP stricte, `frame-ancestors 'none'`, HSTS en prod, `Referrer-Policy`, `Permissions-Policy`.

## 10. Temps réel

SSE de bout en bout (`text/event-stream`, battement toutes les 15 s, `X-Accel-Buffering: no`) : le navigateur
s'abonne à `/api/stream/events` (global), `/api/stream/sessions/[id]` (conversation + statut),
`/api/stream/terminals/[id]` (octets du PTY). Les route handlers authentifient, vérifient la portée **avant** le
relais, puis relaient le flux du runner du serveur de la ressource. Le flux global fusionne le flux du serveur de
l'espace (identifiants préfixés `<environmentId>.<seq>`, pour qu'un `Last-Event-ID` d'un autre serveur provoque
`stream.reset`) et le **canal web du compte** (notifications créées et lues, `stream.hello` : seq 0, sans `id:`) ; un
compte sans serveur reçoit quand même ce canal. Une panne du runner ne coupe plus le flux global : le relais écrit
`stream.error` (`RUNNER_UNAVAILABLE`, une fois par panne) puis l'événement web `runner.unavailable { retryInMs }`
(seq 0, sans `id:`, hors contrat de `@nuera/shared`), continue de livrer le canal web, retente le runner toutes les
10 s (de nouveau `runner.unavailable` après chaque échec) en reprenant après le dernier identifiant relayé, puis
écrit `runner.available` et les trames du runner. Un runner qui ferme lui-même son flux (redémarrage) est retenté
après 3 s sans rien annoncer. Le relais termine le flux si le serveur est remplacé, retiré ou suspendu, ou après
5 min de panne (`DEGRADED_STREAM_MAX_MS`) : le navigateur se reconnecte et repasse par l'authentification. Côté
client (`hooks/useLiveEvents.tsx`), T5 reste affiché avec le compte à rebours du relais, les battements du web ne
valent jamais preuve de vie du runner, et `runner.available` relit l'état comme au retour d'un T5. Garde d'identité multi-onglets : `stream.hello` et un
`BroadcastChannel` font recharger un onglet dont le cookie désigne un autre compte. Saisie terminal : `POST` groupés
(≈10 ms). Reconnexion automatique avec `Last-Event-ID` ; W7 « Connexion perdue » quand le flux tombe alors que la
session continue côté serveur ; T5 quand le runner/serveur ne répond plus.

## 11. Front-end

* Tailwind v4 (`@theme` depuis `docs/figma/tokens.css`), polices Outfit + JetBrains Mono (`next/font`).
* Bureau ≥ 1024 px : barre latérale 248 px (rail 72 px dans le Workspace). Téléphone < 768 px : barre d'onglets,
  feuilles, compositeur collant, cibles 44 px, `safe-area-inset-*`. Tablette : mise en page bureau resserrée.
* Les vues mobiles sont des compositions dédiées (onglets Session/Fichiers/Diff/Git, feuilles), pas un bureau réduit.
* États transversaux T1–T8 comme composants réutilisables ; `prefers-reduced-motion` respecté.
* PWA : manifeste, service worker, Web Push (VAPID) pour « Notifications sur ce téléphone ».
* Langue : français (copie Figma à l'identique), formats `fr-FR`, fuseau `Europe/Paris`.

## 12. Tests

* **Unitaires** (Vitest) : formatage, chiffrement, validation, normalisation des hooks, parseurs Git, garde des chemins.
* **Intégration runner** : vrais dépôts Git temporaires (dépôts nus locaux comme « origin »), PTY réels (shell),
  faux binaire `claude` **de test uniquement** (`NUERA_CLAUDE_BIN`) pour simuler `auth status`, hooks et TUI.
* **API** : route handlers contre une base PostgreSQL locale (embedded-postgres, base dédiée par suite).
* **Parcours** (Playwright, bureau + mobile) : configuration initiale + 2FA, ajout de projet (GitHub simulé +
  dépôt nu local), Workspace (terminal, instruction, autorisation simulée par le faux CLI), diff → commit → push → PR
  (API GitHub simulée), sessions (arrêt, reprise, archivage), MCP (diagnostic « connexion requise »), Paramètres.
* **Multi-comptes** : montée de version 0000 → 0004 puis 0005 sur base remplie (`packages/db`), rôles restreints et RLS
  (`rls.test.ts`, runner `restricted.test.ts`), deux runners sur une base (`environments.test.ts`), suites
  d'isolation des routes (`app/api/*/isolation.test.ts`), pile Playwright à **deux comptes et deux runners**
  (invitation + 2FA, administration, isolation, travail simultané, sources GitHub multiples, montée de version) :
  `docs/TESTING.md`. Exécuter avec `NUERA_REQUIRE_PG=1` (PostgreSQL exigé).

## 13. Déploiement (détail : `docs/DEPLOY.md`)

Coolify déploie une ressource principale *Docker Compose* (`deploy/docker-compose.yml`) : `migrate` (applique les
migrations, enregistre l'empreinte de `RUNNER_TOKEN`), `web` (Next standalone, port 3000, healthcheck `/api/health`,
un seul conteneur), `runner` du serveur par défaut (non-root `nuera`, tmux, git, CLI Claude officiel, healthcheck
interne ; `RUNNER_DATABASE_URL` substituée à `DATABASE_URL` une fois restreint) ; chaque **serveur supplémentaire** est
une ressource séparée (`deploy/docker-compose.runner.yml`, ses volumes, son jeton et son DSN restreint, aucun port).
PostgreSQL = ressource Coolify distincte, non exposée. Volumes du serveur par défaut : `/srv/dev`, `/data`,
`/home/nuera`. En service : https://nuera-dev.perso.nuera.studio (NUERA-PERSO-01, version propriétaire unique) ;
mise à jour multi-comptes, ajout d'un serveur et restriction du serveur par défaut : `docs/DEPLOY.md` §12–14.
Sauvegardes : `deploy/scripts/backup-db.sh` / `restore-db.sh`.

## 14. Arbitrages

| Sujet | Décision | Raison |
|---|---|---|
| Persistance des sessions | tmux + `claude --resume` (Figma V3) plutôt que `claude --bg` | Figma l'exige ; documenté par Anthropic pour les machines distantes ; contrôle total du PTY ; `--bg` (+ `--session-id`, `--remote-control`) reste à vérifier sur la version du VPS. |
| Vue Conversation | Hooks officiels + lecture tolérante du journal | Pas d'API de chat (P1) ; repli Terminal brut. |
| Réponse aux autorisations | Hook `PermissionRequest` synchrone borné | Capacité officielle ; ne contourne pas le mode de permission ; repli terminal. |
| WebSocket vs SSE | SSE + POST | Natif dans les route handlers Next, traverse Traefik sans configuration. |
| Bouton destructif | Variante `Accent` comme dans Figma (+ prop `tone="danger"` prête) | Lacune 1 du design system. |
| Postgres local | `embedded-postgres` (pas de Docker sur le poste) + `docker-compose.dev.yml` fourni | Reproductible sur Windows/macOS/Linux. |
| TypeScript | 6.0.x | TS 7 (port natif) n'a pas d'API JS : outillage Next/Vitest non garanti. |
| Lint | oxlint 1.91 | ESLint mettait plusieurs minutes par fichier sur le poste de dev ; oxlint couvre les règles React, hooks, a11y, Next, import, Vitest en natif (0,5 s pour le dépôt). |
| Multi-comptes : unité d'exécution | un runner par serveur, un serveur par espace et par personne | Une connexion Claude n'est jamais partagée (conditions d'Anthropic) ; isolation par conteneur, disque et HOME. |
| Cloisonnement côté base | contexte de requête + gardes de portée côté web ; filtre `environment_id` dans chaque requête du runner ; rôle restreint + RLS pour les runners | Défense en profondeur : une session Claude peut lire l'environnement du runner, donc son DSN. |
| Identité d'un runner | empreinte du jeton, enregistrée par le web (ou `migrate`) ; attente tant qu'inconnu | Un runner ne revendique jamais une ligne ; un `.env` copié ne sert jamais deux serveurs (bail, marqueurs). |
| Horloge des vérifications d'intégrations | planificateur web, verrou consultatif par espace | Les identifiants d'intégration sont dans le web ; un runner restreint n'y a pas accès. |
| Réglages | quatre portées (instance, serveur, espace, compte) | Ce qu'un administrateur fixe pour l'instance ne se confond pas avec les choix d'un espace ou d'une personne. |
| Notifications | une ligne par destinataire, canal web par compte | Lecture, compte et push propres à chaque compte, même pour un événement d'espace. |
| Espaces partagés, sélecteur de comptes, transfert de propriété | hors v1 | `space_members` et `spaces.kind` les préparent ; un compte par profil de navigateur en attendant. |
