# Tests — vue d'ensemble

Trois niveaux, tous locaux (aucun test ne dépend d'Internet). Les fixtures ne vivent que dans les tests
(`**/test/**`, `**/*.test.ts`, `apps/web/e2e/`) : aucune donnée métier codée en dur dans l'application.

```bash
pnpm db:local                       # PostgreSQL 17 local (port 54329) — requis par les tests base de données et e2e
pnpm typecheck && pnpm lint         # tsc strict (4 paquets) + oxlint
pnpm test                           # Vitest dans chaque paquet
pnpm --filter @nuera/web e2e        # Playwright contre une pile de test locale
```

## 1. Unitaires et intégration (Vitest)

| Paquet | Ce qui est testé | Particularités |
|---|---|---|
| `packages/shared` | schémas Zod du contrat runner⇄web, événements SSE, garde des chemins, formatage fr-FR | purs |
| `packages/db` | migrations, contraintes (propriétaire unique…) | base dédiée sur le PostgreSQL local |
| `apps/runner` | Git (vrais dépôts temporaires, dépôt nu local en `origin`), worktrees, PTY réels, sessions Claude avec le **faux CLI de test** `test/fixtures/fake-claude.mjs` (`NUERA_CLAUDE_BIN`), hooks, processus du projet, terminaux | base `nuera_runner_test` recréée ; fichiers exécutés en séquence (`vitest.config.ts`) ; voir `apps/runner/README.md` § Tests |
| `apps/web` (`src/**/*.test.ts(x)`) | modules serveur (auth, sécurité, GitHub contre `src/server/github/test/fake-github.ts`, Coolify, MCP, notifications, Web Push contre un faux service), routes d'API, logique client non triviale | une base PostgreSQL **par fichier** (`src/server/integrations/test/db.ts`, `nuera_integrations_<suite>`) car Vitest exécute les fichiers en parallèle ; `server-only` neutralisé dans `vitest.config.ts` |

Lancer une partie : `pnpm --filter @nuera/web exec vitest run src/server/github`,
`pnpm --filter @nuera/runner exec vitest run test/sessions.test.ts`.

Règles : un test qui touche la base crée **sa** base (jamais `nuera_dev`) ; les faux services (GitHub, push, MCP)
démarrent sur un port aléatoire dans le test ; aucun accès à `~/.claude` ni au vrai CLI.

## 2. Pile de test locale (harness)

`apps/web/e2e/harness` monte une application complète et isolée : base dédiée, faux GitHub (API + pages github.com du
flux *manifest*), **vrai runner** depuis les sources (backend PTY, faux CLI Claude, dépôts nus locaux comme
remotes), **vrai web** (`next dev`), propriétaire créé par la vraie page `/configuration` (TOTP), application GitHub
connectée par les vraies routes, données de démonstration créées par les vraies routes du runner (`seed`).

```bash
node apps/web/e2e/harness/stack.mjs up    --name <pile> --web-port <N>   # runner N+1000, hooks N+1001, GitHub N+1002
node apps/web/e2e/harness/stack.mjs seed  --name <pile> all
node apps/web/e2e/harness/stack.mjs login --name <pile>
node apps/web/e2e/harness/stack.mjs shot  --name <pile> /projets --mobile
node apps/web/e2e/harness/stack.mjs down  --name <pile> [--purge]
```

Chaque lot / agent utilise **son** nom de pile, ses ports et sa base : plusieurs piles tournent en même temps.
Référence complète (options, `state.json`, scénarios, faux CLI, dépannage Linux/Windows) :
[apps/web/e2e/harness/README.md](../apps/web/e2e/harness/README.md).

## 3. Bout en bout (Playwright)

- Configuration : `apps/web/playwright.config.ts`. Chromium seulement ; projets `configuration` (création du
  propriétaire sur une pile neuve), `stack` (propriétaire + GitHub + `E2E_SEED`), **`desktop`** (1440×1000) et
  **`mobile`** (390×844, tactile). Un worker.
- La pile est choisie par `E2E_STACK` (défaut `e2e`, web 3102) ; `E2E_RESET=1`, `E2E_PRISTINE=1`, `E2E_SEED`,
  `E2E_DOWN=1`, ports et base surchargeables (`E2E_WEB_PORT`…). Le *global setup* démarre la pile ou réutilise celle
  qui tourne ; elle reste lancée après la suite (relances rapides).
- Fixtures (`apps/web/e2e/fixtures`) : page connectée, `stack`, `runnerApi`, `seed`, `waitForSessionStatus`, `cli`
  (piloter et répondre au faux CLI), helpers du propriétaire.
- Specs : `auth.spec.ts` (configuration, connexion TOTP / code de secours, refus), `smoke.spec.ts` (shell connecté,
  runner joignable, GitHub connecté via le faux GitHub, statut de session reçu par `/api/stream/events`), puis une spec
  par domaine (`<lot>.spec.ts`).

```bash
pnpm --filter @nuera/web e2e                                         # pile e2e, toute la suite
E2E_STACK=projets pnpm --filter @nuera/web e2e projets.spec.ts --project=mobile
E2E_STACK=e2e E2E_RESET=1 E2E_DOWN=1 pnpm --filter @nuera/web e2e   # comme en CI : pile neuve, arrêtée à la fin
```

Pièges connus : toujours `http://localhost:<port>` (jamais `127.0.0.1`, la page ne s'hydrate pas sous `next dev`) ;
captures de longues pages à horloges vivantes : défiler puis `page.screenshot({ clip })` ; Radix Select n'affiche sa
valeur qu'après hydratation. Liste complète : `CLAUDE.md` § Leçons et pièges confirmés.

## 4. Captures et comparaison Figma

`stack.mjs shot` produit des captures connectées à 1440×1000 et 390×844 ; les exports Figma de référence sont dans
`.design-refs/screens/<code>.png` (non versionné, index `INDEX.md`). Chaque lot compare ses pages côte à côte avec les
écrans de son brief avant de livrer.
