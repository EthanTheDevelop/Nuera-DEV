# CLAUDE.md — Nuera Dev

Application personnelle de Nuera Studio : ouvrir les dépôts GitHub clonés sur VPS-3, piloter des sessions du CLI
officiel Claude Code, suivre leur exécution, répondre aux autorisations, consulter fichiers et diffs, puis committer,
pousser et ouvrir des pull requests — depuis un PC ou un téléphone.

## À lire avant de coder

- `docs/ARCHITECTURE.md` — architecture, contrats, sécurité, arbitrages (référence technique).
- `docs/PROGRESS.md` — suivi d'avancement (à tenir à jour à chaque lot terminé).
- `docs/figma/*.md` — spécifications extraites de Figma (autorité visuelle) ; captures, code de référence et assets
  dans `.design-refs/` (non versionné ; à régénérer via le MCP Figma, fichier `nlvRWAtD1x2fKf8gVgcM0g`).
- `docs/research/claude-code.md` (intégration et conformité Claude Code), `integrations.md` (GitHub, Coolify, Figma,
  MCP), `stack.md` (versions et pièges).

## Règles absolues

1. **Claude Code** : uniquement le binaire officiel non modifié, en session **interactive** (PTY / tmux). Jamais de
   `claude -p`, `--output-format stream-json`, Agent SDK `query()`, `claude setup-token`, `CLAUDE_CODE_OAUTH_TOKEN`.
   Ne jamais lire, copier ou transmettre `~/.claude/.credentials.json` ni les champs de compte de `~/.claude.json`.
   Aucun formulaire de jeton Claude. Aucune métrique de coût/quota inventée.
2. **Aucun faux état** : pas de données métier codées en dur, pas de mock permanent, pas de bouton mort. Les fixtures
   vivent uniquement dans les tests (`**/test/**`, `**/*.test.ts`, `e2e/`).
3. **Sécurité** : toute route/action serveur appelle `requireUser()` ; toute mutation vérifie l'Origin ; les secrets
   sont chiffrés (AES-256-GCM) et jamais renvoyés au client ; actions sensibles journalisées dans `audit_log`.
4. **Runner** : seul composant qui touche au disque des projets, à Git, aux PTY et aux processus. `execFile` avec
   tableau d'arguments, jamais de shell ; chemins confinés (`realpath`) ; environnement nettoyé.
5. **Commits** : messages conventionnels sobres (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`), sans
   aucune mention d'IA/agent/outil de génération, sans trailer `Co-authored-by`. Inspecter le diff avant de committer.
6. **Copie UI** : textes français identiques à Figma — accents, apostrophe **droite** `'` (la page NUERA DEV n'emploie
   jamais `’`), points médians `·`, guillemets « » espacés, points de suspension `…`.

## Commandes

```bash
pnpm install                 # dépendances (pnpm 9, Node ≥ 22.12 — testé sous Node 24)
pnpm db:local                # PostgreSQL 17 local (embedded-postgres, port 54329, données dans .data/pg)
pnpm db:migrate              # applique packages/db/drizzle
pnpm db:generate             # génère une migration après modification du schéma
pnpm dev                     # web (http://localhost:3000) + runner (http://127.0.0.1:4100)
pnpm typecheck && pnpm lint && pnpm test
pnpm --filter @nuera/web e2e # parcours Playwright
```

## Structure

```
apps/web        Next.js 16 (App Router) — UI, API, auth (Better Auth + 2FA), intégrations GitHub/Coolify
apps/runner     service d'exécution (Fastify) — Git, worktrees, PTY, sessions Claude (tmux), processus, métriques
packages/db     schéma Drizzle + migrations + client
packages/shared contrats Zod runner⇄web, types d'événements, formatage FR, garde des chemins
deploy/         Dockerfiles, compose Coolify, sauvegarde/restauration
```

## Conventions

- TypeScript strict partout ; validation Zod aux frontières (formulaires, route handlers, runner).
- Composants UI : `apps/web/src/components/ui` (primitives du design system) — réutiliser avant de créer.
  Couleurs/rayons/ombres via les tokens (`tokens.css` → classes Tailwind), jamais de valeurs en dur.
- Code serveur dans `apps/web/src/server/**` avec `import 'server-only'` ; les pages ne touchent pas la DB directement.
- Statuts en `text` typés (unions dans `packages/db/src/schema/types.ts`), pas d'enum PostgreSQL.
- Dates et nombres : `@nuera/shared/format` (fr-FR, Europe/Paris).

## Leçons et pièges confirmés

<!-- Ajouter ici, au fil du développement, les pratiques vérifiées : contexte → cause → solution → fichier. -->
- Poste de dev Windows sans Docker : PostgreSQL via `embedded-postgres`, PTY via `@lydell/node-pty` (binaires
  précompilés), pas de tmux → le runner bascule sur le backend PTY direct (`NUERA_SESSION_BACKEND=pty`).
- TypeScript 6.0.x (et non 7.x) : TS 7 (port natif) n'a pas d'API JS, l'outillage Next/Vitest n'est pas garanti. Lint = oxlint (`.oxlintrc.json`) : ESLint mettait plusieurs minutes par fichier sur le poste.
- État d'avancement exact, reste à faire et procédure de reprise : `README.md` §1–5 ; brief d'origine verbatim : `docs/reprise/BRIEF-ORIGINAL.md`.
- `next dev` (Next 16.4) écrit `apps/web/AGENTS.md` au démarrage (« Generated AGENTS.md ») → fichier non suivi à chaque lancement ; `agentRules: false` dans `next.config.ts` pour l'éviter.
- Texte de Claude : `react-markdown` 10 sans `rehype-raw` échappe le HTML brut et vide les liens `javascript:` → ne jamais ajouter `rehype-raw` (`components/dev/conversation/ClaudeMarkdown.tsx`).
- Galerie client avec dates d'exemple : passer `now` depuis la page serveur, sinon `formatTime` diffère entre SSR et hydratation (`app/(dev)/kit/composites/page.tsx`).
- Captures Playwright de longues pages à horloges vivantes : `fullPage` / capture d'élément expirent (attente de stabilité) → défiler puis `page.screenshot({ clip })`.
- Better Auth 1.7.17 valide le schéma Drizzle au démarrage (requêtes d'auth refusées sinon) et son plugin twoFactor
  exige `two_factor.verified/failed_verification_count/locked_until` → `packages/db/src/schema/auth.ts`.
- Better Auth : `disableSignUp` bloque aussi `auth.api.signUpEmail` côté serveur → le propriétaire est créé en
  transaction par `apps/web/src/server/auth/setup.ts` ; l'index `user_single_owner_idx` (`(true)`) garantit 1 ligne.
- Better Auth : `auth.api.*` n'est jamais limité en débit (seul le routeur HTTP l'est) → les actions serveur d'auth
  passent par `src/server/security/rate-limit.ts` ; `NUERA_RATE_LIMIT_FACTOR` (ignoré en prod) pour les e2e.
- Better Auth : les hooks `after` des plugins tournent dans l'ordre des plugins → l'audit des connexions vit dans
  `nueraAuthPlugin`, placé après `twoFactor` (avant lui, une connexion en attente de 2FA ressemble à une session).
- Vitest : `server-only` lève une erreur hors condition `react-server` → stub dans `apps/web/vitest.config.ts`.
- Playwright démarre `webServer` AVANT `globalSetup` : `/api/health` répond 200 même sans base ; l'init e2e
  (`e2e/fixtures/global-setup.ts`) recrée la base puis préchauffe les pages (compilation à froid de `next dev`).
- `next dev` à froid peut bloquer la boucle d'événements > 10 s : `connect_timeout` postgres.js à 30 s
  (`packages/db/src/index.ts`, `DATABASE_CONNECT_TIMEOUT`), sinon les premières requêtes échouent (CONNECT_TIMEOUT).
- `@octokit/auth-app` 8 garde ses jetons 59 min dans son propre cache : appeler `auth({ type: 'installation', …, refresh: true })` et tenir son cache (marge 5 min) ; lui passer `request: octokit.request` pour hériter de `GITHUB_API_URL` et de `X-GitHub-Api-Version` → `apps/web/src/server/github/tokens.ts`.
- web-push 3.6 envoie toujours via `https.request` : chiffrer avec `webpush.generateRequestDetails()` puis POST avec `fetch` (testable avec un faux service de push) → `apps/web/src/server/push/index.ts`.
- Next 16 : `generateImageMetadata` dans `app/icon.tsx` sert des URL stables `/icon/<id>` (utilisables dans `manifest.ts`) ; satori rend un `<svg>` inline de glyphes vectorisés, sans fichier de police → `apps/web/src/server/push/app-icon.tsx`.
- Next augmente `NodeJS.ProcessEnv` avec un `NODE_ENV` obligatoire : une fonction qui reçoit un objet d'environnement doit accepter `Record<string, string | undefined>` (sinon `{}` ne compile pas dans les tests).
- Contrat runner : dans `--mcp-config`, `headersHelper` ne peut valoir que `'nuera'` (le runner y substitue `bin/nuera-mcp-headers.mjs`) ; aucun en-tête secret dans la config → `apps/web/src/server/mcp/session-config.ts`.
- Vitest exécute les fichiers en parallèle : une base PostgreSQL par fichier de test (`nuera_integrations_<suite>`, créée et migrée par `src/server/integrations/test/db.ts`, recréée si la migration 0000 a été régénérée).
- `next dev` (16.4) bloque les ressources de dev venant d'une autre origine que `localhost` : ouvrir `http://127.0.0.1:<port>` refuse le websocket HMR et la page **ne s'hydrate jamais** (aucune erreur visible) → Playwright et navigateur sur `http://localhost:<port>` (ou `allowedDevOrigins`).
- Galerie `/kit` en capture : `proxy.ts` redirige sans cookie de session même avec `NUERA_KIT_PUBLIC=1` → poser un cookie factice `nuera.session_token` (le proxy est optimiste ; le layout `(dev)` saute `requireUser()` sous ce drapeau en dev) ; sous Git Bash, `MSYS_NO_PATHCONV=1` sinon l'argument `/kit` devient `C:/Program Files/Git/kit`.
- tailwind-merge ignore les tailles `text-app-*` : sans `extendTailwindMerge`, `twMerge('text-app-14 text-muted')` supprime la taille → toujours `cn()` de `apps/web/src/lib/cn.ts`.
- `useSyncExternalStore` : `getServerSnapshot` doit renvoyer une valeur stable (constante), sinon « should be cached to avoid an infinite loop » → `apps/web/src/components/ui/Toast.tsx`.
- Radix Select n'affiche la valeur choisie (`Select.Value`) qu'après hydratation (le texte de l'option est porté depuis un fragment monté côté client) : une capture d'une page non hydratée montre un champ vide.
- Le dossier scratchpad est partagé entre agents parallèles : y travailler dans un sous-dossier propre au lot (`uikit/…`), des noms génériques (`shots/`) se télescopent.
- `@lydell/node-pty`, `@xterm/headless` et `@xterm/addon-serialize` sont CommonJS : `import * as ns` puis `ns.X ?? ns.default.X` fonctionne sous tsx, Vitest et esbuild → `apps/runner/src/terminals/terminal.ts`.
- Fastify 5.12 : `disableRequestLogging` est déprécié (FSTDEP023) et `loggerInstance: <pino>` type l'instance avec le `Logger` pino (non assignable à `FastifyInstance`) → caster en `FastifyBaseLogger`, logger enfant `warn` pour l'écoute des hooks → `apps/runner/src/app.ts`.
- Node : `request.raw` émet `close` dès que la requête est lue (pas à la déconnexion) → flux SSE et attente du hook `PermissionRequest` écoutent `reply.raw.on('close')` ; et le hook utilise `node:http` (l'undici de `fetch` coupe à 300 s d'attente des en-têtes) → `apps/runner/src/sessions/hook-server.ts`, `apps/runner/bin/nuera-hook.mjs`.
- Relais SSE : ne jamais passer `AbortSignal.timeout()` au `fetch` d'un flux (il coupe aussi la lecture du corps) ; limiter la minuterie à la connexion → `apps/web/src/server/runner/stream.ts`.
- `git branch -d` accepte une branche fusionnée dans son amont déjà poussé, même si HEAD ne la contient pas : la suppression de worktree (`deleteBranch`) garde seulement les branches ni poussées ni fusionnées → `apps/runner/src/git/service.ts`.
- Poste Windows chargé (lots en parallèle, antivirus) : un `git`/`node` peut mettre plusieurs secondes à démarrer et un `rm` de dossier temporaire dépasser 10 s → tests runner séquentiels, délais larges, `afterAll` avec délai explicite (`apps/runner/vitest.config.ts`).
- `@next/env` met en cache son premier `loadEnvConfig` (celui de Next sur `apps/web`, sans `.env`) : l'appel de `next.config.ts` sur la racine du dépôt est alors sans effet et `next dev` démarre **sans** les variables du `.env` racine (« RUNNER_TOKEN n'est pas configuré côté web » sur `/api/stream/events`) → passer `forceReload` (4e argument) ou fournir les variables dans l'environnement du processus.
- Le PAT GitHub de secours (`GITHUB_FALLBACK_TOKEN`) ne peut être ni limité à un dépôt ni réduit à la lecture : il sert à l'API et à Git (runner) mais n'est jamais servi au serveur MCP GitHub d'une session (écarté de `--mcp-config`, `403` sur `/api/internal/mcp-headers`) → `apps/web/src/server/mcp/headers.ts`.
- Coolify n'expose les capacités d'un jeton que par la liste d'outils de son serveur MCP (`tools/list`) : sans MCP joignable à la reconnexion, le jeton est enregistré mais gardé hors de portée de Claude jusqu'à un test MCP réussi sans outil `manage_*`/`create_*` (`coolifyTokenRefusal`) → `apps/web/src/server/mcp/headers.ts`, `mcp/diagnostics.ts`.
- Proxy paresseux sur un client Drizzle : ne lier (`bind`) que les méthodes du prototype ; `$client` (postgres.js) est une fonction porteuse de méthodes (`end`, `unsafe`) que le `bind` fait disparaître → `apps/web/src/server/db.ts`.
- Vitest avec le vrai Better Auth : `vi.mock('next/headers')` sert `headers()`/`cookies()` au code testé, mais `nextCookies` (dépendance externe) charge le vrai module et ignore `cookies()` hors requête → lire les cookies via `returnHeaders: true` → `apps/web/src/server/auth/auth-flows.test.ts`.
- `@nuera/shared/format` (Intl) lève `RangeError: Invalid time value` sur une date invalide : une seule date malformée casse tout le rendu → valider la date avant de la formater (`formatLiveTime`, `apps/web/src/components/dev/status/LiveTime.tsx`).
- Git : `GIT_CONFIG_COUNT/KEY/VALUE` ne l'emporte que sur une clé de **même nom** ; dans un `.git/config` que Claude peut modifier, `http.<url>.sslVerify=false` (ou `.proxy`), `url.<x>.insteadOf`, `protocol.<x>.allow` ou `[remote "<url>"]` battent nos surcharges → toute commande Git réseau lit d'abord `git config --list --show-scope -z` et refuse ces clés (`GIT_CONFIG_UNSAFE`), et chaque `protocol.<nom>.allow` est figé → `apps/runner/src/git/git.ts`.
- Sessions : un double clic (ou `start` + instruction) lançait deux `claude --session-id` identiques (le second écrasait le jeton de hook, l'instruction du premier était perdue) → un seul point d'entrée `launch()` avec test-et-réservation synchrones (`launching`), plafond et worktree revérifiés sans `await` avant l'enregistrement → `apps/runner/src/sessions/manager.ts`.
- Claude Code n'exécute pas le hook `Stop` après une interruption (Échap) : sans correction la session reste « En cours » → le runner rétablit `waiting_input` et ferme les lignes d'outil restées en cours si aucun hook d'activité ne suit dans les 2,5 s (`settleAfterInterrupt`, aussi pour Échap / Ctrl+C tapés dans le terminal brut) → `apps/runner/src/sessions/manager.ts`.
- Lecteur tolérant du journal (`transcript_path`) : ses lectures périodiques prennent la file de la session (`runExclusive`), sinon elles concurrencent le hook `Stop` (message final en double, conflit d'index de position) → `apps/runner/src/sessions/transcript.ts`.
- `router.refresh()` sans réseau (Next 16.4) : « Failed to fetch RSC payload… Falling back to browser navigation » → navigation complète et page d'erreur du navigateur à la place du bandeau W7 → ne jamais rafraîchir à l'aveugle quand le flux tombe : sonde du flux (401/403 ⇒ refresh vers `/connexion`), refresh seulement sur preuve de vie du runner → `apps/web/src/hooks/useLiveEvents.tsx`.
- Un `EventSource` recréé à la main ne renvoie pas `Last-Event-ID` (seule la reconnexion automatique du navigateur le fait) : passer `?lastEventId=<dernier id>` (le relais le transmet au runner, qui rejoue ou envoie `stream.reset`) → `apps/web/src/hooks/useLiveEvents.tsx`.
- Pile de test (`apps/web/e2e/harness`) : Playwright 1.64.1 attend `chromium_headless_shell-1248`, le conteneur n'a que la 1243 (et `playwright install` est interdit) → `harness/chromium.ts` prend la révision installée la plus récente (`E2E_CHROMIUM_PATH` pour forcer), utilisée par `stack.mjs` et `playwright.config.ts`.
- Pile de test : les seeds laissent 3 CLI vivants (autorisation demandée, en cours, export CSV) alors que « Sessions parallèles » vaut 4 par défaut → `seed sessions/changes` relève `app_settings.max_concurrent_sessions` à 8 ; un test qui crée une session l'arrête en fin de test (`stopSession`) pour libérer sa place.
- Faux CLI : une étape `remove` (commande `rm`) demande une autorisation même en mode `acceptEdits` (comme le vrai CLI pour Bash) → un seed qui l'emploie répond aux autorisations en route (`runTurn(…, { allowPermissions: true })`, `apps/web/e2e/harness/seed.ts`).
- xterm 6 : `xterm.css` peint `.xterm-viewport` en noir ; à une position fractionnaire (fenêtre centrée) il apparaît en lignes de 1 px au bord de l'écran du terminal → `[&_.xterm-viewport]:bg-transparent!` sur la racine (`apps/web/src/components/terminal/TerminalView.tsx`).
- `next dev` 16.4 (Turbopack) relancé sur un `.next-<pile>` dont le cache persistant a été coupé par un SIGKILL : chaque page se recharge en boucle (`turbopack-message … restart` sur la liste de chunks d'entrée puis `reloadPage: HMR hash mismatch`), les formulaires se vident pendant la saisie → arrêter `next dev` par SIGTERM en lui laissant ~20 s ; sinon supprimer `.next-<pile>/dev/cache/turbopack` (la pile de test détecte la boucle et le fait elle-même, `harness/stack.ts` `guardReloadLoop`).
- Radix (Dialog/Sheet) écoute Échap sur `document` en capture, avant l'élément ciblé : dans une feuille, Échap tapé dans xterm fermait la feuille (et le terminal de connexion) → `TerminalView` prend Échap sur `window` en capture quand la cible est sa zone de saisie et l'envoie lui-même au PTY (`apps/web/src/components/terminal/TerminalView.tsx`).
- `next dev` avec `NEXT_DIST_DIR=.next-<pile>` réécrit `apps/web/next-env.d.ts` (généré, non suivi) en `import "./.next-<pile>/dev/types/routes.d.ts"` ; ce dossier supprimé, TypeScript 6 échoue (TS2882, import à effet de bord introuvable) → `stack.mjs down --purge` retire ces imports (`apps/web/e2e/harness/stack.ts`), sinon relancer `next dev`/`next build`.
- Captures de `next dev` : l'indicateur « N » (`<nextjs-portal>`) couvre la carte utilisateur de la barre latérale et le premier onglet mobile → `stack.mjs shot` le masque ; une spec qui capture elle-même appelle `hideNextDevIndicator(page)` (`apps/web/e2e/fixtures`).
