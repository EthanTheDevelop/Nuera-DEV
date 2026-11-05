# @nuera/runner — moteur d'exécution de Nuera Dev

Service Fastify privé (jamais exposé à Internet) : seul composant qui touche au disque des projets, à Git, aux PTY,
aux sessions du CLI officiel Claude Code et aux processus des projets. Le web (`apps/web`) l'appelle avec
`Authorization: Bearer ${RUNNER_TOKEN}` via le client typé `apps/web/src/server/runner/client.ts` et relaie ses flux
SSE au navigateur (`/api/stream/*`).

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
| `RUNNER_TOKEN` | — (≥ 16 car.) | Jeton partagé web ⇄ runner (comparaison à temps constant, empreintes SHA-256). |
| `DATABASE_URL` | — | PostgreSQL (tables écrites : worktrees, sessions, session_events, permission_requests, operations, command_runs, uptime_daily ; projects pour la synchro). |
| `APP_URL` | `http://localhost:3000` | Web, pour les rappels `/api/internal/*` (`NUERA_WEB_INTERNAL_URL` pour une URL interne différente). |
| `NUERA_PROJECTS_ROOT` | `./.data/projects` | Racine des clones et worktrees (prod : `/srv/dev`). Chemins relatifs = relatifs à la racine du dépôt. |
| `NUERA_DATA_DIR` | `./.data/runner` | Fichiers d'exécution (réglages de session, tmux.conf, dossiers de travail du CLI). |
| `NUERA_SESSION_BACKEND` | auto | `tmux` (prod Linux), `pty` (dev Windows), vide = tmux si `tmux -V` répond. |
| `NUERA_CLAUDE_BIN` | `claude` du `PATH` | Binaire officiel. Un chemin `.mjs` est lancé avec Node : **réservé aux tests** (faux CLI). |
| `NUERA_GIT_REMOTE_BASE` | `https://github.com/` | Base des URL Git (`<base><owner>/<repo>.git`). Les tests pointent vers des dépôts nus locaux. |
| `NUERA_SCHEDULER` | `1` (hors tests) | Tâches périodiques (disponibilité, vérification des intégrations, fetch). |
| `LOG_LEVEL` | `info` | pino (en-têtes d'autorisation et jetons masqués). |

En développement, le `.env` de la racine est chargé sans écraser les variables déjà présentes dans le shell.

## Routes (`/v1`, contrat partagé `@nuera/shared/runner` → `RUNNER_ROUTES`)

Toutes exigent le Bearer et valident leurs entrées avec Zod. Erreurs uniformes :
`{ error: { code, message, detail?, raw?, untouched?, reason?, data? } }` — `raw` = sortie brute masquée (règle T4),
`untouched` = ce qui n'a pas été touché, `reason` = sous-code machine (`DESTINATION_NOT_EMPTY`, `PULL_DIVERGED`,
`WORKTREE_DIRTY`, `CAPACITY_REACHED`…).

| Domaine | Routes |
|---|---|
| Système | `GET /health`, `GET /system/metrics`, `GET /system/uptime?days=` |
| Événements | `GET /events` (SSE global), `POST /events/publish` (web → diffusion de `notification.created`) |
| Dépôts | `POST /repos/check-destination`, `POST /repos/clone` (opération async), `POST /repos/:projectId/fetch\|pull`, `GET …/status\|sync\|branches\|log`, `POST …/branches\|checkout` |
| Worktrees | `GET\|POST /repos/:projectId/worktrees`, `DELETE /worktrees/:id?force=&deleteBranch=`, `GET /worktrees/:id/status` |
| Changements | `GET /worktrees/:id/changes\|diff?path=\|ahead-behind`, `POST …/stage\|unstage\|commit\|push` |
| Fichiers | `GET /worktrees/:id/tree?path=\|file?path=`, `GET\|PUT /projects/:projectId/claude-md` |
| Opérations | `GET /operations/:id`, `GET /operations/:id/stream` (SSE) |
| Terminaux | `POST /terminals`, `GET /terminals`, `GET /terminals/:id`, `GET /terminals/:id/stream` (SSE), `POST …/input\|resize`, `DELETE /terminals/:id` |
| Sessions | `POST /sessions`, `GET /sessions`, `GET /sessions/:id`, `POST …/start\|resume\|instruction\|interrupt\|stop`, `GET …/events?afterVersion=`, `GET …/stream` (SSE), `GET …/terminal`, `POST /permissions/:id/decision` |
| Processus | `POST /runs`, `GET /runs/:id`, `GET /runs/:id/stream` (SSE), `DELETE /runs/:id` |
| CLI Claude | `GET /claude/status?refresh=`, `POST /claude/mcp/sync`, `GET /claude/mcp/:name` |

Écoute locale (127.0.0.1:`RUNNER_HOOK_PORT`, jeton de session en Bearer) : `POST /internal/hooks/:sessionId`,
`POST /internal/statusline/:sessionId`, `POST /internal/mcp-headers/:sessionId`.

Rappels vers le web (Bearer `RUNNER_TOKEN`, tolérés absents/injoignables) : `POST /api/internal/notify`,
`/api/internal/mcp-headers`, `/api/internal/git-credentials`, `/api/internal/integrations/check` (toutes les 15 min).

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
  `BETTER_AUTH_SECRET`, `APP_ENCRYPTION_KEY`, `SETUP_TOKEN`, `VAPID_*`, `GITHUB_*`, `GIT_*`, `NODE_OPTIONS`…).
- **Git** (`src/git/git.ts`) : `GIT_TERMINAL_PROMPT=0`, askpass qui refuse, configuration d'exécution par
  `GIT_CONFIG_COUNT/KEY/VALUE` (prioritaire sur `.git/config`, que Claude peut modifier) : assistants d'identification
  réinitialisés, hooks du dépôt désactivés (`core.hooksPath` vers un dossier vide, sauf `runHooks: true` explicite au
  commit), fsmonitor coupé, TLS vérifié ; pour le réseau : config système/globale ignorée, protocoles limités à
  HTTPS. Le jeton (fourni par le web, réduit au dépôt et à l'opération) n'existe que dans l'environnement du processus
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
   en base). Backend **tmux** : `tmux -L nuera -f <data>/tmux.conf new-session -d -s nuera-<slug>-<worktree> -c <cwd>
   -e K=V … -- claude …` puis un client PTY `tmux attach` ; le jeton passe par un fichier 0600
   (`NUERA_HOOK_TOKEN_FILE`) pour ne jamais apparaître dans l'argv de tmux. Backend **pty** : PTY direct
   (`NUERA_HOOK_TOKEN` dans l'environnement). Le propriétaire peut s'attacher en SSH : `tmux -L nuera attach -t <nom>`.
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
   `Notification`, sous-agents, compaction, `SessionStart` (`transcript_path` validé sous `~/.claude/projects`) et
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
7. **Garde-fous** : plafond de sessions simultanées (requête ou `app_settings`), une session vivante par worktree,
   plafond mémoire optionnel par arbre de processus (`pidusage`), `nice 10` sous Linux, mode `bypassPermissions`
   refusé tant que `app_settings.block_bypass_permissions` est actif.
8. **Démarrage** : réattache les sessions tmux `nuera-*` encore vivantes, passe les autres en `interrupted`
   (« reprise possible » si worktree et conversation existent), échoue les opérations et runs interrompus.
   **Arrêt** : les sessions tmux continuent ; les sessions PTY directes passent `interrupted`.

Confiance du dossier : le CLI retient ses hooks tant que le dialogue de confiance n'est pas accepté. Accepter une
fois la confiance pour `NUERA_PROJECTS_ROOT` (terminal `claude` dans ce dossier) évite le dialogue pour chaque
worktree ; sinon la session affiche « Action requise dans le terminal » et l'instruction attend en file.

## Processus du projet et système

- `POST /runs` : commande du projet dans un PTY (couleurs conservées), détection de port (« port 3000 »), lecture
  des résultats Vitest / Jest / Playwright / node:test en direct (« 10 / 10 réussis »), ligne `command_runs`.
- Métriques : CPU échantillonné, mémoire limitée par cgroup si applicable, disque de la racine des projets
  (`fs.statfs`), charge, uptime. Disponibilité : battement par minute dans `uptime_daily`, trou détecté au démarrage
  = incident.
- Planificateur : vérification des intégrations (15 min), `git fetch` des projets prêts avec un jeton de lecture
  demandé au web (10 min, ignoré si le web ne répond pas, erreur notée sur le projet).

## Tests

`vitest` exécute de vrais processus : dépôts Git temporaires avec un dépôt nu local comme `origin`, PTY réels, et le
faux CLI **de test** `test/fixtures/fake-claude.mjs` (sélectionné par `NUERA_CLAUDE_BIN`) qui lit `--settings`,
exécute les hooks configurés avec des charges réalistes, écrit un journal JSONL et répond à `--version` /
`auth status --json`. La base `nuera_runner_test` (PostgreSQL local de `pnpm db:local`) est recréée à chaque
lancement ; sans PostgreSQL, les suites base de données sont ignorées. Sous Windows, les tests utilisent le backend
PTY ; le backend tmux est exercé sur Linux.
