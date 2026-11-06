# CLAUDE.md — Nuera Dev

Application de Nuera Studio : ouvrir les dépôts GitHub clonés sur un serveur, piloter des sessions du CLI officiel
Claude Code, suivre leur exécution, répondre aux autorisations, consulter fichiers et diffs, puis committer, pousser et
ouvrir des pull requests — depuis un PC ou un téléphone. **Multi-comptes** : chaque compte (propriétaire,
administrateur, membre ; 2FA obligatoire) travaille dans **son espace** et sur **son serveur** (une instance du runner,
une connexion Claude), sans jamais voir un autre espace.

## À lire avant de coder

- `docs/MULTICOMPTE.md` — référence des comptes, espaces, serveurs, rôles (fait foi ; écarts tracés au §14).
- `docs/ARCHITECTURE.md` — architecture, contrats, sécurité, arbitrages (référence technique).
- `docs/SECURITY.md` (modèle de sécurité, journal, risques résiduels), `docs/INTEGRATIONS.md`, `docs/DEPLOY.md`.
- `docs/PROGRESS.md` — suivi d'avancement (à tenir à jour à chaque lot terminé).
- `docs/figma/*.md` — spécifications extraites de Figma (autorité visuelle) ; captures, code de référence et assets
  dans `.design-refs/` (non versionné ; à régénérer via le MCP Figma, fichier `nlvRWAtD1x2fKf8gVgcM0g`).
- `docs/research/claude-code.md` (intégration et conformité Claude Code), `integrations.md` (GitHub, Coolify, Figma,
  MCP), `stack.md` (versions et pièges).

## Règles absolues

1. **Claude Code** : uniquement le binaire officiel non modifié, en session **interactive** (PTY / tmux). Jamais de
   `claude -p`, `--output-format stream-json`, Agent SDK `query()`, `claude setup-token`, `CLAUDE_CODE_OAUTH_TOKEN`.
   Ne jamais lire, copier ou transmettre `~/.claude/.credentials.json` ni les champs de compte de `~/.claude.json`.
   Aucun formulaire de jeton Claude. Aucune métrique de coût/quota inventée. **Un serveur = un espace = une personne =
   une connexion Claude** : jamais partagée, copiée d'un serveur à l'autre ni faite par un administrateur pour autrui.
2. **Aucun faux état** : pas de données métier codées en dur, pas de mock permanent, pas de bouton mort. Les fixtures
   vivent uniquement dans les tests (`**/test/**`, `**/*.test.ts`, `e2e/`).
3. **Sécurité** : pages et actions passent par `requireContext()` (compte + espace + serveur), routes par
   `apiRoute({ auth })` (`'space'` par défaut, `'user'`, `'admin'`, `false`), rappels du runner par `internalRoute`
   (jeton → serveur) ; toute mutation vérifie l'Origin ; les secrets sont chiffrés (AES-256-GCM, liés à leur ligne)
   et jamais renvoyés au client ; actions sensibles journalisées dans `audit_log` (`auditIn(ctx, …)`).
4. **Cloisonnement** : chaque lecture est filtrée par l'espace (`ofSpace`/`inSpace`, `scopeOf*` de
   `server/tenancy/scope.ts`) ; un identifiant d'un autre espace reçoit **exactement** la réponse d'un inconnu (404,
   même message), sans appel au runner, sans écriture, sans audit métier. L'espace n'est jamais choisi par le client.
   Un appel lié à une ressource passe par le serveur de cette ressource (`projects.environment_id`), jamais par « le
   serveur actuel de l'espace ». Les administrateurs ne voient jamais le contenu d'un autre espace.
5. **Runner** : seul composant qui touche au disque des projets, à Git, aux PTY et aux processus. `execFile` avec
   tableau d'arguments, jamais de shell ; chemins confinés (`realpath`) ; environnement nettoyé. Toute requête porte
   `environment_id = son serveur` ; toute table ou colonne qu'il écrit reçoit son `GRANT` et sa politique RLS dans une
   migration (`0004_runner_roles.sql` ; `rls.test.ts` et `test/restricted.test.ts` échouent sinon).
6. **Commits** : messages conventionnels sobres (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`), sans
   aucune mention d'IA/agent/outil de génération, sans trailer `Co-authored-by`. Inspecter le diff avant de committer.
7. **Copie UI** : textes français identiques à Figma — accents, apostrophe **droite** `'` (la page NUERA DEV n'emploie
   jamais `’`), points médians `·`, guillemets « » espacés, points de suspension `…`.

## Commandes

```bash
pnpm install                 # dépendances (pnpm 9, Node ≥ 22.12 — testé sous Node 24)
pnpm db:local                # PostgreSQL 17 local (embedded-postgres, port 54329, données dans .data/pg)
pnpm db:migrate              # applique packages/db/drizzle
pnpm db:generate             # génère une migration après modification du schéma
pnpm dev                     # web (http://localhost:3000) + runner (http://127.0.0.1:4100)
pnpm typecheck && pnpm lint && NUERA_REQUIRE_PG=1 pnpm test   # PostgreSQL exigé (sinon les suites DB sont ignorées)
pnpm --filter @nuera/web e2e # parcours Playwright (pile à deux comptes et deux runners : docs/TESTING.md)
pnpm --filter @nuera/db cli recovery-link --email <e-mail>   # lien de récupération de secours (sans administrateur)
```

## Structure

```
apps/web        Next.js 16 (App Router) — UI, API, auth (Better Auth + 2FA), comptes, administration, intégrations
  src/server/tenancy   contexte de requête (compte, espace, serveur), gardes de portée, rappels du runner par serveur
  src/server/admin     comptes, invitations, serveurs (jetons, rôles PostgreSQL), instance, journal d'instance
apps/runner     service d'exécution (Fastify), un par serveur — Git, worktrees, PTY, sessions Claude (tmux), processus
packages/db     schéma Drizzle + migrations 0000–0005 (espaces, serveurs, RLS, FK composites) + client + CLI de secours
packages/shared contrats Zod runner⇄web (contrat v2), types d'événements, formatage FR, garde des chemins, jetons
deploy/         Dockerfiles, compose Coolify (principal + serveur supplémentaire), sauvegarde/restauration
```

## Conventions

- TypeScript strict partout ; validation Zod aux frontières (formulaires, route handlers, runner).
- Composants UI : `apps/web/src/components/ui` (primitives du design system) — réutiliser avant de créer.
  Couleurs/rayons/ombres via les tokens (`tokens.css` → classes Tailwind), jamais de valeurs en dur.
- Code serveur dans `apps/web/src/server/**` avec `import 'server-only'` ; les pages ne touchent pas la DB directement.
  Chaque fonction de service reçoit d'abord `ctx` (`RequestContext`) ; jamais un `spaceId` venu du client.
- Réglages par portée (`server/settings.ts`) : instance (`app_settings`), serveur (`environments`), espace
  (`space_settings`), compte (`user_preferences`) ; les colonnes déplacées d'`app_settings` ne sont plus jamais lues.
- Une page qui a besoin d'un runner affiche `NoServerAssigned` sans serveur (jamais T5) ; T5 ne remplace jamais
  `/administration`, Paramètres › vue d'ensemble, Compte et sécurité, Préférences (`isRunnerIndependentPage`).
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
- Better Auth : `disableSignUp` bloque aussi `auth.api.signUpEmail` côté serveur, et `user.create.before` refuse
  toute création (`SIGN_UP_CLOSED`) → les comptes sont écrits par nos transactions : le propriétaire par
  `apps/web/src/server/auth/setup.ts`, les invités par `server/auth/links.ts` (via `server/auth/accounts.ts`) ;
  l'index `user_owner_idx` (`(true) WHERE role = 'owner'`) garantit un seul propriétaire.
- Better Auth : `databaseHooks.session.create.before` reçoit le contexte de l'endpoint (`path`, `headers`) et tourne
  **après** la vérification du mot de passe, sur tous les parcours (clés d'accès comprises) → y refuser compte
  désactivé et connexion sans 2FA ne révèle jamais si un e-mail existe → `apps/web/src/server/auth/auth.ts`.
- Connexion par mot de passe sans 2FA (setup, invitation, récupération) : seulement avec une autorisation
  d'enrôlement liée à l'e-mail, 60 s, à usage unique, **en mémoire du processus** (comme les limites de débit : un
  seul conteneur web) → `apps/web/src/server/auth/enrolment-grant.ts`.
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
- Vitest exécute les fichiers en parallèle : une base PostgreSQL par fichier de test (`nuera_integrations_<suite>`, créée et migrée par `src/server/integrations/test/db.ts`, recréée si la migration 0000 a été régénérée) ; préfixe changeable par `NUERA_DB_TEST_PREFIX` (lots parallèles sur le même PostgreSQL) ; espace, serveur et compte de test : `packages/db/src/test/fixtures.ts`.
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
- Le PAT GitHub de secours (`GITHUB_FALLBACK_TOKEN`) ne peut être ni limité à un dépôt ni réduit à la lecture : il sert à l'API et à Git (runner) mais n'est jamais servi au serveur MCP GitHub d'une session (écarté de `--mcp-config`, `403` sur `/api/internal/mcp-headers`) et il est réservé à l'espace du serveur par défaut (jamais à un autre espace) → `apps/web/src/server/mcp/headers.ts`, `server/github/config.ts` `fallbackTokenFor`.
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
- Drizzle : un `Date` passé dans un gabarit `sql` brut (`gte(startKey, date)` avec `startKey` = `sql` coalesce) n'est pas converti (« The "string" argument must be of type string… Received an instance of Date ») → passer `${date.toISOString()}::timestamptz` dans le gabarit ; curseur de pagination exact à la microseconde via `to_char(… 'US')` → `apps/web/src/server/sessions/queries.ts`.
- Playwright : le `Toaster` répète le texte d'un toast dans sa région `aria-live` → `getByText(message, { exact: true })`, sinon violation du mode strict (2 éléments).
- Route interceptée (`projets/@modal/(.)nouveau`) : un `router.refresh()` déclenché par la page dessous (événement temps réel) re-rend `/projets/nouveau` comme page pleine et le modal disparaît → la liste diffère ses refresh tant que `usePathname()` n'est pas `/projets` ; un slot `@modal` a besoin de `default.tsx`, `page.tsx` (null sur la liste) et `[...catchAll]` (null ailleurs) sinon le modal reste ouvert après une navigation → `apps/web/src/features/projects/list/ProjectsView.tsx`.
- Onglets dans l'URL par `history.pushState` : Radix Tabs peut appeler `onValueChange` deux fois pour un clic (deux entrées d'historique, « Précédent » semble sans effet) → ne jamais empiler une URL identique (`writeSearchParams`, `apps/web/src/features/projects/hooks.ts`).
- Palette ⌘K : un hook qui enregistre un groupe / une recherche ne doit dépendre que de la fonction d'enregistrement stable, jamais de l'objet registre (il change à chaque enregistrement → désinscription / réinscription en boucle, « Maximum update depth exceeded ») → `apps/web/src/components/shell/CommandPalette.tsx`.
- État d'URL d'une page dynamique lourde (Workspace) : `router.push('?vue=…')` refait le rendu serveur (RSC) et relit toutes les données (appels au runner) à chaque onglet → `window.history.pushState` (Next synchronise `useSearchParams`) → `apps/web/src/features/workspace/WorkspaceContext.tsx`.
- oxlint (règles React Compiler) : une variable `let` réassignée dans les fermetures d'un effet (minuterie, `EventSource`, compteur de reconnexion) est une erreur `react(immutability)` → un seul objet mutable local à l'effet → `apps/web/src/features/workspace/hooks/useSessionStream.ts`.
- Tiroir en route interceptée (`integrations/@drawer/(.)mcp/[serverId]`) : il ne peut pas faire `router.refresh()` (la route serait rendue en page pleine) → il garde la vue renvoyée par chaque mutation et marque la page « à relire » **avant** `router.back()` ; la page relit ses données quand `usePathname()` redevient `/integrations` (`apps/web/src/features/integrations/refresh.ts`).
- Champ `<input type="number" min max>` dans un `<form>` : la validation native du navigateur bloque `submit` sans rien afficher de nos messages (« Nombre entier entre 1 et 16 attendu. » jamais rendu) → `noValidate` sur le formulaire, validation dans le gestionnaire → `apps/web/src/features/settings/components/controls.tsx`.
- Runner figé ou lent : le client lève `RunnerError` `UPSTREAM` (cause `TimeoutError`), pas `RUNNER_UNAVAILABLE` — `isRunnerUnavailable()` est alors faux ; une page qui dégrade « VPS-3 ne répond pas » doit tester les deux → `apps/web/src/server/projects/detail.ts` (`runnerNotAnswering`).
- cmdk 1.1 : les éléments d'un `Command.Group forceMount` ne sont ni enregistrés ni comptés (`Command.Empty` « Aucun résultat » s'affiche au-dessus de résultats réels) → ne forcer le montage que des lignes de chargement / d'erreur d'une recherche, et omettre le groupe d'une recherche sans résultat (`apps/web/src/components/shell/CommandPalette.tsx`).
- Écho local d'une instruction envoyée (« · en file ») : ne pas l'apparier au fil par l'heure du navigateur (horloge d'un téléphone décalée de quelques minutes ⇒ doublon affiché pour toujours) ; retenir la position du fil au moment de l'envoi (`afterPosition`) → `apps/web/src/features/workspace/lib/thread.ts` `reconcilePending`.
- Lien vers la page déjà ouverte avec un paramètre d'action (bandeau T6 `/parametres?onglet=claude-code&action=reconnexion` cliqué depuis `/parametres`) : navigation douce, la page reste montée → un effet « une seule fois au montage » (ref booléenne) n'ouvre jamais le terminal ; réagir à chaque nouvel objet `useSearchParams()` (ref sur l'objet, sûre en StrictMode) puis retirer l'action par `history.replaceState` → `apps/web/src/features/settings/components/SettingsView.tsx`.
- Conteneur Linux lancé en root : `embedded-postgres` initialise et lance PostgreSQL sous l'utilisateur `postgres` ; si `.data/pg` appartient à root, `pnpm db:local` échoue (« Impossible de démarrer PostgreSQL local : undefined ») → `chown postgres:postgres .data/pg`. Une seule instance pour toutes les piles : ne pas la relancer en parallèle depuis plusieurs agents.
- Drizzle rend `${table.column}` **sans qualification** dans un select à une seule table : une sous-requête corrélée ``sql`… where x.col = ${table.id}` `` compare alors la colonne de la sous-requête à elle-même, sans erreur → ``sql`${table}.${sql.identifier(col.name)}` `` → `apps/web/src/server/home/queries.ts`.
- Vérifier puis agir sur une ligne que d'autres lient par clé étrangère (déconnexion d'une source GitHub encore utilisée) : verrouiller la ligne référencée (`SELECT … FOR UPDATE`) dans la même transaction ; une liaison concurrente attend alors le verrou de la FK → `apps/web/src/server/github/status.ts` `disconnectGithubSource`.
- `invitations.user_id` (FK) : insérer d'abord le compte, puis renseigner `user_id` dans la **même** transaction que la consommation du jeton → `apps/web/src/server/auth/links.ts`.
- Rôle restreint `nuera_runner` : TRUNCATE ignore la RLS et un UPDATE de table autorise `LOCK TABLE … ACCESS EXCLUSIVE` → SELECT/INSERT seulement, UPDATE colonne par colonne, jamais DELETE/TRUNCATE ; le runner ne supprime jamais de ligne (worktree retiré = `status 'removed'`) → `packages/db/drizzle/0004_runner_roles.sql`, `packages/db/src/rls.test.ts`.
- Liste de contrôle d'une table/colonne touchée par le runner : `GRANT SELECT/INSERT`, `GRANT UPDATE (col)` pour chaque colonne écrite, politique RLS par `nuera_runner_environment_id()`, cas dans `apps/runner/test/restricted.test.ts` ; jamais de droit sur les tables d'auth, invitations, sources, intégrations, MCP, variables, notifications, push, journal.
- `CREATE/ALTER ROLE` n'accepte pas de paramètres liés : nom et mot de passe générés (hex / base64url) puis revalidés avant d'être écrits dans la requête ; avec `log_statement=ddl|all`, PostgreSQL journalise le mot de passe → `apps/web/src/server/admin/db-roles.ts`.
- Verrou consultatif de bail du runner : sur une connexion postgres.js **réservée** (`$client.reserve()`), sinon `idle_timeout` (30 s) ou `max_lifetime` du pool la recyclent et libèrent le verrou ; clé dérivée de l'id du serveur → `apps/runner/src/environment.ts`.
- PostgreSQL donne `EXECUTE` à `PUBLIC` sur `pg_advisory_lock*` : tout rôle peut tenir n'importe quel verrou consultatif (celui de `migrate`, le bail d'un autre serveur) → `0005` les retire à `PUBLIC` (superutilisateur seulement : droits de `pg_catalog`, propres à chaque base), le rôle restreint prend son bail par `nuera_runner_try_lease()` (`SECURITY DEFINER`) avec repli sur 42883 → `packages/db/drizzle/0005_runner_scope.sql`, `apps/runner/src/environment.ts`.
- Une clé étrangère est vérifiée par le propriétaire de la table, **hors RLS** : une FK sur l'id seul laissait un rôle restreint pointer vers le worktree ou la session d'un autre serveur → FK composites `(…_id, environment_id)` en `ON DELETE SET NULL (colonne)` (PostgreSQL 15+, écrit à la main dans le SQL : Drizzle n'exprime pas la liste de colonnes et déclare `set null`) → `packages/db/drizzle/0005_runner_scope.sql`.
- Unicité d'un identifiant sous RLS : un SELECT ne voit pas la ligne d'un autre serveur (réponse différente sous DSN complet et sous rôle restreint) → sonder par l'INSERT lui-même dans une transaction annulée, 23505 ⇒ CONFLICT → `apps/runner/src/sessions/manager.ts` `assertSessionIdFree`.
- `ALTER ROLE … NOLOGIN` ne ferme aucune connexion ouverte → `pg_terminate_backend` après la transaction ; il faut superutilisateur ou `pg_signal_backend` (depuis PostgreSQL 16, `CREATEROLE` donne ADMIN sans INHERIT) ; un refus se compte, ne se lève pas → `apps/web/src/server/admin/db-roles.ts` `closeRunnerRoleConnections`.
- Une colonne écrite par le runner (`environments.capabilities`) l'est aussi par une session Claude qui lit son DSN : jamais une preuve de sécurité → « accès base restreint » recoupé par `pg_roles` et `pg_stat_activity` → `apps/web/src/server/admin/db-access.ts`.
- `sanitizeMetadata` du journal retire **sans prévenir** toute clé de métadonnées qui contient `token`, `password`, `secret`, `credential`… (`tokenRenewed` disparaissait) → nommer autrement (`rotated`) → `apps/web/src/server/security/audit.ts`.
- Vérifier puis écrire une ligne sur plusieurs `await` (mot de passe, propriétaire de l'espace) : filtrer l'UPDATE sur les valeurs vérifiées (espace, statut, adresse) avec `returning`, sinon 409 sans rien écrire → `apps/web/src/server/admin/servers.ts` `updateServer`.
- `fetch` suit les redirections par défaut : un endpoint push choisi par un navigateur devenait une SSRF vers le réseau interne → liste d'hôtes des services push (`isPushServiceEndpoint`, `NUERA_PUSH_HOSTS`) et `redirect: 'manual'` → `apps/web/src/server/push/index.ts`.
- Push sur un profil de navigateur partagé : tout ce que tient le service worker (endpoint, clés) est lisible par chaque compte du profil, donc ne prouve rien → renouvellement limité au compte du cookie, abonnement lié à son accès web (`auth_session_id`, filtré à l'envoi et à la lecture) → `apps/web/src/server/push/index.ts`.
- Flux global (`/api/stream/events`) : une panne du runner ne coupe plus le flux (canal web par compte) — le relais écrit `stream.error` puis `runner.unavailable { retryInMs }`, retente toutes les 10 s après le dernier id relayé, puis `runner.available` ; il clôt le flux si le serveur est retiré ou suspendu ou après 5 min de panne (`DEGRADED_STREAM_MAX_MS`) pour repasser par l'authentification ; le client ne prend jamais un battement du web pour une preuve de vie du runner (`erroredRef`) → `apps/web/src/server/runner/stream.ts`, `apps/web/src/hooks/useLiveEvents.tsx`.
- Après avoir recréé la base de dev (nouvel id de serveur), supprimer `.nuera-environment` dans `.data/runner` et `.data/projects` (ou les dossiers), sinon le runner refuse de démarrer (« … appartient au serveur … ») → `apps/runner/src/environment.ts`.
- Un jeton de runner qui correspond à deux lignes (`token_hash` de l'une, `next_token_hash` de l'autre : l'unicité n'est que par colonne) est traité comme inconnu (attente) → `apps/runner/src/environment.ts`.
- ConPTY (Windows) repeint une ligne vide par un déplacement de curseur (`ESC[r;cH`) et compresse les espaces (`ESC[nC`) : retirer ces séquences colle deux lignes → les déplacements de ligne deviennent `\n`, les déplacements à droite des espaces → `apps/runner/src/runs/test-parser.ts`.
- Git pour Windows convertit les fins de ligne (`core.autocrlf=true` du système) : toutes les commandes du runner passent `core.autocrlf=false` par `GIT_CONFIG_*` (fidélité aux octets ; `core.eol` intact) → `apps/runner/src/git/git.ts`.
- Tests Windows : une jonction de dossier (`symlinkSync(…, 'junction')`) ne demande aucun privilège, un lien symbolique si → `apps/runner/test/unit.test.ts`. Le `fetch` d'undici refuse certains ports (« bad port », 4190…) : choisir les ports des piles de test en conséquence.
- Deux runners sous le même utilisateur Linux partageaient le socket tmux `-L nuera` (et un nom de session `nuera-<slug>-<worktree>`, unique seulement par serveur) : socket par serveur (`nuera` pour le serveur par défaut, `nuera-<8 hex>` sinon ; `NUERA_TMUX_SOCKET` l'emporte) et rattachement seulement si `tmux show-environment NUERA_SESSION_ID` vaut l'id de la ligne → `apps/runner/src/sessions/backend.ts`, `sessions/manager.ts` `reattachTmux`.
- Cache des réglages (5 s) : toute écriture directe dans `environments`, `space_settings` ou `user_preferences` hors de `server/settings.ts` appelle `invalidateSettingsCache({ kind, id })`, et un changement de nom/URL de serveur `invalidateContextCache()` + le cache du point d'accès du runner → `apps/web/src/server/admin/servers.ts`.
- Index `notifications_user_dedup_unread_idx (user_id, dedup_key)` : il ignore l'espace → une clé doit nommer son serveur ou son espace quand un même destinataire peut recevoir l'événement de plusieurs portées (`server:<environmentId>:…`, `integration:github:<sourceId>:…`) → `apps/web/src/server/notifications/index.ts`.
- Bus d'événements par compte, autorisations d'enrôlement, limites de débit, cache des verdicts de terminal : en mémoire du processus web → valable pour **un seul** conteneur web ; plusieurs répliques demanderaient LISTEN/NOTIFY et la base → `server/notifications/user-events.ts`, `server/auth/enrolment-grant.ts`.
- Next compile `server-only` en module vide pour le serveur : `instrumentation.ts` peut importer du code serveur (planificateur web, empreinte du jeton du serveur par défaut) → `apps/web/src/instrumentation.ts`.
- Requêtes sortantes vers une adresse choisie par un compte (Coolify, serveurs MCP) : transport épinglé sur `node:http(s)` avec un `lookup` qui revérifie l'adresse résolue (pas d'undici en dépendance) → `apps/web/src/server/security/ssrf.ts` (`NUERA_PRIVATE_HOSTS` pour un hôte privé voulu).
- Vitest ne peut pas `vi.spyOn` un import d'espace de noms ESM (`web-push`) : `push.test.ts` déchiffre le corps RFC 8291 reçu par un faux service de push.
- React 19 réinitialise un formulaire non contrôlé après une action serveur (texte tapé pendant l'envoi perdu) ; `onSubmit` + `preventDefault` puis `form.requestSubmit()` permet d'ajouter une donnée côté client (endpoint push à la déconnexion) avant l'action → `apps/web/src/app/(auth)/deconnexion/sign-out-form.tsx`.
- `next dev` peut instancier un module serveur une fois par couche (route, RSC, action) : une `RunnerError` levée par une copie échouait `instanceof AppError` dans l'autre et devenait un 500 (CONFLICT du runner, terminal inconnu) → `AppError` porte une marque `Symbol.for('nuera.AppError')` et un `static [Symbol.hasInstance]` qui la reconnaît → `apps/web/src/server/errors.ts`.
- `loading.tsx` envoie son squelette (HTTP 200, titre de la page) avant le `notFound()` de la page : une garde de rôle qui doit répondre 404 vit dans le `layout.tsx` du segment, hors du Suspense → `apps/web/src/app/(shell)/administration/layout.tsx`.
- Playwright : `browser.newContext()` hérite du `storageState` du projet ; pour connecter un autre compte, passer `storageState: { cookies: [], origins: [] }` → `apps/web/e2e/fixtures`.
- Windows : lancer `pnpm.cmd` avec `shell: true` casse les arguments contenant `|` (`--grep a|b`) → la pile lance `@playwright/test/cli.js` avec `node`, sans shell (`stack.mjs e2e`). Les commandes `git` des specs passent `-c core.autocrlf=false`.
- L'annonceur de route de Next a `role="alert"` (vide) : `getByRole('alert').first()` le trouve ; filtrer sur un texte (`.filter({ hasText: /\S/ })`).
- `ConfirmDialog` fermé par le code n'appelle pas `onOpenChange` : réinitialiser l'état du dialogue (erreurs, options par défaut) aussi au succès → `apps/web/src/features/admin`.
- `BroadcastChannel.postMessage` déclenche `unicorn/require-post-message-target-origin` (faux positif : même origine par construction) → désactivation commentée avec sa raison → `apps/web/src/hooks/useLiveEvents.tsx`.
- Faux GitHub des e2e à plusieurs sources : il route chaque appel vers l'application de l'appelant (`iss` du JWT, émetteur du jeton d'installation, code de manifest) → `apps/web/e2e/harness/github-front.ts`.
