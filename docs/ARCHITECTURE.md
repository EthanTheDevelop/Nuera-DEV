# Nuera Dev — Architecture

> Référence d'implémentation. Les maquettes Figma (`docs/figma/*`) font autorité pour le visuel et les parcours ;
> ce document fixe les choix techniques, les contrats entre modules et les règles de sécurité.
> Les arbitrages sont tracés en fin de document (§14).

## 1. Principes non négociables

| # | Principe | Conséquence technique |
|---|---|---|
| P1 | Aucune API de chat privée sur l'abonnement Max (Figma `241:6085`). | Chaque session est un processus **interactif** du CLI officiel `claude`, non modifié, dans un PTY (tmux en production). La vue *Conversation* est une mise en forme des signaux officiels (hooks, journal de session) ; la vue *Terminal brut* est le TUI lui-même. Jamais de `claude -p`, de `stream-json`, d'Agent SDK `query()` ni de `CLAUDE_CODE_OAUTH_TOKEN`. |
| P2 | Aucun formulaire de jeton Claude (Figma `241:6089`). | La connexion Claude passe par `claude auth login` lancé dans un terminal web éphémère (non enregistré). Nuera Dev ne lit jamais `~/.claude/.credentials.json` ni les champs de compte de `~/.claude.json`. |
| P3 | Aucune métrique de coût/quota/jetons inventée (Figma `241:6093`). | On n'affiche que ce que le CLI expose (statut `auth status --json`, JSON de la *status line* : `rate_limits`, contexte, modèle). « Capacité » = capacité **serveur** (sessions parallèles, CPU/RAM). |
| P4 | Aucune action de production Coolify à portée de Claude (Figma `241:6097`). | Le serveur MCP Coolify reçoit un jeton restreint à un périmètre de développement ; l'UI n'expose aucune action de production. |
| S1 | Le backend web n'est pas un shell privilégié. | Git, terminaux, processus et Claude passent par le **runner** (service séparé, non-root, réseau privé, chemins autorisés, limites de ressources, journalisation). |
| S2 | Rien n'est faux. | Aucun mock permanent, aucun faux « connecté », aucun bouton mort. Les fixtures n'existent que dans les tests. |

## 2. Topologie

```
 Navigateur (bureau / téléphone, PWA)
      │ HTTPS — cookies de session Better Auth (Secure, HttpOnly, SameSite=Lax), vérification d'Origin
      ▼
 apps/web — Next.js 16 (App Router, standalone)           ← seul service exposé (dev.nuera.studio)
      │  • UI, Server Components, Server Actions, Route Handlers
      │  • Auth (Better Auth + 2FA TOTP + passkeys), audit, chiffrement des secrets
      │  • Intégrations distantes : GitHub App (Octokit), Coolify API, Web Push
      │  • Proxy SSE/HTTP vers le runner (jamais exposé)
      │ HTTP privé + Bearer RUNNER_TOKEN (réseau Docker interne / 127.0.0.1 en dev)
      ▼
 apps/runner — service Node/TypeScript (Fastify)          ← non exposé, utilisateur `nuera` non-root
      │  • Git (execFile, sans shell), worktrees, fichiers (lecture), diff
      │  • Terminaux PTY (@lydell/node-pty) + miroir @xterm/headless (reprise d'écran)
      │  • Sessions Claude : tmux (Linux) ou PTY direct (dev Windows), hooks, status line
      │  • Processus du projet (install/dev/build/test), métriques système, disponibilité
      │  • Bus d'événements → SSE ; persistance de son état d'exécution en base
      ▼
 PostgreSQL 17 (service distinct, non exposé)   Volumes persistants : /srv/dev (clones + worktrees),
                                                /data (runtime, logs), /home/nuera (~/.claude du CLI)
```

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
  (auth)/                      connexion, configuration initiale, 2FA
  (shell)/                     pages avec barre latérale 248 px / barre d'onglets mobile
  (workspace)/workspace/[sessionId]   rail 72 px, pas de barre d'onglets
  api/                         route handlers (SSE, webhooks GitHub setup, auth, actions JSON)
src/components/ui/             primitives du design system (Button, Badge, Card/Tile, Field, Switch, Tabs, Dialog,
                               Drawer, Sheet, Toast, Banner, Skeleton, EmptyState, StatusDot, Icon…)
src/components/shell/          Sidebar, SidebarRail, TabBar, CommandPalette, ServerCard, UserCard, états globaux T5/T6
src/features/<domaine>/        composants et hooks client propres à un domaine (home, projects, workspace, sessions,
                               integrations, settings)
src/server/                    code serveur uniquement (`import 'server-only'`)
  auth/                        Better Auth, getSession/requireUser, garde 2FA
  security/                    origin/CSRF, rate limit, chiffrement AES-256-GCM, audit
  runner/                      client typé du runner (contrats @nuera/shared)
  github/                      GitHub App (manifest, installations, jetons), Octokit
  coolify/ figma/ mcp/ push/   intégrations
  <domaine>/                   services métier (projects, sessions, settings, notifications…) — seuls à toucher la DB
src/lib/                       utilitaires isomorphes (format FR, cn, zod helpers)
```

Règles : les pages lisent via les services serveur (Server Components) ; les mutations passent par Server Actions
(formulaires) ou route handlers `POST` validés Zod ; toute mutation vérifie la session **et** journalise si sensible.

## 5. Données (PostgreSQL + Drizzle)

Schéma dans `packages/db/src/schema/*.ts`, migrations versionnées dans `packages/db/drizzle/`.
Tables Better Auth : `user`, `session`, `account`, `verification`, `two_factor`, `passkey`.

| Table | Rôle | Écrite par |
|---|---|---|
| `app_settings` | ligne unique : limites (sessions parallèles), modèle/mode par défaut, blocage du mode sans autorisation, délai de réponse aux autorisations, durées des accès web, racine des projets, libellés serveur, préférences | web |
| `integrations` | GitHub App, Coolify, Figma… : statut, config non secrète, secrets chiffrés, dernière vérification, expiration | web (+ runner pour les vérifications planifiées via API web) |
| `mcp_servers`, `project_mcp_servers` | registre MCP (transport, URL/commande, en-têtes/env chiffrés, statut, diagnostic) et activation par projet | web |
| `projects`, `project_env_vars` | dépôts suivis (GitHub, chemin, branches, commandes, options, favori, archivage) ; variables (valeurs chiffrées) | web (+ runner : synchro) |
| `worktrees` | worktrees Git par projet (nom, branche, chemin, état) | runner |
| `sessions`, `session_events`, `permission_requests` | sessions Claude, flux normalisé (instructions, messages, outils, plan, autorisations, statuts), demandes d'autorisation | runner (web : titre, archivage, décisions) |
| `operations` | opérations longues (clone, pull, push, commit, worktree, PR…) avec progression et journal | runner / web |
| `command_runs` | lancements install/dev/build/test (statut, sortie, résumé, port) | runner |
| `pull_requests` | PR créées/suivies | web |
| `notifications`, `push_subscriptions` | centre de notifications et abonnements Web Push | web / runner |
| `audit_log` | journal de sécurité et actions sensibles | web / runner |
| `uptime_daily` | disponibilité par jour et par service (minutes vues/attendues, incidents) | runner |

Statuts de session (`sessions.status`) : `new` (W1, avant la 1re instruction), `running`, `waiting_permission`,
`waiting_input` (tour terminé, attend une instruction), `stopped` (arrêtée par l'utilisateur), `interrupted`
(processus disparu : redémarrage, crash), `failed`, `finished` (fin propre du processus), `archived`.
« Reprise possible » est calculé : worktree présent **et** conversation enregistrée.

## 6. Runner : contrat

Toutes les routes exigent `Authorization: Bearer ${RUNNER_TOKEN}` (comparaison à temps constant) et valident leurs
entrées avec les schémas Zod de `@nuera/shared/runner`. Erreurs : `{ error: { code, message, detail?, raw? } }`
(`raw` = sortie brute de la commande, affichée « à un clic » — règle T4).

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
| Hooks (écoute 127.0.0.1 uniquement) | `POST /internal/hooks/:sessionToken` — appelé par `bin/nuera-hook.mjs` ; `POST /internal/statusline/:sessionToken` |

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
  Refuser — clics authentifiés, journalisés) pendant `app_settings.permissionWaitSeconds` ; sans réponse il rend la
  main et le dialogue officiel s'affiche dans le terminal (« Répondre dans le terminal »). Jamais d'auto-approbation,
  `bypassPermissions` bloqué par défaut.
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

GitHub App créée par le **flux manifest** depuis Intégrations (aucun jeton saisi) : conversion du code
(`POST /app-manifests/{code}/conversions`) → identifiants stockés chiffrés → installation sur les dépôts choisis →
jetons d'installation (1 h, **réduits par opération et par dépôt**, en mémoire uniquement) pour l'API (Octokit,
`X-GitHub-Api-Version: 2026-03-10`) et pour Git (en-tête injecté par processus, cf. §6). Permissions : `contents: write`,
`pull_requests: write`, `metadata: read`, `checks: read`, `statuses: read`, `issues: read`. L'application est publique
si elle doit être installée sur plusieurs comptes (organisation + compte personnel). Repli documenté (non proposé dans
l'UI) : PAT à granularité fine via variable d'environnement. `GITHUB_API_URL` surchargeable (tests).
Détail : `docs/research/integrations.md` §2.

## 9. Sécurité

* **Auth** : Better Auth (e-mail + mot de passe, TOTP obligatoire + codes de secours, passkeys en option).
  Création du compte propriétaire unique via `/configuration` protégée par `SETUP_TOKEN` ; inscription fermée ensuite.
  Accès web : expiration après 12 h d'inactivité et au plus 30 jours (réglables), liste et révocation dans Paramètres.
* **Requêtes** : `proxy.ts` redirige les visiteurs non authentifiés ; chaque route/action revérifie la session côté
  serveur (`requireUser()`), exige la 2FA validée ; mutations : vérification d'`Origin`/`Host` (CSRF) + SameSite=Lax.
* **Abus** : limitation de débit (auth via Better Auth ; routes sensibles via limiteur mémoire par IP/utilisateur).
* **Secrets** : AES-256-GCM (`APP_ENCRYPTION_KEY`, identifiant de clé préfixé pour rotation) ; jamais renvoyés au
  navigateur (affichage masqué, révélation explicite journalisée pour les variables non secrètes uniquement).
* **Audit** : connexions, 2FA, révocations, décisions d'autorisation, push/PR, suppression de worktree, archivage,
  changements d'intégration, redémarrages.
* **En-têtes** : CSP stricte, `frame-ancestors 'none'`, HSTS en prod, `Referrer-Policy`, `Permissions-Policy`.

## 10. Temps réel

SSE de bout en bout (`text/event-stream`, battement toutes les 15 s, `X-Accel-Buffering: no`) : le navigateur
s'abonne à `/api/stream/events` (global), `/api/stream/sessions/[id]` (conversation + statut),
`/api/stream/terminals/[id]` (octets du PTY). Les route handlers authentifient puis relaient le flux du runner.
Saisie terminal : `POST` groupés (≈10 ms). Reconnexion automatique avec `Last-Event-ID` ; W7 « Connexion perdue »
quand le flux tombe alors que la session continue côté serveur ; T5 quand le runner/serveur ne répond plus.

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

## 13. Déploiement (détail : `docs/DEPLOY.md`)

Coolify (VPS-1) déploie sur VPS-3 un *Docker Compose* : `web` (Next standalone, port 3000, healthcheck
`/api/health`), `runner` (non-root `nuera`, tmux, git, CLI Claude officiel, healthcheck interne), réseau interne ;
PostgreSQL = ressource Coolify distincte, non exposée. Volumes : `/srv/dev`, `/data`, `/home/nuera`. Domaine
`dev.nuera.studio` (HTTPS par Coolify/Traefik). Sauvegardes : `deploy/scripts/backup-db.sh` / `restore-db.sh`.

## 14. Arbitrages

| Sujet | Décision | Raison |
|---|---|---|
| Persistance des sessions | tmux + `claude --resume` (Figma V3) plutôt que `claude --bg` | Figma l'exige ; documenté par Anthropic pour les machines distantes ; contrôle total du PTY ; `--bg` (+ `--session-id`, `--remote-control`) reste à vérifier sur la version du VPS. |
| Vue Conversation | Hooks officiels + lecture tolérante du journal | Pas d'API de chat (P1) ; repli Terminal brut. |
| Réponse aux autorisations | Hook `PermissionRequest` synchrone borné | Capacité officielle ; ne contourne pas le mode de permission ; repli terminal. |
| WebSocket vs SSE | SSE + POST | Natif dans les route handlers Next, traverse Traefik sans configuration. |
| Bouton destructif | Variante `Accent` comme dans Figma (+ prop `tone="danger"` prête) | Lacune 1 du design system. |
| Postgres local | `embedded-postgres` (pas de Docker sur le poste) + `docker-compose.dev.yml` fourni | Reproductible sur Windows/macOS/Linux. |
| TypeScript | 6.0.x | typescript-eslint ne supporte pas encore TS 7 (natif). |
