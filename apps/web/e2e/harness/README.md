# Pile de test locale (`apps/web/e2e/harness`)

**Code de test uniquement.** Rien sous `apps/web/src` n'importe ce dossier et le comportement de production ne change
pas. Une *pile* = une base PostgreSQL dédiée + un faux GitHub + le **vrai runner** (depuis les sources, backend PTY,
faux CLI Claude de test) + le **vrai web** (`next dev`) + de **vrais dépôts Git** (dépôts nus locaux servant
d'« origin »). Chaque lot, chaque agent ou la suite e2e a sa propre pile (nom, ports, base) ; plusieurs piles tournent
en même temps sans se voir.

## 1. Démarrage rapide

```bash
pnpm db:local                                              # PostgreSQL 17 local (port 54329), une fois
node apps/web/e2e/harness/stack.mjs up    --name harness --web-port 3201
node apps/web/e2e/harness/stack.mjs seed  --name harness all
node apps/web/e2e/harness/stack.mjs login --name harness   # storage-state.json + commande de capture
node apps/web/e2e/harness/stack.mjs shot  --name harness / --out .data/stacks/harness/shots/accueil.png
node apps/web/e2e/harness/stack.mjs shot  --name harness / --mobile
node apps/web/e2e/harness/stack.mjs down  --name harness   # --purge : supprime aussi dossier, base, .next-harness
```

Ouvrir ensuite **`http://localhost:<web>`** (jamais `127.0.0.1` : `next dev` y refuse le websocket HMR et la page ne
s'hydrate pas) et se connecter avec l'e-mail, le mot de passe et le code TOTP affichés par `up` (le secret TOTP est dans
`state.json → owner.totpSecret` ; `oathtool --totp -b <secret>` ou n'importe quelle application d'authentification).

Premier `up` : 1 à 4 min (compilation à froid de `next dev`, construction des dépôts de test). Les suivants
réutilisent ce qui tourne déjà (quelques secondes). `seed all` sur une pile neuve : ~2 min, puis idempotent (seul ce qui
manque ou a dérivé est recréé : autorisation répondue, tâche longue terminée…).

## 2. Commandes

`node apps/web/e2e/harness/stack.mjs <commande> --name <pile> [options]` (Node ESM pur ; il enregistre `tsx`, la
dépendance de développement du runner, puis lance `cli.ts`). `help` affiche l'aide complète.

| Commande | Effet |
|---|---|
| `up` | base créée (ou réutilisée) et migrée ; faux GitHub ; runner ; web ; propriétaire créé par la vraie page `/configuration` (jeton, compte, TOTP, codes de secours) ; application GitHub connectée par les **vraies routes** (`/api/integrations/github/manifest` → conversion du manifest → installation sur `atelier-test` puis `dev-test` → `setup`) ; pages préchauffées ; résumé. Options : `--web-port N` (+ `--runner-port`, `--hook-port`, `--github-port`), `--db <nom>`, `--reset` (repart de zéro), `--pristine` (sans propriétaire ni GitHub : la première configuration reste à faire), `--no-web`, `--scheduler`, `--seed a,b`, `--warm /x,/y`. |
| `down` | arrête tous les processus de la pile (arbres entiers) et vérifie que ses ports sont libres. `--purge` : supprime aussi `.data/stacks/<pile>/`, sa base et `apps/web/.next-<pile>`. |
| `status` | état et santé de chaque processus (`--json` pour un script). Code de sortie 1 si un composant ne répond pas. |
| `login` | connexion mot de passe + TOTP → `.data/stacks/<pile>/storage-state.json` (`--out` pour un autre fichier) ; affiche une commande de capture prête à lancer. |
| `seed <scénario…>` | données de test (§5) : `all`, `github`, `projects`, `sessions`, `changes`, `runs`, `notifications`. |
| `shot <chemin>` | capture connectée (1440×1000, ou 390×844 avec `--mobile`) ; `--full` (défile puis `clip`, cf. `CLAUDE.md`), `--out`, `--wait ms`, `--selector css`, `--dark`. Défaut : `.data/stacks/<pile>/shots/<page>-bureau.png`. |
| `restart <github\|runner\|web>` | relance un composant (le runner relancé marque les sessions vivantes « Interrompue »). |
| `logs <github\|runner\|web> [--lines N]` | fin du journal (`.data/stacks/<pile>/logs/<composant>.log`). |
| `claude connecte\|deconnecte` | état de connexion du faux CLI (`claude auth status`), cache du runner rafraîchi → états T6. |
| `github revoquer-cle\|retablir-cle\|suspendre <compte>\|reactiver <compte>` | contrôles du faux GitHub (clé de l'application refusée, installation suspendue) ; « Vérifier la connexion » ou `POST /api/integrations/github/check` applique le changement. |
| `env` | variables `E2E_*` correspondant à la pile (pour lancer Playwright dessus). |

Le faux GitHub (`github-front.ts`) sert aussi `GET /repos/{owner}/{repo}/contents/{path}?ref=` (racine, `package.json`,
`CLAUDE.md` lus par la configuration A1 d'« Ajouter un projet ») : accès vérifié comme pour `/branches`, contenu lu
dans le **vrai** dépôt nu (`readBareContents`, `fixture-repos.ts`).

Les captures de `shot` masquent l'indicateur de `next dev` (bouton « N » de `<nextjs-portal>`, qui couvre la carte
utilisateur de la barre latérale et le premier onglet du téléphone) ; une spec qui capture elle-même appelle
`hideNextDevIndicator(page)` (exporté par `./fixtures`) avant `page.screenshot()`.

Sous Git Bash (Windows), un argument `/projets` devient `C:/Program Files/Git/projets` : `shot` corrige ce préfixe, et
`projets` (sans barre) est accepté.

## 3. Ports, noms et bases

Convention : **web N · runner N+1000 · hooks N+1001 · faux GitHub N+1002**, base `nuera_<pile>` (tirets → `_`). Les
ports 3000/4100/4101 (`pnpm dev`) et la base `nuera_dev` sont refusés.

| Pile | Web | Runner | Hooks | GitHub | Base |
|---|---|---|---|---|---|
| `e2e` (défaut de Playwright) | 3102 | 4102 | 4103 | 4104 | `nuera_e2e` |
| `harness` | 3201 | 4201 | 4202 | 4203 | `nuera_harness` |
| `harness2` (contrôle d'isolation) | 3291 | 4291 | 4292 | 4293 | `nuera_harness2` |
| un lot `<x>` | à choisir, p. ex. 33x1 | +1000 | +1001 | +1002 | `nuera_<x>` |

Une pile inconnue doit recevoir `--web-port` au premier `up` ; ensuite ses ports sont lus dans son `state.json`.

## 4. `.data/stacks/<pile>/` (ignoré par Git)

| Chemin | Contenu |
|---|---|
| `state.json` | tout ce qu'un test ou un script doit savoir (ci-dessous) |
| `owner.json` | identifiants du propriétaire, secret TOTP, codes de secours **non utilisés** (tenus à jour) |
| `storage-state.json` | cookies d'une session connectée (`login`) |
| `logs/` | `github.log`, `runner.log`, `web.log` |
| `remotes/` | dépôts nus des comptes de test (`atelier-test/*.git`, `dev-test/*.git`) = « GitHub » |
| `projects/` | clones et worktrees (`NUERA_PROJECTS_ROOT` du runner) |
| `runner-data/` | `NUERA_DATA_DIR` du runner (journaux d'opérations, jetons de hook…) |
| `home/` | `HOME` isolé du runner ; `home/.claude` = `CLAUDE_CONFIG_DIR` du faux CLI (état de connexion `nuera-fake-claude.json`, scripts `nuera-fake-scenarios/*.json`) |
| `github/` | configuration et état persistant du faux GitHub (clé de l'application, jetons, pull requests) |
| `playwright/` | storage states des workers Playwright |
| `shots/` | captures de `shot` |

`state.json` (types : `state.ts`) :

- `ports`, `urls` (`web` = `http://localhost:<web>`, `runner`, `hook`, `githubApi` = `http://127.0.0.1:<gh>/api/v3`,
  `githubWeb`), `database` (`name`, `url`, `adminUrl`) ;
- `secrets.runnerToken` (Bearer du runner et des routes `/api/internal/*`), `betterAuthSecret`, `appEncryptionKey`,
  `setupToken` (`e2e-jeton-configuration-0123456789`), clés VAPID — **valeurs de test** générées par pile ;
- `owner` : `name` (Camille Laurent), `email` (`camille.laurent@<pile>.nuera.test`), `password`
  (`Riviere-Bleue-2026!`), `totpSecret`, `userId`, `created` ;
- `github` : `appId`, `slug` (`nuera-dev-<pile>`), `accounts` (`atelier-test` organisation, `dev-test` utilisateur, avec
  `installationId`), `connected` ;
- `repos` : 5 dépôts de test (`fullName`, `id`, `installationId`, `branches`, `bare`, `displayName`, `failingTests`) ;
- `processes` : pid, commande et journal de chaque composant ;
- `seeded` : identifiants créés par `seed` (§5).

## 5. Données de test (`seed`)

Tout passe par les **vrais chemins de code** (routes du runner, routes internes du web), exactement comme le web les
appellera. SQL direct uniquement pour les lignes que le web écrit lui-même et pour lesquelles aucune API n'existe encore
(lignes `projects`, marques « ouvert » / favori, réglage « Sessions parallèles »).

| Scénario | Ce qui est créé | `state.json → seeded` |
|---|---|---|
| `github` | application GitHub connectée (déjà fait par `up`) | `github { accounts, repoCount }` |
| `projects` | 3 projets : `atelier-test/devis-express` (« Devis Express », favori), `atelier-test/catalogue-produits` (un test rouge exprès), `dev-test/outils-cli`. Ligne `projects` telle que le web l'écrit (slug, `githubFullName`, `cloneUrl`, `path`, `status: cloning`, `commands`, `options`), puis `cloneRepo` du runner (vrai clone depuis `remotes/` + `npm ci`), attente de l'opération | `projects.{devis,catalogue,outils} { id, slug, name, fullName, path, defaultBranch, worktreeId (worktree principal), operationId }` |
| `sessions` | sur Devis Express, par `createSession` / `sendInstruction` / `permissionDecision` / `terminalInput` : **finished** (plan, modification autorisée dans Nuera, tests réels, `/exit` → « Terminée ») ; **interrupted** (tour en lecture seule puis redémarrage du runner → « Interrompue · reprise possible ») ; **waitingPermission** (`npm run test` attend une décision, jusqu'à 1 h) ; **running** (plan + tests en continu pendant 6 h, mode `acceptEdits`). « Sessions parallèles » passe à 8 au moins | `sessions.{finished,interrupted,waitingPermission,running} { id, title, projectId, worktreeId, branch, status, permissionMode, permissionId? }` |
| `changes` | session **changes** « Export CSV des devis » (`feature/export-csv`) : un commit local par la route `commit` du runner (en avance d'un commit sur origin) + fichiers non commités (ajouté, modifiés, supprimé) | `changes { sessionId, worktreeId, branch, commitSha, committedPaths, uncommitted[] }` et `sessions.changes` |
| `runs` | `npm run test` par `createRun` : Devis Express (13 / 13 réussis) et Catalogue produits (6 / 7, 1 échec) | `runs.passed`, `runs.failed { id, projectId, command, status, summary }` |
| `notifications` | `POST /api/internal/notify` (clone terminé, tests en échec), en plus de celles que le runner envoie lui-même (autorisation demandée, tours terminés) | `notifications { ids, at }` |

`all` = `projects sessions changes runs notifications` (les dépendances sont ajoutées d'office : tout scénario
sauf `github` implique `projects`). Les sessions vivantes (autorisation demandée, en cours, export CSV) occupent 3
places de « Sessions parallèles ». Après un redémarrage du runner (`down` puis `up`, `restart runner`), les CLI vivants
s'arrêtent : leurs sessions deviennent « Interrompue » (reprenables) et `seed sessions` recrée une session
« autorisation demandée » et une « en cours » neuves (les ids de `state.json` sont mis à jour) ; la session « export
CSV » garde ses changements mais n'est plus vivante. Relire `state.json` (fixture `stack`) plutôt que de garder des ids.

### Connexion MCP d'une session (`mcp-connect.mjs`)

`node apps/web/e2e/harness/mcp-connect.mjs <mcp.json> <serveur>` fait ce que Claude Code fait à la connexion d'un
serveur HTTP de son `--mcp-config` : exécute son `headersHelper` (`bin/nuera-mcp-headers.mjs` du runner, avec
`CLAUDE_CODE_MCP_SERVER_NAME/_URL` et l'environnement de la session), puis envoie `initialize` avec les en-têtes
obtenus. Il n'affiche que les **noms** des en-têtes et le statut HTTP. À lancer depuis une étape `bash` (`run: true`,
`ask: false`) du faux CLI ; `mcp.json` = `runner-data/sessions/<id>/mcp.json`. Serveurs MCP et Coolify factices :
`apps/web/src/server/mcp/test/fake-mcp.ts`, `apps/web/src/server/coolify/test/fake-coolify.ts` (cf.
`parcours-5-mcp-diagnostic.spec.ts`).

### Faux CLI Claude (`apps/runner/test/fixtures/fake-claude.mjs`)

Le runner le lance comme le vrai binaire (`NUERA_CLAUDE_BIN`), dans un vrai PTY ; il exécute les hooks officiels avec
des charges réalistes. Ses extensions de pile ne s'activent qu'avec un `CLAUDE_CONFIG_DIR` isolé (celui de la pile) :

- une instruction en français simple déclenche le script dont une phrase `match` apparaît (voir `scenarios.ts` :
  `lecture`, `remise`, `parcours`, `fidelite`, `export-csv`, `export-csv-suite`, `essai`, `auth`, `limite`), ou
  `scenario:<nom>` explicitement ;
- étapes : `plan`, `say`, `read`, `grep`, `glob`, `edit` / `write` / `remove` (modifient **vraiment** le worktree, avec
  demande d'autorisation selon le mode), `bash` (`run: true` l'exécute vraiment), `wait` (étape longue à sortie continue,
  annulée par Échap), `fail` (`authentication_failed`, `rate_limit`…), `final`, `pause` ;
- `claude auth status` suit `nuera-fake-claude.json` (`stack.mjs claude deconnecte`) ; `/status`, `/usage`,
  `auth login`, `mcp login` existent pour les terminaux de connexion.

## 6. Playwright

`pnpm --filter @nuera/web e2e [fichiers]` lance la suite contre la pile `E2E_STACK` :

| Variable | Défaut | Rôle |
|---|---|---|
| `E2E_STACK` | `e2e` | nom de la pile (`.data/stacks/<nom>/`) |
| `E2E_WEB_PORT` (alias `E2E_PORT`) | `state.json`, sinon convention (3102 pour `e2e`) | port du web |
| `E2E_RUNNER_PORT`, `E2E_HOOK_PORT`, `E2E_GITHUB_PORT` | web + 1000 / + 1001 / + 1002 | autres ports |
| `E2E_DATABASE` | `nuera_<pile>` | base |
| `E2E_PG_URL` | `postgres://nuera:nuera@127.0.0.1:54329` | serveur PostgreSQL (sans base) |
| `E2E_RESET=1` | — | recrée la pile avant la suite |
| `E2E_PRISTINE=1` | — | pile sans propriétaire : le projet `configuration` le crée par `/configuration` |
| `E2E_SEED` | `all` | scénarios lancés avant les specs (`none` pour aucun) |
| `E2E_DOWN=1` | — | arrête la pile à la fin (elle reste lancée sinon) |
| `E2E_CHROMIUM_PATH` | build installé | Chromium à utiliser ; sans lui, si la révision attendue par Playwright manque, la plus récente installée sous `PLAYWRIGHT_BROWSERS_PATH` est prise |

Déroulement : *global setup* = `up` (réutilise la pile si elle tourne ; une pile créée par ce lancement démarre sans
propriétaire) → projet `configuration` (test `@configuration` d'`auth.spec.ts`, ignoré si le propriétaire existe déjà)
→ projet `stack` (`e2e/stack.setup.ts` : propriétaire, GitHub, `E2E_SEED`) → projets **`desktop`** (1440×1000) et
**`mobile`** (390×844, `isMobile`, `hasTouch`). Un seul worker.

```ts
import { test, expect } from './fixtures';

test('…', async ({ page, stack, runnerApi, seed, waitForSessionStatus, cli }) => {
  const devis = stack.seeded.projects!.devis!;                       // ids de state.json
  await page.goto(`/projets/${devis.id}`);                           // page déjà connectée (storage state)
  const session = await cli.createSession({ title: 'Essai', branch: 'test/essai' });   // comme le web
  await cli.sendInstruction(session.id, await cli.script('mon-essai', { description: 'x', steps: [{ final: 'Fait.' }] }));
  await waitForSessionStatus(session.id, 'waiting_input');
  const permission = await cli.waitForPermission(otherId);           // puis cli.answerPermission(permission.id, 'allow')
  await runnerApi('getSession', { params: { sessionId: session.id } });
  await seed('runs');                                                // idempotent
});
```

Fixtures (`e2e/fixtures/index.ts`, fonctions aussi exportées hors fixtures dans `fixtures/stack.ts`) : `page` connectée
(mot de passe + TOTP une fois par worker), `stack` (`state.json`), `runnerApi(route, input)` (appels typés au runner de
la pile, contrat `RUNNER_ROUTES`), `seed(...scénarios)`, `waitForSessionStatus(id, statut | statuts, { timeoutMs, where })`,
`cli` (`createSession`, `sendInstruction`, `waitForPermission`, `answerPermission`, `waitForTurn`, `typeInTerminal`,
`script`, `setLoggedIn`). Propriétaire : `createOwnerAndSignIn`, `signIn`, `signOut`, `totpCode`, `readOwnerState`
(`fixtures/owner.ts`).

Résultats et traces : `apps/web/test-results/<pile>/` (un dossier par pile : Playwright vide le sien au démarrage,
deux lots peuvent lancer leur suite en même temps).

Lancer la suite d'un lot sur sa pile : `E2E_STACK=<pile> pnpm --filter @nuera/web e2e <lot>.spec.ts` (ou
`--project=desktop`). Les sessions créées par un test sont à arrêter en fin de test (`runnerApi('stopSession', …)`)
pour libérer leur place.

## 7. Dépannage

- **« PostgreSQL ne répond pas »** : `pnpm db:local` (port 54329). Une seule instance pour toutes les piles.
- **« Le port N … est déjà utilisé »** : une autre pile ou un ancien processus ; `stack.mjs status --name <pile>`, puis
  `down`. Linux/macOS : `lsof -nP -iTCP:N -sTCP:LISTEN` ; Windows : `netstat -ano | findstr :N`.
- **Le web ne démarre pas / 500** : `stack.mjs logs web --name <pile>`. Une compilation à froid peut prendre plusieurs
  minutes (délais ≥ 4 min partout). Supprimer `apps/web/.next-<pile>` si le cache est corrompu.
- **Les pages se rechargent en boucle** (formulaires vidés, `reloadPage: HMR hash mismatch` dans la console) : cache
  Turbopack de `next dev` abîmé par un arrêt brutal. `up` / `restart web` le détectent (5 s de navigation sur
  `/connexion`), suppriment `apps/web/.next-<pile>/dev/cache/turbopack` et relancent le web ; `down` laisse ~20 s à
  `next dev` pour s'arrêter proprement. Ne pas tuer `next dev` par `kill -9`.
- **Pile dans un état incohérent** (base remise à zéro à la main, propriétaire sans `owner.json`) : `up --reset`.
- **« Session expirée : relancez `login` »** : les sessions web expirent après inactivité ; `login` en refait une.
- **Chromium introuvable** (`Executable doesn't exist`) : `E2E_CHROMIUM_PATH=/chemin/chrome` ou installer la révision
  attendue (`pnpm --filter @nuera/web exec playwright install chromium` quand c'est permis).
- **Windows** : PTY par `@lydell/node-pty`, arrêt des arbres par `taskkill /T /F`, ports lus par `netstat` ; un
  antivirus peut ralentir `git`/`node` de plusieurs secondes (délais déjà larges). Git Bash : `MSYS_NO_PATHCONV=1` pour
  passer des chemins d'URL à d'autres outils.
- **Linux (conteneur, root)** : `lsof` est requis pour `down` / la vérification des ports ; `tmux` n'est pas utilisé
  (backend `pty`, comme sous Windows, pour que les sessions meurent avec le runner).
- **`tsc` : TS2882 sur `./.next-<pile>/dev/types/routes.d.ts`** : `next dev` d'une pile réécrit `apps/web/next-env.d.ts`
  (généré, non suivi) vers son dossier `.next-<pile>` ; `down --purge` retire ces imports s'ils pointent vers la pile
  supprimée. Sinon relancer `next dev`/`next build`, ou supprimer les lignes `import "./.next-…"` du fichier.
- Le verrou `.data/stacks/<pile>/.lock` sérialise `up` / `seed` / `down` entre processus ; un verrou dont le processus a
  disparu est repris automatiquement.
