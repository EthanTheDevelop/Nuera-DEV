# Tests — vue d'ensemble

Trois niveaux, tous locaux (aucun test ne dépend d'Internet). Les fixtures ne vivent que dans les tests
(`**/test/**`, `**/*.test.ts`, `apps/web/e2e/`) : aucune donnée métier codée en dur dans l'application.

```bash
pnpm db:local                       # PostgreSQL 17 local (port 54329) — requis par les tests base de données et e2e
pnpm typecheck && pnpm lint         # tsc strict (4 paquets) + oxlint
NUERA_REQUIRE_PG=1 pnpm test        # Vitest dans chaque paquet (échoue si PostgreSQL manque, au lieu d'ignorer)
pnpm --filter @nuera/web test:harness   # tests unitaires de la pile de test elle-même
pnpm --filter @nuera/web e2e        # Playwright contre une pile de test locale (2 comptes, 2 serveurs)
```

## 1. Unitaires et intégration (Vitest)

| Paquet | Ce qui est testé | Particularités |
|---|---|---|
| `packages/shared` | schémas Zod du contrat runner⇄web (v2), jetons, événements SSE (`stream.hello`), garde des chemins, formatage fr-FR | purs |
| `packages/db` | base neuve (`migrations.test.ts`), **montée de version 0000 → 0004** sur une base remplie comme la production (`migrations.upgrade.test.ts`, plus une base sans compte et une sans réglages), contraintes multi-comptes (`constraints.test.ts`), rôles restreints et RLS du runner (`rls.test.ts`), lien de récupération (`recovery.test.ts`) | base dédiée par suite sur le PostgreSQL local ; `NUERA_DB_TEST_PREFIX`, `NUERA_MIGRATIONS_TEST_DB`, `NUERA_PG_ADMIN_URL` ; les rôles de connexion créés par un test portent le nom de sa base et sont supprimés après elle |
| `apps/runner` | Git (vrais dépôts temporaires, dépôt nu local en `origin`), worktrees, PTY réels, sessions Claude avec le **faux CLI de test** `test/fixtures/fake-claude.mjs` (`NUERA_CLAUDE_BIN`), hooks, processus du projet, terminaux, **deux runners sur une même base** (reprise, planificateur, listes, verrou), suite exécutée avec un rôle restreint | base `nuera_runner_test` recréée ; fichiers exécutés en séquence (`vitest.config.ts`) ; voir `apps/runner/README.md` § Tests |
| `apps/web` (`src/**/*.test.ts(x)`) | modules serveur (contexte et cloisonnement, auth, administration, sécurité, GitHub contre `src/server/github/test/fake-github.ts`, Coolify, MCP, notifications et push par destinataire, réglages par portée), routes d'API (suite d'**isolation** pilotée par table : B reçoit le 404 « inconnu » sur chaque route à identifiant, zéro appel runner, zéro écriture), logique client non triviale | une base PostgreSQL **par fichier** car Vitest exécute les fichiers en parallèle ; fixtures `twoSpaces()` (`src/server/tenancy/test/`) ; `server-only` neutralisé dans `vitest.config.ts` |
| `apps/web/e2e/harness` (`test:harness`) | ports et dossiers de N serveurs, `state.json` v1 → v2, lecture de `netstat` (anglais, allemand, IPv6), ligne de commande, chemins portables, faux GitHub à plusieurs applications (liaison par propriétaire, noms uniques ≤ 34 caractères, JWT routés par émetteur, numéros de pull request par dépôt) | sans pile ni base (`e2e/harness/vitest.config.ts`) |

Lancer une partie : `pnpm --filter @nuera/web exec vitest run src/server/github`,
`pnpm --filter @nuera/runner exec vitest run test/sessions.test.ts`.

Règles : un test qui touche la base crée **sa** base (jamais `nuera_dev`) et ses rôles (nommés d'après elle) ; les faux
services (GitHub, push, MCP) démarrent sur un port aléatoire dans le test ; aucun accès à `~/.claude` ni au vrai CLI.
`NUERA_REQUIRE_PG=1` transforme l'absence de PostgreSQL en échec (à utiliser avant tout push).

## 2. Pile de test locale (harness)

`apps/web/e2e/harness` monte une application complète et isolée : base dédiée, faux GitHub à plusieurs applications
(API + pages github.com du flux *manifest*), **un vrai runner par serveur** depuis les sources (backend PTY, faux CLI
Claude, dépôts nus locaux comme remotes), **vrai web** (`next dev`), et **N comptes** :

- compte **A** (Camille Laurent) = propriétaire, créé par la vraie page `/configuration` (TOTP), sur le serveur par
  défaut « VPS-3 » (runner A, `RUNNER_URL` / `RUNNER_TOKEN`) ;
- compte **B** (Hugo Martin) = membre, invité par l'administration et activé par la vraie page `/invitation/<jeton>`
  (double facteur obligatoire), sur son serveur « VPS-4 » (runner B enregistré par l'administration : jeton affiché une
  fois, **rôle PostgreSQL restreint** `RUNNER_DATABASE_URL`) ;
- une source GitHub par espace connectée par les vraies routes (applications `a` et `b` du faux GitHub) ; données de
  démonstration par compte créées par les vraies routes du web et du runner (`seed`, `seed --as b`).

```bash
node apps/web/e2e/harness/stack.mjs up    --name <pile> --web-port <N> --accounts 2   # runner B N+1010, hooks B N+1011
node apps/web/e2e/harness/stack.mjs seed  --name <pile> all
node apps/web/e2e/harness/stack.mjs seed  --name <pile> --as b projects,sessions,notifications
node apps/web/e2e/harness/stack.mjs login --name <pile> --as b
node apps/web/e2e/harness/stack.mjs shot  --name <pile> /projets --mobile
node apps/web/e2e/harness/stack.mjs down  --name <pile> [--purge]
```

Chaque lot / agent utilise **son** nom de pile, ses ports et sa base : plusieurs piles tournent en même temps (ports web
espacés d'au moins 30). Référence complète (options, `state.json`, scénarios, faux CLI, dépannage Linux/Windows) :
[apps/web/e2e/harness/README.md](../apps/web/e2e/harness/README.md).

## 3. Bout en bout (Playwright)

- Configuration : `apps/web/playwright.config.ts`. Chromium seulement ; projets `configuration` (création du
  propriétaire sur une pile neuve), `stack` (propriétaire + GitHub, puis serveur B, compte B et sa source quand
  `E2E_ACCOUNTS` ≥ 2, puis `E2E_SEED` / `E2E_SEED_B`), **`desktop`** (1440×1000) et **`mobile`** (390×844, tactile).
  Un worker. Délai par test : 180 s (270 s avec deux comptes).
- La pile est choisie par `E2E_STACK` (défaut `e2e`, web 3102, **2 comptes**) ; `E2E_ACCOUNTS` (1 par défaut pour une
  autre pile), `E2E_RESET=1`, `E2E_PRISTINE=1`, `E2E_SEED`, `E2E_SEED_B`, `E2E_DOWN=1`, ports et base surchargeables
  (`E2E_WEB_PORT`…). Le *global setup* démarre la pile ou réutilise celle qui tourne ; elle reste lancée après la suite.
- Fixtures (`apps/web/e2e/fixtures`) : page connectée (compte A), `stack` (`accounts[]`, `runners[]`, `githubApps[]`,
  `owner` = compte A), `runnerApi`, `seed`, `waitForSessionStatus`, `cli`, **`as('b', { mobile })`** (autre compte dans
  son propre contexte, avec son `runnerApi` et son `cli`), `loginAs(page, 'b')`, `requireAccounts(2)`, helpers
  d'administration (`invite`, `adminCall`, `COPY`), `samePath` / `deviceLabelOf` (Windows et Linux).
- Specs : `auth.spec.ts`, `smoke.spec.ts`, une spec par domaine (`<lot>.spec.ts`), les parcours (`parcours-*.spec.ts`)
  et les specs **multi-comptes** (`@comptes`, bureau seulement, ignorées avec un seul compte) : `isolation.spec.ts`
  (404 identique sur chaque route, listes, flux, routes internes, runner), `simultane.spec.ts` (deux sessions en même
  temps sur deux serveurs, capacité, commits et PR avec l'identité et la source de chacun, redémarrage d'un runner,
  T5/T6), `comptes-invitation.spec.ts` (invitation, 2FA obligatoire, reprise, liens refusés),
  `administration.spec.ts` (comptes, serveurs : enregistrement, vérification, attribution et ses gardes ;
  désactivation, renouvellement du jeton, réglages de l'instance, journal),
  `github-sources.spec.ts` (deux sources dans un espace), `mise-a-niveau.spec.ts` (`E2E_UPGRADE=1` : pile créée avant
  la refonte puis migrée sur place).

```bash
pnpm --filter @nuera/web e2e                                                      # pile e2e, toute la suite
node apps/web/e2e/harness/stack.mjs e2e --name projets -- projets.spec.ts --project=mobile   # PowerShell, cmd ou Git Bash
node apps/web/e2e/harness/stack.mjs env --name projets --format powershell        # variables E2E_* pour un autre outil
E2E_STACK=e2e E2E_RESET=1 E2E_DOWN=1 pnpm --filter @nuera/web e2e                # (POSIX) comme en CI : pile neuve, arrêtée à la fin
```

Pièges connus : toujours `http://localhost:<port>` (jamais `127.0.0.1`, la page ne s'hydrate pas sous `next dev`) ;
captures de longues pages à horloges vivantes : défiler puis `page.screenshot({ clip })` ; Radix Select n'affiche sa
valeur qu'après hydratation ; sous Windows, `git worktree list` écrit `P:/…` quand Node écrit `P:\…` (comparer avec
`samePath`), `cmd.exe` n'a pas de `sleep` (script `node scripts/attendre.js N` des dépôts de test), le libellé
d'appareil dépend du navigateur réel (`deviceLabelOf`). Liste complète : `CLAUDE.md` § Leçons et pièges confirmés.

## 4. Captures et comparaison Figma

`stack.mjs shot` produit des captures connectées à 1440×1000 et 390×844 (`--as b` pour le second compte) ; les exports
Figma de référence sont dans `.design-refs/screens/<code>.png` (non versionné, index `INDEX.md`). Chaque lot compare ses
pages côte à côte avec les écrans de son brief avant de livrer. Les écrans sans Figma (administration, invitation,
récupération, « Aucun serveur attribué », « Premiers pas ») sont construits avec les seules primitives existantes.
