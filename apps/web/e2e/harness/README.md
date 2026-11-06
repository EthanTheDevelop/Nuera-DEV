# Pile de test locale (`apps/web/e2e/harness`)

**Code de test uniquement.** Rien sous `apps/web/src` n'importe ce dossier et le comportement de production ne change
pas. Une *pile* = une base PostgreSQL dédiée + un faux GitHub (plusieurs applications) + **un vrai runner par serveur**
(depuis les sources, backend PTY, faux CLI Claude de test) + le **vrai web** (`next dev`) + de **vrais dépôts Git**
(dépôts nus locaux servant d'« origin ») + **N comptes**. Chaque lot, chaque agent ou la suite e2e a sa propre pile
(nom, ports, base) ; plusieurs piles tournent en même temps sans se voir.

| Compte | Qui | Créé par | Serveur (runner) | Source GitHub |
|---|---|---|---|---|
| `a` | Camille Laurent, **propriétaire** | la vraie page `/configuration` (jeton, TOTP, codes de secours) | « VPS-3 », serveur par défaut (`runner`, `RUNNER_URL` / `RUNNER_TOKEN`, DSN complet) | application `a` (atelier-test, dev-test) |
| `b` | Hugo Martin, **membre** | invitation de l'administration + la vraie page `/invitation/<jeton>` (TOTP obligatoire) | « VPS-4 » (`runner-b`), enregistré par l'administration : jeton affiché une fois, **rôle PostgreSQL restreint** (`RUNNER_DATABASE_URL`) | application `b` (hugo-test, atelier-test) |

Le nombre de comptes (= serveurs) se choisit par `up --accounts N` (Playwright : `E2E_ACCOUNTS`) : **2 par défaut pour la
pile `e2e`**, 1 pour toute autre pile (un lot qui n'a besoin que du propriétaire garde une pile légère).

**Serveur partagé** (lot P1) : `up --accounts 2 --shared` invite B sur « VPS-3 » au lieu de lui enregistrer « VPS-4 » :
un seul runner, deux comptes, chacun avec son dossier Claude (celui de B : `home/.claude-comptes/<id de son espace>`, neuf
donc déconnecté pour le faux CLI) et ses clones dans `projects/espaces/<id>/`. L'option est gardée dans `state.json`
(`options.shared`) ; `partage.spec.ts` ne tourne que sur une telle pile.

## 1. Démarrage rapide

```bash
pnpm db:local                                              # PostgreSQL 17 local (port 54329), une fois
node apps/web/e2e/harness/stack.mjs up    --name harness --web-port 3201 [--accounts 2]
node apps/web/e2e/harness/stack.mjs seed  --name harness all
node apps/web/e2e/harness/stack.mjs seed  --name harness --as b projects,sessions,notifications
node apps/web/e2e/harness/stack.mjs login --name harness [--as b]   # storage state + commande de capture
node apps/web/e2e/harness/stack.mjs shot  --name harness / --out .data/stacks/harness/shots/accueil.png
node apps/web/e2e/harness/stack.mjs shot  --name harness / --mobile --as b
node apps/web/e2e/harness/stack.mjs down  --name harness   # --purge : supprime aussi dossier, base, rôles, .next-harness
```

Ouvrir ensuite **`http://localhost:<web>`** (jamais `127.0.0.1` : `next dev` y refuse le websocket HMR et la page ne
s'hydrate pas) et se connecter avec l'e-mail, le mot de passe et le code TOTP affichés par `up` (secrets TOTP dans
`state.json → accounts[].totpSecret` ; `oathtool --totp -b <secret>` ou n'importe quelle application
d'authentification). Deux comptes en même temps : un compte par profil de navigateur (ou une fenêtre privée).

Premier `up` : 1 à 4 min (compilation à froid de `next dev`, construction des dépôts de test), plus ~1 min par compte
supplémentaire (serveur enregistré, runner démarré, invitation acceptée, source GitHub). Les suivants réutilisent ce
qui tourne déjà. `seed all` sur une pile neuve : ~2 min, puis idempotent.

## 2. Commandes

`node apps/web/e2e/harness/stack.mjs <commande> --name <pile> [options]` (Node ESM pur ; il enregistre `tsx`, la
dépendance de développement du runner, puis lance `cli.ts`). `help` affiche l'aide complète.

| Commande | Effet |
|---|---|
| `up` | base créée (ou réutilisée) et migrée (empreinte du jeton du serveur par défaut enregistrée, comme `migrate` en production) ; faux GitHub ; runner A ; web ; propriétaire par `/configuration` ; source GitHub du propriétaire par les **vraies routes** ; pour chaque compte suivant : serveur enregistré par l'administration (`POST /api/admin/servers`), son runner démarré avec le jeton et le DSN restreint affichés une fois, invitation (`POST /api/admin/invitations`, serveur pré-attribué) acceptée par la page `/invitation/<jeton>`, sa source GitHub ; pages préchauffées ; résumé. Options : `--accounts N`, `--web-port N` (+ `--runner-port`, `--hook-port`, `--github-port`), `--db <nom>`, `--reset`, `--pristine` (sans propriétaire : la première configuration reste à faire ; les autres comptes viennent au `up` suivant), `--no-web`, `--scheduler` (tâches périodiques du runner **et** horloge web des vérifications, sinon `NUERA_WEB_SCHEDULER=off`), `--seed a,b`, `--seed-b a,b`, `--warm /x,/y`. |
| `down` | arrête tous les processus de la pile (arbres entiers, chaque runner) et vérifie que ses ports sont libres. `--purge` : supprime aussi `.data/stacks/<pile>/`, sa base, **les rôles de connexion de ses serveurs** et `apps/web/.next-<pile>`. |
| `status` | état et santé de chaque processus et de chaque compte (`--json` pour un script). Code 1 si un composant ne répond pas. |
| `login` | connexion mot de passe + TOTP → `storage-state.json` (compte a) ou `storage-state-<clé>.json` (`--as b`) ; `--out` pour un autre fichier. |
| `seed <scénario…>` | données de test (§5) du compte a, ou d'un autre avec `--as b`. |
| `shot <chemin>` | capture connectée (1440×1000, ou 390×844 avec `--mobile`) ; `--as b`, `--full`, `--out`, `--wait ms`, `--selector css`, `--dark`. |
| `restart <composant>` | `github`, `web`, `runner` (« VPS-3 »), `runner-b` (« VPS-4 »)… Un runner relancé marque **ses** sessions vivantes « Interrompue » (jamais celles d'un autre serveur). |
| `stop <composant>` | arrête un composant seul (p. ex. `runner-b` pour l'état « VPS-4 ne répond pas ») ; `up` ou `restart` le relance. |
| `logs <composant> [--lines N]` | fin du journal (`logs/<composant>.log`). |
| `claude connecte\|deconnecte [--serveur b]` | état de connexion du faux CLI d'un serveur (`claude auth status`), cache de son runner rafraîchi → états T6. |
| `github revoquer-cle\|retablir-cle\|suspendre <compte>\|reactiver <compte> [--app b]` | contrôles du faux GitHub pour une application (défaut `a`). |
| `env [--format posix\|powershell\|cmd]` | variables `E2E_*` de la pile, dans la syntaxe du shell. |
| `e2e [--accounts N] -- <arguments Playwright>` | lance Playwright sur la pile avec ses variables (fonctionne sous PowerShell, cmd et Git Bash). |

Le faux GitHub (`github-front.ts`) enveloppe un faux unitaire (`src/server/github/test/fake-github.ts`) **par
application** derrière un seul port :

- applications déclarées (`fixtureGithubApps`, identifiants globaux comme sur GitHub) : `a` (propriétaire atelier-test,
  installations atelier-test 71001 et dev-test 71002 — les identifiants de la version 1), `a2` (atelier-test 71101,
  application de réserve pour une seconde source), `b` (propriétaire hugo-test, installations hugo-test 72003 et
  atelier-test 72001) ;
- « Create GitHub App » lie la prochaine application libre dont le propriétaire correspond à la route (organisation ou
  compte personnel), ou celle forcée par le contrôle `{ bindNext }` ; un nom déjà pris par une autre application ou de
  plus de 34 caractères est refusé (422), comme sur GitHub ; une application privée ne s'installe que sur son
  propriétaire ; `{ release }` oublie une liaison (application supprimée sur GitHub) ;
- les JWT sont routés par leur émetteur (`iss`), les jetons d'installation par l'application qui les a émis ; les
  numéros de pull request sont par dépôt, toutes applications confondues ; une branche déjà proposée est refusée ;
- `GET /repos/{owner}/{repo}/contents/{path}?ref=` est lu dans le **vrai** dépôt nu (`readBareContents`) ;
- `/__harness/state` donne `apps[]` (liaison, manifest, installations, jetons, pull requests) et `pulls[]` (avec
  `app` / `appId`) ; `/__harness/control` accepte `app`.

Sous Git Bash (Windows), un argument `/projets` devient `C:/Program Files/Git/projets` : `shot` corrige ce préfixe, et
`projets` (sans barre) est accepté.

## 3. Ports, noms et bases

Convention : **web N · runner A N+1000 · hooks A N+1001 · faux GitHub N+1002 · runner B N+1010 · hooks B N+1011**
(serveur d'indice k : N+1000+10k / N+1001+10k), base `nuera_<pile>` partagée par tous les runners (comme en
production). Les ports 3000/4100/4101 (`pnpm dev`) et la base `nuera_dev` sont refusés. Deux piles qui tournent en même
temps : ports web espacés d'au moins 30.

| Pile | Web | Runner A | Hooks A | GitHub | Runner B | Hooks B | Base |
|---|---|---|---|---|---|---|---|
| `e2e` (défaut de Playwright, 2 comptes) | 3102 | 4102 | 4103 | 4104 | 4112 | 4113 | `nuera_e2e` |
| `harness` | 3201 | 4201 | 4202 | 4203 | 4211 | 4212 | `nuera_harness` |
| `harness2` (contrôle d'isolation) | 3291 | 4291 | 4292 | 4293 | 4301 | 4302 | `nuera_harness2` |
| un lot `<x>` | à choisir, p. ex. 3x00 | +1000 | +1001 | +1002 | +1010 | +1011 | `nuera_<x>` |

Une pile inconnue doit recevoir `--web-port` au premier `up` ; ensuite ses ports sont lus dans son `state.json`. Les
rôles de connexion restreints des serveurs (`environments.db_role`, et les rôles de secours `nuera_<pile>_env_*`) sont
supprimés avec la base (`--reset`, `down --purge`).

## 4. `.data/stacks/<pile>/` (ignoré par Git)

| Chemin | Contenu |
|---|---|
| `state.json` | tout ce qu'un test ou un script doit savoir (ci-dessous) |
| `owner.json` | compte a : identifiants, secret TOTP, codes de secours **non utilisés** (tenus à jour) |
| `accounts/<clé>.json` | idem pour les autres comptes (`accounts/b.json`) |
| `storage-state.json`, `storage-state-<clé>.json` | cookies d'une session connectée de chaque compte |
| `logs/` | `github.log`, `runner.log`, `runner-b.log`, `web.log` |
| `remotes/` | dépôts nus des comptes de test (`atelier-test/*.git`, `dev-test/*.git`, `hugo-test/*.git`) = « GitHub », partagés |
| `projects/`, `runner-data/`, `home/` (`home/.claude`) | serveur A : `NUERA_PROJECTS_ROOT`, `NUERA_DATA_DIR`, `HOME` isolé et `NUERA_CLAUDE_CONFIG_DIR` du faux CLI (état de connexion `nuera-fake-claude.json`, scripts `nuera-fake-scenarios/*.json`) |
| `runner-b/{projects,runner-data,home}` | les mêmes pour le serveur B (son propre état Claude, ses propres clones) |
| `github/` | configuration et état persistant du faux GitHub (clé de chaque application `app-key[-<clé>].pem`, jetons, pull requests) |
| `playwright/` | storage states des workers Playwright (`storage-<projet>-<worker>[-<clé>].json`) |
| `shots/` | captures de `shot` |

`state.json` (version 2, types : `state.ts` ; un fichier version 1 est relu et complété) :

- `ports`, `urls` (`web` = `http://localhost:<web>`, `runner`/`hook` du serveur A, `githubApi`, `githubWeb`),
  `database` (`name`, `url`, `adminUrl`), `accountCount` ;
- `accounts[]` : `key`, `role`, `name`, `email`, `password`, `totpSecret`, `userId`, `spaceId`, `runner` (serveur de son
  espace), `gitIdentity`, `stateFile`, `storageState`, `created`, `createdVia` (`configuration` | `invitation`),
  `github { app, sourceId, connected, accounts, repoCount }`, `seeded` (comptes autres que a) ;
- `runners[]` : `key`, `component` (`runner`, `runner-b`…), `name` (« VPS-3 », « VPS-4 »), `isDefault`,
  `environmentId`, `account`, `ports`, `urls`, `token` (Bearer de ce runner et de ses routes `/api/internal/*`),
  `dbRole`, `databaseUrl` (DSN restreint), `paths`, `registeredVia` (`migration` | `admin` | `sql`) ;
- `githubApps[]` : `key`, `appId`, `slug`, `owner`, `installations`, `account` ;
- `allRepos` : tous les dépôts de test avec l'installation de chaque application (`installations`) ;
- **projection du compte a** (specs écrites pour un seul compte) : `owner`, `secrets.runnerToken`, `paths.projects` /
  `runnerData` / `claudeConfig`, `github` (application `a`), `repos` (dépôts visibles du compte a), `seeded` ;
- `secrets` (`betterAuthSecret`, `appEncryptionKey`, `setupToken` `e2e-jeton-configuration-0123456789`, clés VAPID) —
  **valeurs de test** générées par pile ; `processes` : pid, image, commande et journal de chaque composant.

## 5. Données de test (`seed`)

Tout passe par les **vrais chemins de code** : routes du web connecté **en tant que le compte** (le projet est écrit
dans son espace, sur son serveur, rattaché à sa source GitHub), routes du runner de **son** serveur, routes internes du
web avec le jeton de **son** serveur (notifications : une ligne par membre de l'espace). SQL direct uniquement pour ce que
le web écrit lui-même sans route dédiée (marques « ouvert » / favori d'un projet seedé, par identifiant ; « Sessions
parallèles » du serveur du compte, portée à 8).

| Scénario | Compte a | Autres comptes | `seeded` |
|---|---|---|---|
| `github` | source GitHub connectée (déjà fait par `up`) | idem, sa propre application | `github { accounts, repoCount }` |
| `projects` | `POST /api/projects` : `atelier-test/devis-express` (« Devis Express », favori), `atelier-test/catalogue-produits` (un test rouge exprès), `dev-test/outils-cli` ; attente de l'opération de clonage du runner | `atelier-test/devis-express` (**le même dépôt**, sur son serveur) et `hugo-test/carnet-chantier` | `projects.{clé} { id, slug, name, fullName, path, defaultBranch, worktreeId, operationId }` |
| `sessions` | sur Devis Express : **finished**, **interrupted** (redémarrage du runner A), **waitingPermission**, **running** | **running** seulement (une session vivante sur son serveur) | `sessions.{…}` |
| `changes` | session « Export CSV » : un commit (auteur = identité Git du compte) + fichiers non commités **vérifiés sur le worktree** avant d'être enregistrés | — | `changes { … }` |
| `runs` | `npm run test` : Devis Express (réussi) et Catalogue produits (1 échec) | — | `runs.passed`, `runs.failed` |
| `notifications` | `POST /api/internal/notify` (jeton du serveur A) : clone terminé, tests en échec | clones terminés (jeton de son serveur) | `notifications { ids, at }` |

`all` = `projects sessions changes runs notifications` (dépendances ajoutées d'office). Playwright lance `E2E_SEED`
(défaut `all`) pour a et `E2E_SEED_B` (défaut `projects,sessions,notifications`) pour b. Après un redémarrage d'un
runner, ses CLI vivants s'arrêtent : relire `state.json` (fixture `stack`) plutôt que de garder des ids.

### Connexion MCP d'une session (`mcp-connect.mjs`)

`node apps/web/e2e/harness/mcp-connect.mjs <mcp.json> <serveur>` fait ce que Claude Code fait à la connexion d'un
serveur HTTP de son `--mcp-config` : exécute son `headersHelper` (`bin/nuera-mcp-headers.mjs` du runner, avec
`CLAUDE_CODE_MCP_SERVER_NAME/_URL` et l'environnement de la session), puis envoie `initialize` avec les en-têtes
obtenus. Il n'affiche que les **noms** des en-têtes et le statut HTTP. `mcp.json` = `<runner-data du serveur>/sessions/
<id>/mcp.json`. Serveurs MCP et Coolify factices : `apps/web/src/server/mcp/test/fake-mcp.ts`,
`apps/web/src/server/coolify/test/fake-coolify.ts` (cf. `parcours-5-mcp-diagnostic.spec.ts`).

### Faux CLI Claude (`apps/runner/test/fixtures/fake-claude.mjs`)

Chaque runner le lance comme le vrai binaire (`NUERA_CLAUDE_BIN`), dans un vrai PTY, avec le `CLAUDE_CONFIG_DIR` de
**son** serveur (`NUERA_CLAUDE_CONFIG_DIR`) : chaque serveur a sa propre connexion Claude (un serveur = une personne =
une connexion Claude).

- une instruction en français simple déclenche le script dont une phrase `match` apparaît (voir `scenarios.ts`), ou
  `scenario:<nom>` explicitement (`cli.script()` écrit le script dans le dossier du serveur du compte) ;
- étapes : `plan`, `say`, `read`, `grep`, `glob`, `edit` / `write` / `remove` (modifient **vraiment** le worktree, avec
  demande d'autorisation selon le mode), `bash` (`run: true` l'exécute vraiment), `wait`, `fail`, `final`, `pause` ;
- `claude auth status` suit `nuera-fake-claude.json` du serveur (`stack.mjs claude deconnecte --serveur b`).
- limite d'utilisation : `scenario:limite` (StopFailure seul, levée inconnue), `scenario:limite-levee` (avis « 5-hour
  limit reached ∙ resets … », levée 20 s plus tard), `scenario:limit:<secondes>` (intégré au faux CLI) ; tant que la
  limite dure, chaque instruction s'y arrête comme avec le vrai CLI (avis écrit et affiché, status line à 100 %,
  `StopFailure`). Les runners de la pile reprennent 2 s après la levée (`NUERA_AUTO_RESUME_MARGIN_SECONDS=2`, au lieu
  de 2 min) : `reprise.spec.ts` voit la reprise automatique se déclencher.

## 6. Playwright

`pnpm --filter @nuera/web e2e [fichiers]` (ou, depuis n'importe quel shell, `stack.mjs e2e --name <pile> -- …`) :

| Variable | Défaut | Rôle |
|---|---|---|
| `E2E_STACK` | `e2e` | nom de la pile (`.data/stacks/<nom>/`) |
| `E2E_ACCOUNTS` (alias `E2E_RUNNERS`) | `state.json`, sinon 2 pour `e2e`, 1 sinon | comptes (= serveurs) de la pile |
| `E2E_WEB_PORT` (alias `E2E_PORT`) | `state.json`, sinon convention (3102 pour `e2e`) | port du web |
| `E2E_RUNNER_PORT`, `E2E_HOOK_PORT`, `E2E_GITHUB_PORT` | web + 1000 / + 1001 / + 1002 | autres ports (runner B : convention) |
| `E2E_DATABASE` | `nuera_<pile>` | base |
| `E2E_PG_URL` | `postgres://nuera:nuera@127.0.0.1:54329` | serveur PostgreSQL (sans base) |
| `E2E_RESET=1` | — | recrée la pile avant la suite |
| `E2E_PRISTINE=1` | — | pile sans propriétaire : le projet `configuration` le crée par `/configuration` |
| `E2E_SEED` / `E2E_SEED_B` | `all` / `projects,sessions,notifications` | scénarios des comptes a / b (`none` pour aucun) |
| `E2E_UPGRADE=1` | — | ajoute le projet `mise-a-niveau` (pile créée avant la refonte, migrée sur place par `up`) |
| `E2E_DOWN=1` | — | arrête la pile à la fin (elle reste lancée sinon) |
| `E2E_CHROMIUM_PATH` | build installé | Chromium à utiliser |

Déroulement : *global setup* = `up` → projet `configuration` → projet `stack` (`e2e/stack.setup.ts` : propriétaire,
GitHub, serveur B, compte B, sources, seeds) → projets **`desktop`** et **`mobile`**. Les specs `@comptes` ne tournent
qu'en `desktop` (elles ouvrent elles-mêmes leurs contextes téléphone) et s'ignorent sur une pile à un seul compte.

```ts
import { requireAccounts, test, expect } from './fixtures';

test('…', async ({ page, stack, runnerApi, seed, waitForSessionStatus, cli, as }) => {
  const devis = stack.seeded.projects!.devis!;                       // compte a (propriétaire, « VPS-3 »)
  await page.goto(`/projets/${devis.id}`);                           // page déjà connectée (compte a)
  const session = await cli.createSession({ title: 'Essai', branch: 'test/essai' });
  await waitForSessionStatus(session.id, 'waiting_input');
  requireAccounts(2);
  const b = await as('b', { mobile: true });                         // compte b, son propre contexte
  await b.page.goto('/projets');
  const sessionB = await b.cli.createSession({ project: 'carnet', title: 'Essai B', branch: 'test/b' });
  await b.runnerApi('getSession', { params: { sessionId: sessionB.id } });   // runner de « VPS-4 »
  await seed('projects', { account: 'b' });
});
```

Fixtures (`e2e/fixtures/index.ts`, fonctions aussi exportées dans `fixtures/stack.ts`) : `page` connectée (compte a,
mot de passe + TOTP une fois par worker), `stack` (`state.json`), `runnerApi`, `seed(...scénarios, { account })`,
`waitForSessionStatus(id, statuts, { account })`, `cli` (`cliHelpers('b')` pour un autre compte), `as(clé, { mobile })`,
`loginAs(page, clé)`, `requireAccounts(n)`, `stackRunnerApi(clé)`, `restartComponent` / `stopComponent`
(`'runner-b'`…), `controlFakeGithub`, `fakeGithubState`. Comptes : `createOwnerAndSignIn`, `signIn`, `signInAs`,
`signOut`, `acceptInvitation`, `completeEnrolment`, `totpCode` (`fixtures/owner.ts`). Administration : `invite`,
`adminCall`, `removeAccount`, `ADMIN_ROUTES`, `COPY` (`fixtures/admin.ts`). Portabilité : `samePath`,
`normalizePath`, `deviceLabelOf` (`fixtures/paths.ts`).

Résultats et traces : `apps/web/test-results/<pile>/`. Les sessions créées par un test sont à arrêter en fin de test
(`runnerApi('stopSession', …)`) pour libérer leur place.

## 7. Dépannage

- **« PostgreSQL ne répond pas »** : `pnpm db:local` (port 54329). Une seule instance pour toutes les piles.
- **« Le port N … est déjà utilisé »** : une autre pile ou un ancien processus ; `stack.mjs status --name <pile>`, puis
  `down`. Linux/macOS : `lsof -nP -iTCP:N -sTCP:LISTEN` ; Windows : `netstat -ano | findstr :N` (un port exclu par
  Windows : `netsh interface ipv4 show excludedportrange protocol=tcp`).
- **Le web ne démarre pas / 500** : `stack.mjs logs web --name <pile>`. Une compilation à froid peut prendre plusieurs
  minutes (délais ≥ 4 min partout). Supprimer `apps/web/.next-<pile>` si le cache est corrompu.
- **Le runner B attend (« non enregistré »)** : son jeton n'est pas celui du serveur en base (`up --reset`, ou
  renouveler le jeton dans l'administration puis mettre à jour `runners[].token` et `restart runner-b`).
- **Les pages se rechargent en boucle** (`reloadPage: HMR hash mismatch`) : cache Turbopack abîmé ; `up` / `restart
  web` le détectent, suppriment `apps/web/.next-<pile>/dev/cache/turbopack` et relancent le web.
- **Pile dans un état incohérent** (base remise à zéro à la main, compte sans son fichier) : `up --reset`.
- **« Session expirée : relancez `login` »** : les sessions web expirent après inactivité ; `login` en refait une.
- **Chromium introuvable** : `E2E_CHROMIUM_PATH=/chemin/chrome` ou installer la révision attendue.
- **Windows** : PTY par `@lydell/node-pty` ; arrêt des arbres par `taskkill /T /F`, **seulement** si le pid enregistré
  est toujours le processus lancé (image `node.exe` et heure de démarrage par `Get-Process`, `wmic` étant absent de
  Windows 11 ; Windows recycle vite les pid) ; ports lus par `netstat` (état localisé toléré) ; Git pour Windows active
  `core.autocrlf` dans sa configuration système : le runner force `core.autocrlf=false` et les seeds vérifient les
  changements qu'ils annoncent ; `git worktree list` écrit `P:/…` (comparer avec `samePath`) ; `cmd.exe` n'a pas de
  `sleep` (`node scripts/attendre.js N`) ; PowerShell : `stack.mjs env --format powershell` ou `stack.mjs e2e`. Un
  antivirus peut ralentir `git`/`node` de plusieurs secondes (délais déjà larges, plus encore avec deux runners).
- **Linux (conteneur, root)** : `lsof` est requis pour `down` / la vérification des ports ; `tmux` n'est pas utilisé
  (backend `pty`). Le backend tmux à plusieurs serveurs se valide sur Linux (`NUERA_SESSION_BACKEND=tmux`).
- **`tsc` : TS2882 sur `./.next-<pile>/dev/types/routes.d.ts`** : `down --purge` retire ces imports de
  `apps/web/next-env.d.ts` s'ils pointent vers la pile supprimée.
- Le verrou `.data/stacks/<pile>/.lock` sérialise `up` / `seed` / `down` entre processus ; un verrou dont le processus a
  disparu est repris automatiquement.
