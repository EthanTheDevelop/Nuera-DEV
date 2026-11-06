# @nuera/runner — moteur d'exécution de Nuera Dev

Service Fastify privé (jamais exposé à Internet) : seul composant qui touche au disque des projets, à Git, aux PTY,
aux sessions du CLI officiel Claude Code et aux processus des projets. **Un runner = un serveur** (ligne
`environments`, « serveur » dans l'interface, `docs/MULTICOMPTE.md` §4) : il ne voit, ne liste et ne reprend que les
projets, worktrees, sessions, opérations et lancements de **son** serveur. Le web l'appelle avec
`Authorization: Bearer <jeton du serveur>` (`RUNNER_TOKEN` pour le serveur par défaut) et relaie ses flux SSE au
navigateur (`/api/stream/*`).

```bash
pnpm --filter @nuera/runner dev        # tsx watch (charge le .env racine en dev)
pnpm --filter @nuera/runner build      # dist/index.mjs (esbuild, dépendances externes)
pnpm --filter @nuera/runner test       # vitest : vrais dépôts, vrais PTY, faux CLI de test
pnpm --filter @nuera/runner typecheck
```

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `RUNNER_HOST` / `RUNNER_PORT` | `127.0.0.1` / `4100` | API privée (réseau Docker interne en production). |
| `RUNNER_HOOK_PORT` | `4101` | Écoute des hooks / status line / headersHelper, **toujours 127.0.0.1**. |
| `RUNNER_TOKEN` | — (≥ 16 car.) | Jeton **du serveur** (format `nrt_…` pour les nouveaux, l'ancien reste accepté) : web ⇄ runner dans les deux sens, comparaison à temps constant. Le runner trouve son serveur par `sha256(RUNNER_TOKEN)` dans `environments.token_hash` (ou `next_token_hash` pendant une rotation). |
| `RUNNER_DATABASE_URL` | — | DSN du **rôle restreint** du serveur (affiché une fois par l'administration) ; prioritaire sur `DATABASE_URL`. |
| `DATABASE_URL` | — | DSN complet (serveur par défaut tant qu'il n'est pas restreint). Tables écrites : worktrees, sessions, session_events, permission_requests, operations, command_runs, uptime_daily ; projects pour la synchro ; `environments` (battement seulement). |
| `NUERA_DB_POOL_MAX` | `5` | Connexions du pool principal (+ 1 connexion dédiée au bail). |
| `NUERA_ENVIRONMENT_ID` | — | Assertion facultative : identifiant attendu du serveur. Différent de celui que désigne le jeton → arrêt (« NUERA_ENVIRONMENT_ID ne correspond pas au serveur de ce jeton : vérifiez la configuration du runner. »). |
| `NUERA_CLAUDE_CONFIG_DIR` | — | Dev, tests, plusieurs runners sur une machine : `CLAUDE_CONFIG_DIR` de **tous** les processus `claude` du runner (sessions, `auth status`, connexion, `mcp …`, terminal /status ; aussi les terminaux de shell et les commandes du projet, pour un `claude` tapé à la main) et racine des journaux acceptés. Non défini en production (HOME propre au conteneur). |
| `NUERA_ENV_FILE` | — | Dev : fichier lu **avant** le `.env` racine (ses valeurs l'emportent), pour un second runner. |
| `APP_URL` | `http://localhost:3000` | Web, pour les rappels `/api/internal/*` (`NUERA_WEB_INTERNAL_URL` pour une URL interne différente). |
| `NUERA_PROJECTS_ROOT` | `./.data/projects` | Racine des clones et worktrees (prod : `/srv/dev`). Chemins relatifs = relatifs à la racine du dépôt. |
| `NUERA_DATA_DIR` | `./.data/runner` | Fichiers d'exécution (réglages de session, tmux.conf, dossiers de travail du CLI). |
| `NUERA_SESSION_BACKEND` | auto | `tmux` (prod Linux), `pty` (dev Windows), vide = tmux si `tmux -V` répond. |
| `NUERA_TMUX_SOCKET` | `nuera` (serveur par défaut), `nuera-<8 premiers caractères hexadécimaux de l'id du serveur>` (autres serveurs) | Nom du socket tmux (`tmux -L <nom>`). Par défaut, chaque serveur a le sien : deux runners sous le même utilisateur Linux ne partagent pas de serveur tmux. Le serveur par défaut garde `nuera` (ses sessions déjà lancées sont retrouvées après la mise à jour). Une session tmux n'est rattachée ou adoptée que si son `NUERA_SESSION_ID` est l'id de la ligne. |
| `NUERA_CLAUDE_BIN` | `claude` du `PATH` | Binaire officiel. Un chemin `.mjs` est lancé avec Node : **réservé aux tests** (faux CLI). |
| `NUERA_GIT_REMOTE_BASE` | `https://github.com/` | Base des URL Git (`<base><owner>/<repo>.git`). Les tests pointent vers des dépôts nus locaux. |
| `NUERA_SCHEDULER` | `1` (hors tests) | Tâches périodiques (disponibilité, fetch). Le battement du serveur tourne même à `0`. |
| `NUERA_AUTO_RESUME_MARGIN_SECONDS` | `120` | Reprise automatique après la limite d'utilisation : délai après l'heure de levée annoncée par le CLI (la pile de test met `2`). |
| `NUERA_AUTO_RESUME_RETRY_SECONDS` | `1800` | Levée inconnue : intervalle entre deux essais (pendant 6 h au plus). |
| `LOG_LEVEL` | `info` | pino (en-têtes d'autorisation et jetons masqués). |

En développement, le `.env` de la racine (précédé de `NUERA_ENV_FILE` s'il est défini) est chargé sans écraser les
variables déjà présentes dans le shell.

## Identité, attente, bail, marqueurs

Démarrage (`src/app.ts`, `src/environment.ts`) : écoute des hooks → recherche du serveur par l'empreinte du jeton
(colonnes explicites, jamais `token_encrypted`) → **attente** si le jeton est inconnu ou le serveur retiré → **bail
exclusif** → **marqueurs** → reprise limitée à son serveur → écoute API → planificateur.

- **Attente (standby)** : `GET /v1/health` répond (`state: 'unregistered'`, `environment: null`), toute autre route
  répond 503 `ENVIRONMENT_UNREGISTERED` « Ce runner n'est rattaché à aucun serveur. Enregistrez-le depuis
  Administration, rubrique Serveurs (empreinte du jeton : 3f9a1c2e). » ; nouvel essai toutes les 15 s, rien n'est
  repris ni écrit. Un runner ne revendique jamais une ligne : seul le web (ou `migrate` pour le serveur par défaut)
  enregistre l'empreinte. Un serveur retiré pendant le service (ou un jeton révoqué) ramène le runner en attente
  sans rien arrêter.
- **Bail** : `pg_try_advisory_lock(hashtextextended('nuera:environment:' || id, 0))` sur une connexion **dédiée**
  (réservée : ni le délai d'inactivité ni la durée de vie du pool ne la recyclent). Un rôle restreint ne peut prendre
  aucun verrou consultatif depuis la migration `0005` : il appelle `nuera_runner_try_lease()` (même clé, celle de son
  seul serveur) et `nuera_runner_release_lease()` ; contre une base pas encore en `0005`, il garde l'appel direct.
  Refusé : 503 « Un autre runner du
  serveur « <nom> » est encore actif : attente de son arrêt… » et nouvel essai (chevauchement d'un redéploiement
  Coolify, `.env` copié, deux terminaux). PostgreSQL libère le verrou quand la connexion meurt ; si le runner la perd,
  il s'arrête (jamais deux runners pour un serveur). Pendant les tâches de reprise : 503 « Le runner du serveur
  « <nom> » démarre : réessayez dans un instant. ». Ces deux 503 portent la raison `ENVIRONMENT_STARTING`.
- **Marqueurs** `.nuera-environment` (JSON `{ environmentId, name, createdAt }`) dans `NUERA_DATA_DIR` et
  `NUERA_PROJECTS_ROOT`, écrits au premier démarrage. Un dossier qui porte un autre serveur arrête le runner :
  « Le dossier de données <chemin> appartient au serveur « <nom> » : donnez un dossier propre à ce runner
  (NUERA_DATA_DIR). » (idem « Le dossier des projets … (NUERA_PROJECTS_ROOT). »). Après une base recréée en
  développement (nouvel identifiant de serveur), supprimer ces deux fichiers (ou les dossiers).
- **Statuts** : `suspended` (compte désactivé) → `state: 'disabled'`, refus 403 `ENVIRONMENT_DISABLED` « Ce serveur est
  désactivé : aucune nouvelle session, aucun clonage ni aucune commande ne peut démarrer. » pour la création, le
  démarrage et la reprise de session, le clonage, la création de worktree, les lancements et les terminaux de shell ;
  lecture et arrêt restent possibles. `retired` → attente (ci-dessus).
- **Réglages lus** : sa ligne `environments` (sessions simultanées, plafond mémoire), relue au plus toutes les 15 s et
  à chaque battement ; une valeur des options de lancement (web plus ancien, `launch.json` antérieur au serveur) ne
  peut être que plus stricte. Les politiques de session arrivent dans les options de lancement (`blockBypassPermissions`,
  `permissionWaitSeconds`, `gitIdentity`, champs **facultatifs** de `launch.json`) ; absentes : mode sans
  autorisation bloqué, attente de 120 s. De `app_settings`, seul `force_block_bypass_permissions` (instance) est lu ; illisible, il compte comme actif (refus par
  précaution).
- **Battement** (60 s, indépendant du planificateur : il tourne aussi avec `NUERA_SCHEDULER=0`) : `last_seen_at`,
  `runner_version`, `contract_version`, `backend`, `capabilities` (hôte, plateforme, versions de Claude/Git/tmux,
  `database: { role, restricted }`) ; jamais `status`. Une relecture qui trouve le jeton sur la ligne d'un autre
  serveur (ou de plusieurs) arrête le runner, comme au démarrage.
  `restricted: false` = le serveur se connecte encore en superutilisateur ou propriétaire des tables
  (l'administration affiche « Le serveur … accède encore à toute la base de données. »). Cette colonne est écrite par
  le runner : le web ne la croit que si `pg_roles` et `pg_stat_activity` la confirment
  (`apps/web/src/server/admin/db-access.ts`).
- **Contrat** : `/v1/health` expose `environment { id, name }`, `state` (`ready` · `starting` · `unregistered` ·
  `disabled`) et `contractVersion` (`RUNNER_CONTRACT_VERSION`, 2).

### Rôle PostgreSQL restreint

Un serveur enregistré par l'administration reçoit un rôle de connexion `nuera_env_<8 hex>` membre de `nuera_runner`
(migration `0004_runner_roles`, `environments.db_role`) : droits sur les seules tables du runner, colonnes
explicites sur `environments`/`projects`/`app_settings`, **RLS** par serveur (`nuera_runner_environment_id()`), aucun
accès aux comptes, invitations, sources GitHub, intégrations, MCP, variables, notifications, push ni journal. Le
runner ne supprime jamais une ligne. Toute nouvelle table touchée par le runner doit porter son `GRANT` et sa
politique (sinon `test/restricted.test.ts` échoue). Le serveur par défaut garde son DSN complet tant que
l'administrateur ne lui donne pas `RUNNER_DATABASE_URL`.

### Plusieurs runners sur un poste Windows (développement)

Le second runner a son propre jeton, ses ports, ses dossiers et son dossier Claude (une connexion Claude par
serveur). Fichier `.env.runner-b` à la racine (non versionné, comme `.env`) :

```dotenv
RUNNER_TOKEN=nrt_…            # jeton affiché par Administration › Serveurs
RUNNER_DATABASE_URL=postgres://nuera_env_…:…@127.0.0.1:54329/nuera   # DSN affiché (facultatif en dev)
RUNNER_PORT=4110
RUNNER_HOOK_PORT=4111
NUERA_PROJECTS_ROOT=./.data/envs/b/projects
NUERA_DATA_DIR=./.data/envs/b/runner
NUERA_CLAUDE_CONFIG_DIR=./.data/envs/b/claude
```

```powershell
$env:NUERA_ENV_FILE = '.env.runner-b'; pnpm --filter @nuera/runner dev
```

(Git Bash : `NUERA_ENV_FILE=.env.runner-b pnpm --filter @nuera/runner dev`.) URL à enregistrer pour ce serveur :
`http://127.0.0.1:4110`. Le backend PTY s'applique (pas de tmux sous Windows) ; deux runners ne partagent jamais un
dossier (marqueurs) ni un serveur (bail). Se connecter à Claude pour ce serveur depuis son terminal « Connexion à
Claude » (le `CLAUDE_CONFIG_DIR` injecté isole la connexion du `%USERPROFILE%\.claude` du poste).

## Routes (`/v1`, contrat partagé `@nuera/shared/runner` → `RUNNER_ROUTES`)

Toutes exigent le Bearer et valident leurs entrées avec Zod. **Cloisonnement** : toute recherche par identifiant
(projet, worktree, session, autorisation via sa session, opération, lancement) porte `environment_id = <son serveur>`
**dans la requête** ; un identifiant d'un autre serveur reçoit exactement la réponse d'un identifiant inconnu (même
404, même message), avant toute écriture. Chaque insertion porte `environment_id`. Erreurs uniformes :
`{ error: { code, message, detail?, raw?, untouched?, reason?, data? } }` — `raw` = sortie brute masquée (règle T4),
`untouched` = ce qui n'a pas été touché, `reason` = sous-code machine (`DESTINATION_NOT_EMPTY`, `PULL_DIVERGED`,
`WORKTREE_DIRTY`, `CAPACITY_REACHED`…).

| Domaine | Routes |
|---|---|
| Système | `GET /health` (seule route servie en attente), `GET /system/metrics`, `GET /system/uptime?days=` |
| Événements | `GET /events` (SSE global), `POST /events/publish` (web → diffusion de `notification.created`) |
| Dépôts | `POST /repos/check-destination`, `POST /repos/clone` (opération async), `POST /repos/:projectId/fetch\|pull`, `GET …/status\|sync\|branches\|log`, `POST …/branches\|checkout` |
| Worktrees | `GET\|POST /repos/:projectId/worktrees`, `DELETE /worktrees/:id?force=&deleteBranch=&actorUserId=`, `DELETE /repos/:projectId/clone?actorUserId=`, `GET /worktrees/:id/status` |
| Changements | `GET /worktrees/:id/changes\|diff?path=\|ahead-behind`, `POST …/stage\|unstage\|commit\|push` |
| Fichiers | `GET /worktrees/:id/tree?path=\|file?path=`, `GET\|PUT /projects/:projectId/claude-md` |
| Opérations | `GET /operations/:id`, `GET /operations/:id/stream` (SSE) |
| Terminaux | `POST /terminals`, `GET /terminals`, `GET /terminals/:id`, `GET /terminals/:id/stream` (SSE), `POST …/input\|resize`, `DELETE /terminals/:id` |
| Sessions | `POST /sessions`, `GET /sessions`, `GET /sessions/:id`, `POST …/start\|resume\|instruction\|interrupt\|stop\|announce\|auto-resume`, `GET …/events?afterVersion=`, `GET …/stream` (SSE), `GET …/terminal`, `POST /permissions/:id/decision` |
| Processus | `POST /runs`, `GET /runs/:id`, `GET /runs/:id/stream` (SSE), `DELETE /runs/:id` |
| Aperçu | `<toute méthode> /runs/:id/preview/*` — relais brut vers le serveur de développement du lancement (hors `RUNNER_ROUTES`, contrat `RUNNER_PREVIEW_ROUTE`) |
| CLI Claude | `GET /claude/status?refresh=`, `POST /claude/mcp/sync`, `GET /claude/mcp/:name`, `GET /claude/config`, `POST /claude/config/sync` (configuration commune) |

Écoute locale (127.0.0.1:`RUNNER_HOOK_PORT`, jeton de session en Bearer) : `POST /internal/hooks/:sessionId`,
`POST /internal/statusline/:sessionId`, `POST /internal/mcp-headers/:sessionId`.

Rappels vers le web (Bearer = jeton du serveur, d'où le web déduit le serveur ; tolérés absents/injoignables ; 401/403
journalisés « Le web refuse le jeton de ce serveur … ») : `POST /api/internal/notify`, `/api/internal/mcp-headers`,
`/api/internal/git-credentials`, `/api/internal/claude-config`. Les vérifications d'intégrations sont cadencées par le web, plus par les runners.

## Flux SSE (`@nuera/shared/events`)

Chaque message est un événement SSE **par défaut** (`message`, pas de champ `event:`) dont `data` est l'enveloppe JSON
`{ seq, type, at, data }` ; `id:` porte `seq` (strictement croissant, base `Date.now() × 1000` pour rester monotone
entre deux démarrages). À parser avec `parseRunnerEvent()`. Battement `heartbeat` toutes les 15 s (vrai événement, sans
`id:`), `retry: 3000`.

- **Global** `/v1/events` : `session.status`, `session.permission`, `operation.progress`, `run.status`,
  `system.metrics` (toutes les 5 s tant qu'il y a un abonné), `claude.status`, `notification.created`.
- **Session** : `session.status` (instantané d'abord), `session.event` (éléments normalisés, upsert par `key`/`version`),
  `session.permission`.
- **Opération** : `operation.progress` (journal complet `log` au premier, puis `logAppend` + `liveLine`).
- **Run** : `run.status` puis `run.output` (`replay: true` = tampon de sortie au premier).
- **Terminal** : `terminal.snapshot` (écran + historique sérialisés par `@xterm/addon-serialize`), puis
  `terminal.data` / `terminal.resize` / `terminal.exit`. Pas de rejeu : chaque reconnexion reçoit un instantané.

`Last-Event-ID` : rejeu depuis un tampon circulaire ; impossible (redémarrage, tampon dépassé) → `stream.reset` (le
client recharge la ressource : `GET /sessions/:id/events`, `GET /operations/:id`). Le relais web ajoute
`stream.error` (`RUNNER_UNAVAILABLE`) quand le runner est injoignable.

## Modèle de sécurité

- **Jamais de shell**, sauf l'exception documentée de `src/runs/shell.ts` : les commandes **du projet** (install, dev,
  build, test, lint) saisies ou confirmées par le propriétaire. Git, tmux et le CLI Claude sont lancés avec un
  tableau d'arguments (`src/safety/exec.ts`), sortie plafonnée, délai, arrêt sur abandon.
- **Chemins confinés** par `realpath` (`@nuera/shared/paths` + `src/safety/paths.ts`) à `NUERA_PROJECTS_ROOT` et
  `NUERA_DATA_DIR` : `..`, chemins absolus, lettres de lecteur et liens symboliques sortants sont refusés ; `.git`
  n'est jamais servi.
- **Environnement nettoyé** pour tout enfant (`src/safety/env.ts`) : liste blanche (HOME, USER, PATH, LANG, TERM,
  proxies…) puis liste noire prioritaire (`ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`, `RUNNER_TOKEN`, `DATABASE_URL`,
  `RUNNER_DATABASE_URL`, `BETTER_AUTH_SECRET`, `APP_ENCRYPTION_KEY`, `SETUP_TOKEN`, `VAPID_*`, `GITHUB_*`, `GIT_*`,
  `NODE_OPTIONS`…). Valeurs **de confiance** injectées par le runner seul (`src/claude/env.ts`) : `CLAUDE_CONFIG_DIR`
  (`NUERA_CLAUDE_CONFIG_DIR`) pour tout processus `claude`, et `GIT_AUTHOR_NAME/EMAIL` + `GIT_COMMITTER_NAME/EMAIL`
  depuis `gitIdentity` (options de lancement d'une session, terminal de shell, lancement) ; le préfixe `GIT_` et
  `CLAUDE_CONFIG_DIR` restent refusés dans les variables libres.
- **Attribution** : `command_runs.actor_user_id` enregistré, `actorUserId` sur les opérations de suppression de
  worktree et de clone, `TerminalDto.ownerUserId` (compte qui a ouvert le terminal, pour que le web refuse à un autre
  compte de suivre une connexion Claude ou MCP).
- **Git** (`src/git/git.ts`) : `GIT_TERMINAL_PROMPT=0`, askpass qui refuse, configuration d'exécution par
  `GIT_CONFIG_COUNT/KEY/VALUE` (prioritaire sur `.git/config`, que Claude peut modifier) : assistants d'identification
  réinitialisés, hooks du dépôt désactivés (`core.hooksPath` vers un dossier vide, sauf `runHooks: true` explicite au
  commit), fsmonitor coupé, TLS vérifié ; pour le réseau : config système/globale ignorée, protocoles limités à
  HTTPS. `core.autocrlf=false` sur toutes les commandes (fidélité aux octets du dépôt, Git pour Windows compris ;
  `core.eol` n'est pas touché). Le jeton (fourni par le web, réduit au dépôt et à l'opération) n'existe que dans l'environnement du processus
  git, sous `http.https://github.com/.extraheader` — jamais dans une URL, l'argv, `.git/config` ni un magasin. Push et
  fetch visent l'URL explicite `https://github.com/<owner>/<repo>.git`, pas `origin`. Ces surcharges ne battent qu'une
  clé **de même nom** : avant toute commande réseau, `git config --list --show-scope -z` est lu et l'opération est
  refusée (`GIT_CONFIG_UNSAFE`, « Rien n'a été envoyé ni récupéré. ») si le dépôt définit `url.*` (réécriture
  `insteadOf`), `protocol.*`, une section `[remote "<url>"]` ou un réglage `http.*` hors liste sûre
  (`http.<url>.sslVerify`, proxy, CA…) ; chaque `protocol.<nom>.allow` est en outre figé. Le push vers la branche par
  défaut est toujours refusé (`BRANCH_PROTECTED`) : elle évolue par pull request.
- **Claude Code** : binaire officiel non modifié, en session interactive uniquement ; jamais `claude -p`,
  `stream-json`, `setup-token` ni `CLAUDE_CODE_OAUTH_TOKEN` ; `~/.claude/.credentials.json` et les champs de compte de
  `~/.claude.json` ne sont jamais lus. Le statut vient de `claude auth status --json` (champs filtrés).
- **Terminaux de connexion** (`claude auth login`, `claude mcp login`, `/status`) : sortie jamais journalisée ni
  enregistrée, historique effacé à la fermeture ; les octets de terminal ne sont jamais journalisés.
- Sorties renvoyées (journaux d'opérations, `raw`, sorties Bash stockées) passées dans `redactSecrets()`.

## Sessions Claude

1. `POST /sessions` crée le worktree (`<racine>/.worktrees/<slug>/<nom>`, branche depuis `origin/<base>`), la ligne
   `sessions` (statut `new`, Figma W1) et les fichiers d'exécution `NUERA_DATA_DIR/sessions/<id>/` :
   `settings.json` (hooks de tous les événements → `node bin/nuera-hook.mjs`, `statusLine` →
   `bin/nuera-statusline.mjs`, `disableClaudeAiConnectors`, `permissions.deny`), `mcp.json` (serveurs du projet ;
   `headersHelper: 'nuera'` remplacé par `bin/nuera-mcp-headers.mjs`), `launch.json` (options non secrètes).
2. Le CLI démarre au premier envoi (ou `start: true`) :
   `claude --session-id <uuid> --name <titre> --permission-mode <mode> [--model] [--effort] --settings <fichier>
   [--mcp-config <fichier> --strict-mcp-config] [--remote-control <nom>]`, avec `ENABLE_CLAUDEAI_MCP_SERVERS=false`,
   `NUERA_HOOK_URL`, `NUERA_SESSION_ID` et le jeton de hook (aléatoire par lancement, seule son empreinte SHA-256 est
   en base). Backend **tmux** : `tmux -L <socket> -f <data>/tmux.conf new-session -d -s nuera-<slug>-<worktree> -c <cwd>
   -e K=V … -- claude …` puis un client PTY `tmux attach` ; le jeton passe par un fichier 0600
   (`NUERA_HOOK_TOKEN_FILE`) pour ne jamais apparaître dans l'argv de tmux. Backend **pty** : PTY direct
   (`NUERA_HOOK_TOKEN` dans l'environnement). Le propriétaire peut s'attacher en SSH : `tmux -L <socket> attach -t <nom>`
   (`<socket>` : `NUERA_TMUX_SOCKET`, voir la table des variables).
3. **Instruction** : collage entre crochets (`ESC[200~ … ESC[201~`) puis Entrée, après le hook `SessionStart` et un
   court silence du terminal ; avant cela, l'instruction est mise en file (les instructions sont tapées une à une,
   dans l'ordre). Pendant une demande d'autorisation, l'envoi est refusé (409). Un seul lancement du CLI par session :
   un double envoi, ou `start` + instruction, rejoint le lancement en cours (jamais deux `claude --session-id`).
   **Interrompre** = Échap : Claude Code n'émet ensuite **aucun** hook (ni `Stop`, ni `PostToolUse` pour l'outil
   annulé), donc sans hook d'activité dans les 2,5 s le runner repasse la session en `waiting_input`, ajoute
   « Étape interrompue » et ferme les lignes d'outil restées en cours (`interrompu`) ; Échap ou Ctrl+C tapés dans le
   terminal brut d'une session font de même. **Arrêter** = Échap, `/exit`, puis arrêt du PTY/tmux.
   **Reprendre** = `claude --resume <id>` avec les mêmes options ; une conversation arrêtée avant toute instruction
   (pas encore de journal) redémarre simplement avec le même `--session-id`.
4. **Hooks → conversation** (`session_events`, positions = ordre d'affichage, versions = ordre de modification) :
   `UserPromptSubmit` → instruction (`source: nuera|terminal`) ; `PreToolUse`/`PostToolUse(Failure)` → lignes d'outil
   avec méta (Read « 212 lignes », Glob « 14 fichiers », Edit « +46 −12 », Bash commande + code + résultats de tests
   « 10 réussis · 3,2 s ») ; `TodoWrite` → plan `3 / 5` mis à jour sur place ; `Stop` → message final
   (`last_assistant_message`, dédoublonné avec le journal) ; `StopFailure` → erreur (+ T6 si authentification) ;
   `Notification`, sous-agents, compaction, `SessionStart` (`transcript_path` validé sous `<CLAUDE_CONFIG_DIR>/projects`,
   le même dossier que celui du CLI) et
   `SessionEnd`. Le journal `transcript_path` est lu de façon tolérante pour les textes intermédiaires de Claude
   (formes inconnues ignorées, rien n'est inventé) ; ses lectures périodiques prennent la file de la session, comme
   les hooks. À la fin d'un tour, une ligne d'outil restée en cours est fermée sans méta (ou « refusé » si elle
   attendait une autorisation répondue dans le terminal).
5. **Autorisations** : `PermissionRequest` crée la demande (titre français par outil, cible, explication,
   suggestions « Toujours pour … » du CLI), passe la session en `waiting_permission`, prévient le web
   (`/api/internal/notify`, lien `/workspace/<id>`) et **attend** au plus `permissionWaitSeconds` une décision
   `POST /permissions/:id/decision`. Réponse rendue au CLI au format officiel
   `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"|"deny",…}}}`
   (« Toujours » = `updatedPermissions` = suggestions du CLI telles quelles). Sans réponse : statut
   `answered_in_terminal`, aucune sortie, le dialogue officiel s'affiche dans le terminal. Jamais d'auto-approbation.
6. **Status line** : le JSON officiel est filtré et stocké dans `sessions.cli_status` (modèle, contexte %,
   `rate_limits`), sans estimation ni coût.
7. **Garde-fous** : plafond de sessions simultanées (`environments.max_concurrent_sessions` du serveur ; une valeur
   de la requête ne peut que l'abaisser), une session vivante par worktree, plafond mémoire optionnel par arbre de
   processus (`pidusage`, le plus strict de la requête et de `environments.session_memory_limit_mb`), `nice 10` sous Linux, mode `bypassPermissions` refusé sauf
   `blockBypassPermissions: false` dans les options de lancement **et** `app_settings.force_block_bypass_permissions`
   inactif. `gitIdentity` des options signe les commits de Claude (gardée à la reprise si la requête n'en donne pas).
8. **Démarrage** : réattache les sessions tmux `nuera-*` encore vivantes **de son serveur**, passe ses autres
   sessions vivantes en `interrupted` (« reprise possible » si worktree et conversation existent), échoue ses
   opérations et lancements interrompus. Une session tmux dont la ligne appartient à un autre serveur (socket partagé
   par erreur) n'est jamais adoptée : elle reste en place, journalisée comme orpheline.
   **Arrêt** : les sessions tmux continuent ; les sessions PTY directes passent `interrupted`.

9. **Limite d'utilisation de l'abonnement** (`src/sessions/usage-limit.ts`) : reconnue seulement par ce que le CLI
   expose — `StopFailure` `error: rate_limit`, son avis écrit dans le journal (bloc `isApiErrorMessage`, modèle
   `<synthetic>`) ou affiché (« 5-hour limit reached ∙ resets 3pm »), `rate_limits.*.resets_at` de la status line.
   Un message de Claude qui parle de limites n'en est pas une. `sessions.usage_limit` garde l'arrêt (`active`, heure
   de levée, source, fenêtre, avis du CLI masqué) et le calendrier de la reprise (`autoResume`) ; `errorMessage` dit
   « Limite d'utilisation atteinte : reprise automatique à 15 h 02. » / « … : levée à 15 h 00. » / « Limite
   d'utilisation atteinte. ». **Reprise automatique** (option `launch.autoResume`, valeur effective calculée par le
   web, absente = désactivée) : levée + `NUERA_AUTO_RESUME_MARGIN_SECONDS`, 5 tentatives au plus ; levée inconnue :
   un essai toutes les 30 min pendant 6 h ; l'instruction de reprise est tapée dans le CLI vivant, ou la conversation
   est reprise (`claude --resume`) si le CLI a disparu (redémarrage du runner : minuteries réarmées depuis la base).
   La tentative est écrite avant d'être tapée ; capacité atteinte ou autorisation en attente : nouvel essai 5 min plus
   tard ; worktree, conversation ou CLI absents : abandon. Annulée par une instruction du propriétaire (Nuera Dev ou
   terminal brut), un arrêt, un archivage, `POST /sessions/:id/auto-resume { enabled: false }`. Notifications
   `session_usage_limit` (une par arrêt) et `session_auto_resumed`.

Confiance du dossier : le CLI retient ses hooks tant que le dialogue de confiance n'est pas accepté. Accepter une
fois la confiance pour `NUERA_PROJECTS_ROOT` (terminal `claude` dans ce dossier) évite le dialogue pour chaque
worktree ; sinon la session affiche « Action requise dans le terminal » et l'instruction attend en file.

## Configuration Claude commune (lot K1)

`src/claude/common-config.ts` (`CommonConfigSync`) écrit sur ce serveur la configuration commune de l'instance qui
s'applique au compte de son espace (`docs/MULTICOMPTE.md` §14, lot K1). Le runner ne lit aucune table de cette
configuration : il la demande au web (`POST /api/internal/claude-config`, jeton du serveur, `{ have: [{ name, hash }] }`
— les fichiers des skills inchangés sont omis) :

- **quand** : au démarrage (après le bail), à `POST /v1/claude/config/sync` (le web l'appelle après chaque
  modification et sur « Synchroniser les serveurs »), et avant de lancer une session dont `launch.commonConfig.hash`
  diffère de sa copie. Une synchronisation à la fois ; un échec (web injoignable, réponse illisible, dossier non
  inscriptible) garde la copie précédente et ne bloque jamais un lancement. `GET /v1/claude/config` : révision, date,
  skills écrits, conflits, erreur (`<NUERA_DATA_DIR>/claude-commun/state.json`, relu après un redémarrage) ;
- **quoi** (dossier Claude = `NUERA_CLAUDE_CONFIG_DIR`, sinon `~/.claude`) :
  - `skills/<nom>/` + marqueur `.nuera-commun.json` : nouvelle version écrite dans `skills/.nuera-tmp-*` puis deux
    renommages (l'ancien dossier part en `.nuera-old-*`, supprimé ensuite ; restes nettoyés à la synchronisation
    suivante) ; un dossier marqué qui ne s'applique plus est supprimé ; un dossier **sans** marqueur (skill du compte)
    n'est jamais touché (conflit) ; fichiers 0444, scripts autorisés 0555 ; `skills/` qui serait un lien : refusé ;
  - `rules/nuera-commun.md` : règles « Par défaut » (mémoire de niveau utilisateur du CLI) ;
  - `<NUERA_DATA_DIR>/claude-commun/regles-imposees.md` : règles « Imposé », passées à chaque lancement et reprise par
    `--append-system-prompt-file` ;
  - jamais `.credentials.json`, `.claude.json`, `settings.json` ni un autre fichier de `rules/` (`assertManagedTarget`) ;
    sans skill à écrire ni dossier `skills/`, rien n'est créé.
- **options de lancement** (champs facultatifs, contrat 2) : `allowRules`, `askRules` (avec `denyRules` →
  `permissions` du `--settings` de la session), `settingsEnv` (variables « Imposé » → `env` du `--settings`, mêmes noms
  refusés que `env`), `commonConfig { hash, revision }`. Gardés dans `launch.json` (repris après un redémarrage).
- **palette « / »** : un skill dont le dossier porte le marqueur est listé avec `source: 'common'` (« commun »).

## Processus du projet et système

- `POST /runs` : commande du projet dans un PTY (couleurs conservées), détection de port (« port 3000 »), lecture
  des résultats Vitest / Jest / Playwright / node:test en direct (« 10 / 10 réussis »), ligne `command_runs`.
- **Aperçu** (`src/preview/proxy.ts`) : `/v1/runs/:runId/preview/<chemin>` relaie toute méthode
  (`GET HEAD POST PUT PATCH DELETE OPTIONS`) vers `127.0.0.1` (sinon `::1`) **au port détecté de ce lancement**, qui
  doit être un `dev` vivant de ce serveur (`PREVIEW_NOT_DEV`, `PREVIEW_NOT_RUNNING`, `PREVIEW_NO_PORT`, 404 pour un
  inconnu, 502 `PREVIEW_UNREACHABLE`) ; aucun analyseur de corps (flux bruts dans les deux sens, 10 Mo / 256 Mo,
  60 s sans octet, 10 min par échange) ; en-têtes hop-by-hop, `Authorization` du saut, `X-Forwarded-*`, `x-nuera-*`
  et cookies de Nuera Dev retirés ; `Host: localhost:<port>`, `Origin`/`Referer` réécrits, `Accept-Encoding:
  identity` ; réponse marquée `x-nuera-preview: upstream`, sans `X-Frame-Options`/CSP/HSTS, `Location` locale rendue
  relative, `Set-Cookie` sans `Domain`.
- Métriques : CPU échantillonné, mémoire limitée par cgroup si applicable, disque de la racine des projets
  (`fs.statfs`), charge, uptime. Disponibilité : battement par minute dans `uptime_daily` sous la clé
  `uptimeServiceKey()` (`runner` pour le serveur par défaut, historique conservé ; `runner:<id>` pour les autres),
  trou détecté au démarrage = incident de ce serveur.
- Planificateur : disponibilité (1 min), `git fetch` des projets prêts **de son
  serveur** avec un jeton de lecture demandé au web (10 min, ignoré si le web ne répond pas, erreur notée sur le
  projet).

## Tests

`vitest` exécute de vrais processus : dépôts Git temporaires avec un dépôt nu local comme `origin`, PTY réels, et le
faux CLI **de test** `test/fixtures/fake-claude.mjs` (sélectionné par `NUERA_CLAUDE_BIN`) qui lit `--settings`,
exécute les hooks configurés avec des charges réalistes, écrit un journal JSONL et répond à `--version` /
`auth status --json` (état de connexion par `CLAUDE_CONFIG_DIR`), et note les variables de confiance reçues
(`<CLAUDE_CONFIG_DIR>/nuera-fake-env/<session>.json`). La base `nuera_runner_test` (PostgreSQL local de
`pnpm db:local`, autre nom avec `RUNNER_TEST_DATABASE_URL`) est recréée à chaque lancement et migrée comme en
production (empreinte du jeton de test sur le serveur par défaut, adopté par un compte propriétaire) ; sans
PostgreSQL, les suites base de données sont ignorées, ou échouent avec `NUERA_REQUIRE_PG=1`.

- `test/environments.test.ts` : **deux runners sur une même base** (listes, capacité, reprise, opérations et
  lancements interrompus, fetch planifié, disponibilité, connexion Claude propres à chaque serveur ; identifiants de
  l'autre serveur = 404 « inconnu » sans écriture ; attente sur jeton inconnu, bail, marqueurs,
  `NUERA_ENVIRONMENT_ID`, serveur suspendu ou retiré).
- `test/restricted.test.ts` : un rôle de connexion membre de `nuera_runner` (nommé d'après la base de test, supprimé à
  la fin) exécute les parcours du runner (clonage, synchro, worktrees, commit, lancement, session avec événements et
  autorisation, reprise, disponibilité, battement) avec les seuls droits et politiques de `0004` et `0005` (bail par
  `nuera_runner_try_lease()`, tout autre verrou consultatif refusé).
- `test/usage-limit.test.ts` : avis du CLI et heures de levée (fuseaux, jours, époque), calendrier (levée + marge,
  essais toutes les 30 min, 5 tentatives), puis avec le faux CLI (`scenario:limit:<s>`, ou une étape
  `{ fail: { error: 'rate_limit', resetInSeconds } }` : la limite dure jusqu'à la levée, chaque instruction s'y arrête
  comme avec le vrai CLI) : reprise tapée dans le CLI vivant, limite toujours là (nouvelle heure), option coupée puis
  rétablie, reprise après redémarrage du runner (`claude --resume`).
- `test/lease-compat.test.ts` : runner restreint contre une base migrée jusqu'à `0004` seulement (repli sur
  `pg_try_advisory_lock`, même clé).

Sous Windows, les tests utilisent le backend PTY ; le backend tmux (`test/tmux.test.ts`, dont la non-adoption d'une
session d'un autre serveur) est exercé sur Linux seulement : à lancer sur une machine Linux avec tmux avant tout
déploiement.

## Limites connues

- Serveur retiré pendant le service : ses sessions tmux continuent, mais rien ne les arrête plus par Nuera (attente,
  et la RLS masque ses lignes à un rôle restreint) → arrêter les sessions (désactiver le compte) **avant** de retirer.
- Le runner republie encore `notification.created` sur son flux global ; le navigateur l'ignore (seq ≠ 0) et ne lit
  que le canal web du compte.
- Les connexions PostgreSQL s'appellent `nuera-runner` et `nuera-runner-lease`, sans l'id du serveur : le web ne peut
  rattacher une connexion de `pg_stat_activity` qu'au serveur par défaut quand il vérifie l'« accès base restreint »
  (il accepte déjà `nuera-runner:<id>` / `nuera-runner-lease:<id>`).
- `NUERA_DB_POOL_MAX` accepte jusqu'à 50, mais le rôle restreint du serveur est plafonné par
  `NUERA_RUNNER_DB_CONNECTION_LIMIT` (web, 20 par défaut) : garder ce plafond au moins égal au pool + 3.

`sessions.create` avec un `sessionId` fourni vérifie son unicité par une insertion annulée (CONFLICT « Une session
porte déjà cet identifiant. » quel que soit le serveur qui le détient, rien n'est créé) ; une relecture périodique qui
trouve le jeton sur une autre ligne arrête le runner ; l'attente du bail et la reprise répondent 503
`ENVIRONMENT_STARTING`.
