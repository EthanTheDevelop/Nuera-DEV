# Nuera Dev multi-comptes — architecture de référence

> Statut : décidé le 5 novembre 2026. Ce document fait foi pour la refonte « comptes séparés » : chaque lot
> l'applique tel quel. Un écart nécessaire se signale (fichier exact + raison), il ne s'improvise pas.

## 1. Objectif et invariants

Plusieurs comptes travaillent **en même temps**, chacun dans **son espace** et sur **son serveur** (environnement
d'exécution = une instance du runner), sans perte de fonctionnalité ni régression.

Invariants (non négociables) :

1. **Cloisonnement** : un compte ne voit ni ne modifie jamais les données d'un autre espace (projets, worktrees,
   sessions, événements, autorisations, lancements, opérations, PR, variables, sources GitHub, Coolify, MCP,
   notifications, journal métier, réglages). Un identifiant étranger reçoit **exactement** la réponse d'un identifiant
   inconnu (404, même message), sans appel au runner, sans écriture, sans audit métier.
2. **Un serveur = un espace = une personne = une connexion Claude** (conditions d'Anthropic, `docs/research/
   claude-code.md` §1.3 et §14.3). Un serveur déjà utilisé n'est jamais réattribué : on le retire et on en crée un.
3. **2FA obligatoire par défaut** (TOTP + codes de secours, clés d'accès en option). `NUERA_REQUIRE_2FA=false`
   (décision du propriétaire, 6 novembre 2026) la rend facultative : connexion par mot de passe seul pour un compte
   sans 2FA, « Passer cette étape » à l'activation ; un compte qui l'a activée la garde.
4. **Mise à jour sans intervention** : le runner existant devient le serveur par défaut de l'espace du propriétaire
   actuel ; l'interface de ce compte reste identique (serveur nommé « VPS-3 », copie Figma inchangée).
5. Les administrateurs gèrent comptes, serveurs et instance ; ils **ne voient jamais** le contenu d'un autre espace.

## 2. Vocabulaire (code ↔ interface)

| Concept | Code / base | Interface (FR) |
|---|---|---|
| Locataire | `space`, tables `spaces`, `space_members`, `space_settings`, colonne `space_id` | « espace » |
| Instance du runner | `environment`, table `environments`, colonne `environment_id` | « serveur » (« Serveurs » en administration) |
| Rôle d'instance | `user.role` : `owner` · `admin` · `member` | « Propriétaire » · « Administrateur » · « Membre » |
| Page de session | `workspace` (existant, inchangé : `/workspace/[sessionId]`, `server/workspace`, `features/workspace`) | « Workspace » |

« Environnement » reste réservé à l'onglet du projet (variables d'environnement, D04). Ne jamais nommer un nouvel
élément `workspace*` pour le locataire.

## 3. Modèle de données

Toutes les colonnes `timestamp` sont `withTimezone`. Les noms de contraintes composites sont explicites (≤ 63 car.).

### 3.1 Nouvelles tables (`packages/db/src/schema/tenancy.ts`, `github.ts`)

- **spaces** : `id uuid pk`, `name text not null` (« Espace d'Ethan »), `kind text not null default 'personal'`
  (`personal` | `shared`, seul `personal` en v1), `owner_user_id text → user ON DELETE RESTRICT`, `created_at`,
  `updated_at`, `archived_at`. Index unique `spaces_personal_owner_idx (owner_user_id) WHERE kind = 'personal'`.
- **space_members** : `space_id → spaces CASCADE`, `user_id → user CASCADE`, `role text not null default 'owner'`
  (`owner` | `member`), `created_at` ; PK `(space_id, user_id)` ; index `(user_id)`.
- **environments** : `id uuid pk`, `space_id uuid null` (null = non attribué), `name text not null` (← nom du
  serveur), `location text`, `status text not null default 'pending'` (`pending` jamais utilisé · `active` ·
  `suspended` compte désactivé · `retired`), `config_source text not null default 'db'` (`env` = URL/jeton lus dans
  `RUNNER_URL`/`RUNNER_TOKEN` · `db`), `is_default boolean not null default false`, `url text`, `token_encrypted`,
  `token_hash` (sha256 hex), `next_token_encrypted`, `next_token_hash`, `token_rotated_at`, `db_role text` (rôle
  PostgreSQL restreint du runner, null = DSN complet), `max_concurrent_sessions int not null default 4`,
  `max_concurrent_sessions_cap int not null default 16`, `session_memory_limit_mb int`, `last_seen_at`, `last_error`,
  `runner_version`, `contract_version int`, `backend text`, `capabilities jsonb not null default {}`,
  `created_by_user_id → user SET NULL`, `created_at`, `updated_at`. Contraintes : unique `(id, space_id)` ; uniques sur
  `token_hash`, `next_token_hash`, `db_role` ; `environments_default_idx ((true)) WHERE is_default` ;
  `environments_space_active_idx (space_id) WHERE space_id IS NOT NULL AND status <> 'retired'` (v1 : un serveur
  actif par espace) ; FK `space_id → spaces ON DELETE RESTRICT`.
- **invitations** : `id`, `kind` (`invite` | `recovery`), `email` (minuscules), `role` (`admin` | `member`),
  `user_id → user CASCADE` (cible d'une récupération, ou compte créé), `environment_id → environments SET NULL`
  (serveur `pending` pré-attribué), `token_hash not null unique`, `expires_at not null`, `created_by_user_id → user
  SET NULL`, `accepted_at`, `completed_at` (2FA enrôlée), `revoked_at`, `created_at`. Index unique
  `invitations_pending_email_idx (kind, email) WHERE accepted_at IS NULL AND revoked_at IS NULL`.
- **space_settings** : `space_id pk → spaces CASCADE`, `default_model`, `default_effort`, `default_permission_mode
  not null default 'manual'`, `block_bypass_permissions not null default true`, `permission_wait_seconds not null
  default 120`, `remote_control_by_default not null default false`, `worktree_stale_days not null default 30`,
  `updated_at`.
- **user_preferences** : `user_id pk → user CASCADE`, `theme not null default 'light'`, `locale not null default
  'fr'`, `git_author_name`, `git_author_email` (null = nom et e-mail du compte), `updated_at`.
- **github_sources** : `id uuid pk`, `space_id not null → spaces RESTRICT`, `kind text not null default 'app'`
  (`app` ; `pat` réservé), `label`, `app_id bigint`, `owner_login`, `owner_type`, `status` (comme `integrations`),
  `config jsonb not null default {}` (charge utile actuelle de `githubConfigSchema`, installations comprises),
  `secrets_encrypted`, `last_checked_at`, `last_success_at`, `last_error`, `expires_at`, `created_by_user_id → user SET
  NULL`, `created_at`, `updated_at`. Unique `(id, space_id)` ; unique `app_id WHERE app_id IS NOT NULL` ; index
  `(space_id)`.

### 3.2 Tables existantes

- **user** : `role text not null default 'member'`, `disabled_at`, `deleted_at`. `user_single_owner_idx` est supprimé
  et remplacé par `user_owner_idx ((true)) WHERE role = 'owner'` (un seul propriétaire). Better Auth : `role` et
  `disabledAt` déclarés en `user.additionalFields` (`input: false`).
- **projects** : `space_id not null`, `environment_id not null` (immuable), `github_source_id` (nullable),
  `created_by_user_id → user SET NULL`. Unique `projects_id_environment_key (id, environment_id)`. Les uniques
  d'instance deviennent **par serveur** : `(environment_id, slug)`, `(environment_id, path)`,
  `(environment_id, github_full_name) WHERE archived_at IS NULL`. FK `projects_env_space_fk (environment_id, space_id)
  → environments (id, space_id)` ; FK `projects_github_source_fk (github_source_id, space_id) → github_sources (id,
  space_id)` (non vérifiée tant que la source est nulle). Index `(space_id, status)`, `(environment_id, status)`.
  `is_favorite` / `last_opened_at` restent sur le projet (espaces personnels ; `project_user_state` viendra avec les
  espaces partagés).
- **worktrees, sessions, command_runs, operations** : `environment_id not null` (copie de celui du projet) + FK
  composite `(project_id, environment_id) → projects (id, environment_id)` (CASCADE comme aujourd'hui) ; index
  `(environment_id, status)`. `worktrees_path_active_idx` devient `(environment_id, path) WHERE removed_at IS NULL`.
  `command_runs.actor_user_id → user SET NULL`.
- **integrations** : `space_id not null` ; `integrations_kind_unique` → unique `(space_id, kind)`. Les lignes `github`
  sont déplacées dans `github_sources` (même `id`).
- **mcp_servers** : `space_id not null` ; unique `(space_id, name)`.
- **notifications** : `user_id not null → user CASCADE` (destinataire), `space_id → spaces CASCADE` (null pour les
  alertes d'instance). Unique `(user_id, dedup_key) WHERE read_at IS NULL AND dedup_key IS NOT NULL` ; index
  `(user_id, read_at, created_at)`.
- **push_subscriptions** : unique `(user_id, endpoint)` à la place de `endpoint` ; `auth_session_id text` (informatif).
- **audit_log** : `space_id uuid`, `environment_id uuid`, `subject_user_id text` (sans FK : survivent aux
  suppressions), `actor_label text` (e-mail figé de l'auteur) ; index `(space_id, id)`, `(actor_user_id, id)`,
  `(subject_user_id, id)`.
- **app_settings** (instance) : `invitation_ttl_hours int not null default 48`, `force_block_bypass_permissions bool
  not null default false`. Les colonnes déplacées (§8) restent en base, **dépréciées et plus jamais lues** (une
  migration ultérieure les supprimera).
- **uptime_daily** : schéma inchangé. Clé de service : `runner` pour le serveur par défaut (historique conservé),
  `runner:<environmentId>` pour les autres (`uptimeServiceKey()` de `@nuera/shared/runner`).

### 3.3 Migrations (une seule livraison, appliquée atomiquement par drizzle-orm)

1. `0001_tenancy_expand` (générée) : nouvelles tables, colonnes **nullables**, unique `(id, environment_id)`,
   suppression de `user_single_owner_idx`. Commence par `SET LOCAL lock_timeout = '10s';`.
2. `0002_tenancy_backfill` (`drizzle-kit generate --custom`) : un espace personnel par compte existant (le plus ancien
   devient `owner`, les autres éventuels `member`), membres, `space_settings` et `user_preferences` copiés depuis
   `app_settings`, **serveur par défaut** (`config_source='env'`, `is_default`, `status 'active'` s'il est attribué,
   nom/lieu/limites depuis `app_settings`, ligne absente tolérée), rattachement de toutes les lignes, `github_sources`
   depuis `integrations` (même id, `app_id` extrait avec garde), notifications attribuées au propriétaire (doublons non
   lus fusionnés), réécriture des clés de dédoublonnage `integration:github:*`, audit complété. Correct avec 0 ou 1
   compte et sans ligne `app_settings`.
3. `0003_tenancy_enforce` (générée) : `NOT NULL`, suppression des anciens uniques, nouveaux index et FK composites.
   Ne contient aucun `ADD COLUMN`.
4. `0004_runner_roles` (`--custom`) : rôle `nuera_runner` NOLOGIN, fonction `nuera_runner_environment_id()`
   (`SECURITY DEFINER`, `environments.db_role = session_user`), droits minimaux et RLS (§11).
5. `0005_runner_scope` (ajoutée après coup, §14 Y2) : clés étrangères composites vers `worktrees`/`sessions`, verrous
   consultatifs retirés à `PUBLIC`, bail des rôles restreints par `nuera_runner_try_lease()`.

Un **test de montée de version** part d'une base 0000 remplie (compte, réglages non par défaut, GitHub, Coolify, MCP,
projet + worktree + session + événements + autorisation + lancement + opérations + PR + variable, notifications en
double, push, audit, disponibilité) et vérifie chaque rattachement. `0000` n'est jamais modifiée.

## 4. Serveurs (runner) : identité et cycle de vie

- **Jeton** : nouveau format `nrt_` + base64url(32 octets) ; l'ancien jeton reste accepté. Le web stocke
  `token_encrypted` (AES-256-GCM) et `token_hash` ; il l'affiche **une seule fois**.
- **Serveur par défaut** : `config_source='env'` ; son `token_hash` est rempli au démarrage par `migrate` (le service
  reçoit `RUNNER_TOKEN`) et, par sécurité, par le web (idempotent). Le web lui parle avec `RUNNER_URL`/`RUNNER_TOKEN`.
- **Démarrage du runner** : écoute des hooks → recherche de son serveur par `sha256(RUNNER_TOKEN)` dans `token_hash`
  ou `next_token_hash` (`NUERA_ENVIRONMENT_ID` optionnel, fatal s'il diffère) → **inconnu ou retiré : attente**
  (santé seule, 503 `ENVIRONMENT_UNREGISTERED` ailleurs, nouvel essai toutes les 15 s) → **bail exclusif**
  (`pg_try_advisory_lock` sur une connexion dédiée ; refusé : attente) → **marqueurs** `.nuera-environment` dans
  `NUERA_DATA_DIR` et `NUERA_PROJECTS_ROOT` (refus si un autre serveur y est inscrit) → tâches de reprise **limitées à
  son serveur** (sessions, opérations, lancements, trous de disponibilité) → écoute API → planificateur.
- **Cloisonnement runner** : chaque requête de liste ou tâche filtre `environment_id = moi` ; chaque recherche par id
  (projet, worktree, session, autorisation, opération, lancement) exige `environment_id = moi` **dans la requête**
  (sinon NOT_FOUND, avant toute écriture). Le runner ne déclenche plus les vérifications d'intégration (horloge web).
- **Statuts** : `suspended`/`retired` → refus des nouveaux travaux (`ENVIRONMENT_DISABLED` : sessions, clonage,
  lancements, terminaux de shell) ; lecture et arrêt restent possibles.
- **Réglages lus** : sa ligne `environments` (sessions parallèles, mémoire) ; les politiques de session arrivent dans
  les options de lancement (champs **optionnels** de `launch.json`), jamais depuis `app_settings`.
- **Battement** toutes les 60 s : `last_seen_at`, `runner_version`, `contract_version`, `backend`, `capabilities`.
- **Claude** : `NUERA_CLAUDE_CONFIG_DIR` (dev/tests) → `CLAUDE_CONFIG_DIR` de **tous** les processus `claude` et de la
  validation des journaux ; non défini en production (HOME propre au conteneur).
- **Identité Git** : `gitIdentity` (options de lancement, terminaux de shell, lancements) → `GIT_AUTHOR_*` /
  `GIT_COMMITTER_*` injectés par le runner (le préfixe `GIT_` reste interdit dans les variables libres).
- **Contrat** : `RUNNER_CONTRACT_VERSION = 2` exposé par `/v1/health` ; le web refuse poliment une route plus récente
  que le contrat du runner.
- **Base** : `RUNNER_DATABASE_URL` (facultatif) remplace `DATABASE_URL` ; pool `NUERA_DB_POOL_MAX` (5 par défaut).
- **Windows** : `core.autocrlf=false` pour toutes les commandes Git du runner (fidélité aux octets du dépôt).

## 5. Web : contexte, cloisonnement, runner par serveur

- `apps/web/src/server/tenancy/context.ts` :
  `RequestContext = { user: CurrentUser; space: SpaceRef; environment: EnvironmentRef | null }` ;
  `getRequestContext()` (React `cache`) ; `requireContext()` (pages, actions) ; `requireContextForApi()` ;
  `resolveContext(user)` ; `requireEnvironment(ctx)` → `{ environment, runner }` ou AppError `CONFLICT` raison
  `NO_ENVIRONMENT` (« Aucun serveur ne vous est encore attribué : un administrateur doit vous en attribuer un. ») ;
  `invalidateContextCache(userId?)`. `CurrentUser` gagne `role` et `disabledAt`. L'espace n'est **jamais** choisi par
  le client : v1 = l'espace personnel.
- `apps/web/src/server/tenancy/scope.ts` : `scopeOfProject`, `scopeOfSession`, `scopeOfWorktree`, `scopeOfRun`,
  `scopeOfOperation`, `scopeOfPermission`, `scopeOfTerminal` → `ResourceScope { spaceId, environmentId,
  environmentName, projectId?, runner, endpoint() }` ; NOT_FOUND identique à aujourd'hui pour tout id étranger.
  `ofSpace(ctx, …conds)` pour les listes ; `auditIn(ctx, entry)` remplit acteur, espace, serveur.
- `apiRoute({ auth })` : `false` · `'user'` · `'space'` (**défaut**) · `'admin'` (owner ou admin) ; le handler reçoit
  `{ user, ctx }`. `internalRoute` fournit `environment: CallerEnvironment` (jeton → serveur ; `suspended`/`retired`
  → 403) ; chaque route interne vérifie que la ressource appartient à ce serveur (sinon 404 + audit
  `security.runner_scope_violation`).
- Runner : `getRunnerEndpoint(environmentId)` (ligne `environments`, jeton déchiffré, `env` → variables ; cache 30 s),
  `getRunnerForEnvironment(id)`. **Le singleton `runner` est supprimé.** Les appels liés à une ressource passent par
  son serveur (`projects.environment_id`), jamais par « le serveur actuel de l'espace ». Erreurs :
  « {nom} ne répond pas : le runner est injoignable. »
- Flux SSE : la portée est vérifiée avant le relais ; les identifiants d'événements sont préfixés par le serveur
  (`<environmentId>.<id>`) pour qu'un `Last-Event-ID` d'un autre serveur provoque `stream.reset`. Le flux global
  fusionne le flux du serveur de l'espace et un **canal web par utilisateur** (notifications, événements de compte),
  sans `id:` côté web ; un compte sans serveur reçoit quand même ce canal.
- **Garde d'identité multi-onglets** : le flux global annonce l'utilisateur (`stream.hello`) ; un onglet dont le
  cookie désigne désormais un autre compte se recharge.

## 6. Comptes et authentification

- Premier compte (`/configuration`, `SETUP_TOKEN`) = **propriétaire**, sous verrou consultatif ; `/configuration`
  n'existe plus dès qu'un propriétaire a sa 2FA (reprise par jeton seulement pour un propriétaire sans 2FA).
- Better Auth : `user.create.before` refuse toujours (`SIGN_UP_CLOSED`) — les comptes sont créés par transaction
  directe ; `session.create.before` refuse un compte désactivé (`ACCOUNT_DISABLED` : « Ce compte est désactivé.
  Contactez un administrateur. ») et toute connexion par mot de passe sans 2FA hors **autorisation d'enrôlement**
  (`issueEnrolmentGrant({ email, purpose })` / `consumeEnrolmentGrant(nonce, email)`, liée à l'e-mail, 60 s) ;
  revert complet de `NUERA_REQUIRE_2FA` (commits f512112, 974f493).
- **Invitation** (owner/admin) : e-mail, rôle, validité (instance, 48 h par défaut), serveur `pending` optionnel ;
  lien `/invitation/<jeton>` affiché une fois. Acceptation : une transaction crée compte + espace + membre +
  `space_settings` + `user_preferences` + MCP préréglés + rattachement du serveur, avec consommation atomique du
  jeton ; puis « Activation de votre compte » (TOTP → codes → clé d'accès). Le lien reste utilisable pour reprendre
  l'activation jusqu'à `completed_at`, avec le mot de passe choisi.
- **Récupération** (owner/admin, mot de passe de l'admin redemandé) : ferme accès, appareils de confiance (lignes
  `verification` `trust-device-*`), 2FA ; lien `/recuperation/<jeton>` (nouveau mot de passe + TOTP) ; la personne est
  notifiée ; journal avec `subject_user_id`. Secours sans admin : `pnpm --filter @nuera/db cli recovery-link --email …`
  (en production : `docker compose run --rm migrate …`).
- **Désactiver** : accès web et appareils de confiance supprimés, abonnements push supprimés, serveur `suspended`
  (rappels internes refusés) ; option cochée « Arrêter aussi ses sessions Claude Code en cours ». **Réactiver** :
  l'inverse. **Supprimer** : seulement un compte désactivé, anonymisation (`deleted_at`), espace archivé, serveur
  `retired` ; les dépôts GitHub ne sont jamais touchés.
- Gardes : le propriétaire n'est ni désactivé, ni supprimé, ni rétrogradé ; jamais d'action qui se verrouille soi-même ;
  le dernier administrateur actif est protégé.
- Limites de débit : connexion par `ip+e-mail` (10/10 min) + filet par IP (50/10 min) ; second facteur, enrôlement,
  jetons d'invitation/récupération, mutations d'administration (30/10 min par admin).
- Plusieurs comptes sur un même appareil : un compte par profil de navigateur (fenêtre privée ou autre profil) ;
  mention sur `/connexion`. Le sélecteur de comptes (multiSession) est hors v1.

## 7. Intégrations

- **GitHub** : plusieurs sources par espace (`github_sources`, 10 max), application **privée par défaut**, nom de
  manifest unique (suffixe), état signé v2 `{ purpose, userId, spaceId, sourceId? }`, retour `setup` résolu par l'état
  ou en sondant les sources de l'espace, cache de jetons `appId|installationId|dépôts|droits`, statut par source +
  agrégat (pire statut), déconnexion refusée tant qu'un projet actif utilise la source, sélecteur de source dans
  l'ajout de projet quand un dépôt est accessible par plusieurs sources, `GITHUB_FALLBACK_TOKEN` réservé à l'espace du
  serveur par défaut (jamais servi au MCP). Routes historiques conservées en sur-ensemble ; nouvelles routes
  `/api/integrations/github/sources/[sourceId]/…`.
- **Coolify** : une ligne `integrations` par espace. **MCP** : registre par espace (préréglages créés avec l'espace),
  activation par projet inchangée, état CLI/OAuth par serveur (1:1), en-têtes par projet → espace, URL du serveur MCP
  épinglée. **Garde SSRF** commune (refus boucle locale, lien-local, hôtes des serveurs enregistrés et de la base, sauf
  liste `NUERA_PRIVATE_HOSTS`).
- **Horloge des vérifications** : planificateur web (`instrumentation.ts`, verrou consultatif, toutes les 15 min par
  espace ; `NUERA_WEB_SCHEDULER=off` en tests).

## 8. Réglages (répartition)

| Portée | Réglages | Qui modifie |
|---|---|---|
| Instance (`app_settings`) | durée d'inactivité et durée maximale des accès web, validité des invitations, blocage forcé du mode sans autorisations | owner/admin |
| Serveur (`environments`) | nom, lieu (admin) ; sessions parallèles et mémoire par session (propriétaire de l'espace, plafond fixé par l'admin) | voir colonne |
| Espace (`space_settings`) | modèle, effort, mode d'autorisation par défaut, blocage du mode sans autorisations (effectif = instance OU espace), attente d'une autorisation, Remote Control par défaut, worktrees inactifs | propriétaire de l'espace |
| Utilisateur (`user_preferences`) | thème, langue, identité Git | chacun |

`projects_root` disparaît des réglages (sans effet). `PATCH /api/settings` garde ses clés plates et route chacune vers
sa portée ; une clé d'instance modifiée par un membre → 403 « Réglage réservé aux administrateurs. ».

## 9. Notifications, push, journal

- Une notification par destinataire ; `createNotification(input, { spaceId?, userIds })` ; destinataires d'un
  événement de serveur = membres de l'espace du serveur (admins si non attribué).
- `sendPush(payload, { userIds })` obligatoire ; abonnement supprimé à la déconnexion (le formulaire envoie l'endpoint
  courant), à la révocation d'un accès, à la désactivation, au retrait d'appareil ; `sw.js` renouvelle par l'ancien
  endpoint (route `/api/push/subscription/renew`) sans changer de compte ; un clic sur une notification d'un autre
  compte affiche « Cette notification concerne un autre compte Nuera Dev : connectez-vous avec ce compte pour
  l'ouvrir. ».
- Journal **personnel** (Paramètres) : mes événements `auth.*`/`settings.*`/`security.*`, les actions d'admin me
  visant, les événements d'autorisation/intégration de mon espace. Journal **d'instance** (Administration) :
  `auth.*`, `admin.*`, `environment.*`, `instance.*`, `security.*` de tous les comptes (adresses IP visibles des
  admins, mention dans Paramètres) — jamais `git.*`, `project.*`, `session.*`, `terminal.*`, jamais l'identité du
  compte Claude.

## 10. Interface

- `/administration?onglet=comptes|serveurs|instance|journal` dans `(shell)`, owner/admin seulement (404 sinon) ; groupe
  « INSTANCE » de la barre latérale, entrée du rail et du menu du profil, palette ⌘K ; au téléphone, entrée dans
  Paramètres et le menu du profil. Construite uniquement avec les primitives existantes (pas de Figma).
- `/invitation/[jeton]`, `/recuperation/[jeton]` dans `(auth)`, réutilisant `AuthCard`, la progression et les étapes
  double facteur / codes / clé d'accès.
- Paramètres : tuile « Identité Git » ; réglages par portée (lecture seule « Réglé par un administrateur ») ; carte
  utilisateur « Propriétaire · double facteur actif » (Figma conservé pour le propriétaire), « Administrateur · … »,
  « Membre · … » ; plus de « Un seul propriétaire, aucun autre compte ».
- Accueil : carte « Premiers pas » (Connecter Claude Code · Connecter GitHub · Ajouter un premier projet), pilotée par
  les vrais états, masquée une fois complète. État « Aucun serveur attribué » partout où un runner est requis (jamais
  T5).
- T5 ne remplace jamais `/administration`, Paramètres › Compte et sécurité ni Préférences (bandeau à la place).
- Copies 404 neutres : « … ou dépend d'un autre compte Nuera Dev. » ; pages publiques : « les projets de votre
  serveur ».

## 11. Sécurité

- Le terminal et les sessions Claude tournent sous l'utilisateur du runner : ils peuvent lire son environnement. Les
  runners des serveurs non par défaut se connectent donc avec un **rôle PostgreSQL restreint** (`nuera_env_<8 hex>`
  dans `nuera_runner`) créé à l'enregistrement du serveur (DSN affiché une fois) : droits sur les seules tables du
  runner, **RLS** par serveur, aucun accès aux tables d'authentification, invitations, sources, intégrations, MCP,
  variables, notifications, push, journal. Le serveur par défaut garde son DSN jusqu'à ce que l'admin le restreigne
  (`RUNNER_DATABASE_URL`) ; tant que ce n'est pas fait, l'administration affiche « Le serveur VPS-3 accède encore à
  toute la base de données. ».
- Secrets chiffrés liés à leur ligne (données associées `keyId|table|propriétaire`), anciens formats toujours
  déchiffrés puis rechiffrés.
- Rappels internes : jeton par serveur, ressource vérifiée, serveur suspendu refusé.
- Toute nouvelle table touchée par le runner porte ses `GRANT` et sa politique RLS (case de la liste de contrôle).

## 12. Déploiement

- La ressource Coolify principale reste identique (`migrate`, `web`, `runner` et ses volumes) : `migrate` reçoit
  `RUNNER_TOKEN`, `NUERA_REQUIRE_2FA` disparaît, `RUNNER_DATABASE_URL` est facultatif.
- Serveur supplémentaire : ressource Coolify séparée depuis `deploy/docker-compose.runner.yml` (service unique, volumes
  propres, réseau prédéfini, sans domaine ni port), avec le jeton et le DSN affichés par l'administration.
- Sauvegardes : jamais `~/.claude/.credentials.json` ni `~/.claude.json`.
- Avant chaque push sur `main` : sauvegarde de la base, aucune session en cours, suites complètes vertes (PostgreSQL
  exigé : `NUERA_REQUIRE_PG=1`).

## 13. Tests

- `packages/db` : test de montée de version 0000 → 0004 sur base remplie (et deux bases sans compte / sans réglages),
  puis 0004 → 0005 avec des références croisées entre serveurs.
- Runner : deux runners sur une même base (reprise, planificateur, listes, verrou) ; suite des rôles restreints.
- Web : suite d'isolation pilotée par table (B reçoit le 404 « inconnu » sur chaque route à identifiant, zéro appel
  runner, zéro écriture) + garde d'inventaire des routes ; notifications, push, journal, réglages par portée.
- Playwright : pile à **deux comptes et deux runners** (`E2E_ACCOUNTS=2`), invitation + 2FA obligatoire,
  administration, isolation, travail simultané, sources GitHub multiples ; correctifs de portabilité Windows.

## 14. Écarts

### Lot F1 (base et contrats partagés)

1. **Clés de dédoublonnage GitHub** (`packages/db/drizzle/0002_tenancy_backfill.sql`, étape 19) : une alerte d'une
   source porte la clé `integration:github:<sourceId>:<état>` (`expiring` · `expired` · `error`) ; celles du jeton de
   secours (`GITHUB_FALLBACK_TOKEN`, sans source) `integration:github:fallback:<état>`. La migration réécrit sous cette
   forme les clés existantes `integration:github:<état>` (l'id de la source migrée, ou `fallback` sans application
   GitHub). Les autres clés (`integration:coolify:*`, `integration:mcp:<nom>:*`, `session:*`, `permission:*`,
   `claude:auth`) ne changent pas : l'unicité est désormais par destinataire. Le lot intégrations produit et résout ces
   clés ainsi (préfixe `integration:github:<sourceId>:`, filtré par destinataire).
2. **Empreinte du serveur par défaut** (`packages/db/src/migrate.ts`) : `migrate` remplit `token_hash` quand il est vide
   (« Empreinte du jeton du serveur par défaut enregistrée. ») **et le met à jour quand RUNNER_TOKEN a changé**
   (« Empreinte du jeton du serveur par défaut mise à jour (RUNNER_TOKEN a changé). »). Raison : avec
   `config_source = 'env'`, RUNNER_TOKEN est la source de vérité ; sans cette mise à jour, la rotation documentée
   (nouveau RUNNER_TOKEN pour le web et le runner) laisserait le runner par défaut en attente, non enregistré. Un échec
   (jeton déjà utilisé par un autre serveur) est journalisé sans faire échouer `migrate`.
3. **Précisions de schéma** (§3 muet) : `integrations.space_id` et `mcp_servers.space_id` → `spaces` ON DELETE RESTRICT
   (comme `github_sources`) ; `invitations.kind`, `email` et `role` NOT NULL (défauts `invite`, `member`), `role` typé
   `owner | admin | member` car une récupération reprend le rôle actuel, propriétaire compris ; `IntegrationKind`
   restreint à `coolify | figma` ; `user_owner_idx` créé dès 0001 ; les index non uniques existants (`*_status_idx`,
   `notifications_created_idx`, `notifications_unread_idx`) sont conservés ; uniques nommés
   `projects_environment_slug_idx`, `projects_environment_path_idx`, `projects_environment_repo_active_idx`,
   `integrations_space_kind_idx`, `mcp_servers_space_name_idx`, `notifications_user_dedup_unread_idx`,
   `push_subscriptions_user_endpoint_idx`.
4. **Base sans compte mais avec des données** (0002, étape 4) : un espace « Espace initial » sans propriétaire
   (`owner_user_id` nul) accueille projets, intégrations, registre MCP et serveur par défaut ; la création du premier
   propriétaire (`/configuration`) l'adopte (`owner_user_id` + `space_members`) au lieu d'en créer un. Sans compte, les
   notifications (sans destinataire possible) sont supprimées.
5. **Journal** (0002, étapes 21 à 25) : `space_id` pour tout événement hors `auth.*`, `security.*` et `settings.*` ;
   `environment_id` (serveur par défaut) pour `git.*`, `project.*`, `session.*`, `terminal.*`, `permission.*`,
   `maintenance.*` et les événements du runner ; `subject_user_id` = l'auteur pour `auth.*` et `security.*`, ou le
   compte de l'e-mail essayé (`metadata.email`) pour un échec de connexion ; `actor_label` = e-mail de l'auteur.
6. **Commande de secours** : `pnpm --filter @nuera/db recovery-link --email …` et `pnpm --filter @nuera/db cli
   recovery-link --email …` sont équivalentes (`--app-url`, sinon APP_URL) ; en production `docker compose run --rm -e
   APP_URL=<url> migrate node_modules/.bin/tsx src/cli/recovery-link.ts --email …`. Les clés d'accès sont gardées, sauf
   avec `--remove-passkeys` (appareil perdu). Journal : `admin.recovery_link_cli` (`admin.recovery_link_created` quand
   un administrateur réutilise `createRecoveryLink` de `@nuera/db/recovery`). La commande n'écrit que la ligne du lien ;
   le détail (accès fermés, appareils, clés) est dans les métadonnées du journal.
7. **Rôle `nuera_runner`** (0004) : sa création exige CREATEROLE (le propriétaire `nuera_dev` de la base de production est
   superutilisateur). Le battement du runner peut écrire `environments.updated_at` (colonne mise à jour d'office par
   Drizzle). Le runner ne lit de `app_settings` que `force_block_bypass_permissions`. Le rôle n'a ni DELETE ni
   TRUNCATE (le runner ne supprime jamais de ligne ; TRUNCATE ignorerait la RLS) et UPDATE y est accordé colonne par
   colonne, jamais sur une table entière (un UPDATE de table autorise `LOCK TABLE … ACCESS EXCLUSIVE`, qui bloquerait
   tous les serveurs) : toute colonne ajoutée à une table du runner reçoit son `GRANT UPDATE (col)`
   (`packages/db/src/rls.test.ts` échoue sinon).

### Lot C1 (runner)

1. **Plafonds** (`apps/runner/src/sessions/manager.ts`) : la ligne `environments` fixe la borne haute des sessions
   parallèles et de la mémoire par session ; une valeur des options de lancement ne peut que la rendre plus stricte
   (le contrat partagé disait « défaut = valeur du serveur »). Raison : §4 « Réglages lus » et le plafond d'admin du §8.
2. **Blocage du mode sans autorisations** : `bloqué = (launch.blockBypassPermissions ?? true) ||
   app_settings.force_block_bypass_permissions` ; une lecture impossible de cette colonne compte comme « bloqué »
   (échec fermé).
3. **`CLAUDE_CONFIG_DIR`** (`NUERA_CLAUDE_CONFIG_DIR`) est aussi donné aux terminaux de shell et aux commandes du projet,
   pas seulement aux processus `claude` (un `claude` tapé à la main reste sur la connexion du serveur).
4. **Interruption** d'un identifiant inconnu ou d'un autre serveur : 404 « Session introuvable. » (409 avant), réponse
   identique dans les deux cas. Commit et push vérifient aussi `body.sessionId` dans le serveur (404 sinon) ;
   `sessions.create` traduit 23505 en CONFLICT.
5. **Attente du bail et démarrage** : 503 `UPSTREAM` sans `reason` (aucune valeur de `RUNNER_ERROR_REASONS` ne
   convient, `packages/shared` inchangé) ; `/v1/health` donne `state: 'starting'`. Remplacé depuis : raison
   `ENVIRONMENT_STARTING` (X1-4).
6. **Serveur retiré pendant le service** : retour en attente (503 `ENVIRONMENT_UNREGISTERED`), pas
   `ENVIRONMENT_DISABLED` (cohérent avec 0004 : `nuera_runner_environment_id()` masque les serveurs retirés). **Perte du
   bail** : fatale, le processus s'arrête (jamais deux runners pour un serveur). Marqueur illisible : refusé. En
   attente, une route inconnue répond 503 (404 seulement une fois en service).
7. **Copie** : vocabulaire « serveur » (§2) et non « environnement ». Les terminaux `claude-login`, `mcp-login` et
   `claude-status` restent permis sur un serveur suspendu (seuls les terminaux de shell sont refusés). Le web refuse
   depuis `mcp-login` sur un serveur suspendu ou retiré (Y4-1).
8. **Ajouts** : `NUERA_ENV_FILE` (second runner en développement), masquage des jetons `nrt_`, journal lié à
   `environmentId`, avertissement 401/403 sur les rappels web.

### Lot C2a (web : contexte et cloisonnement)

1. **Compte désactivé** (`server/auth/session.ts`) : `getCurrentUser()` renvoie null, la requête est traitée comme
   déconnectée ; `CurrentUser.disabledAt` vaut donc toujours null.
2. **Erreurs** (`server/errors.ts`) : `AppError` gagne `reason` (envoyé : `NO_ENVIRONMENT`, `ENVIRONMENT_DISABLED`,
   `RUNNER_OUTDATED`, `ACCOUNT_DISABLED`…) et `data` (jamais envoyé) ; `RunnerError` en hérite.
3. **Rotation** (`server/runner/client.ts`, `stream.ts`) : pour un serveur `db` qui a un `next_token_encrypted`, un 401
   du runner est rejoué une fois avec le nouveau jeton (appels et flux), et une réponse obtenue ainsi promeut le jeton.
4. **Gardes de portée** (`server/tenancy/scope.ts`) : `ScopeOptions { notFound, untouched }` garde la copie propre à
   chaque appelant ; un identifiant qui n'est pas un uuid reçoit le même NOT_FOUND (jamais de 500 PostgreSQL).
   `scopeOfTerminalInput` met en cache 60 s un verdict positif par (compte, serveur, terminal) pour la frappe ; jamais un
   verdict négatif.
5. **`/api/internal/notify`** : un `sessionId`/`projectId` inconnu perd seulement son lien ; seul un identifiant qui
   existe sur un autre serveur reçoit 404 et une entrée `security.runner_scope_violation`. Réponse
   `{ created, recipients, notification? }` (compatible avec `NotifyResponseSchema` du runner).
6. **Appelant runner** (`server/security/runner-token.ts`) : la recherche par empreinte ne vise que les serveurs `db` ;
   le serveur par défaut n'est désigné que par `RUNNER_TOKEN` (un ancien jeton ne le désigne plus après un changement).
7. **Flux** : le canal web porte des événements génériques `{ type, at, data }` (`notification.read` n'est pas dans
   `RunnerEventSchema`) ; un runner injoignable pendant `scopeOfTerminal` répond par un flux `stream.error`, pas un
   JSON 503.
8. **Auto-réparation** : `resolveContext` fait adopter l'« Espace initial » sans propriétaire avant de créer un espace
   personnel (secours ; la voie principale est `/configuration`). `tenancy/names.ts` porte `personalSpaceName`.
9. **Garde provisoire** `mayUseInstanceCredentials` : identifiants d'instance servis au seul serveur par défaut jusqu'au
   lot W3 (qui l'a rendue sans objet : routes internes par espace, voir W3-5).

### Lot C2b (web : réglages, notifications, push, journal, chiffrement)

1. **Chiffrement** (`server/security/crypto.ts`) : `encryptSecret`/`decryptSecret` **exigent** une portée
   (`keyId|table|propriétaire` en données associées) ; `encryptJson`/`decryptJson` gardent une surcharge sans portée
   (ancien format, `@deprecated`) ; `needsReencryption(cipher)` ne prend pas de portée (format et clé sont en clair),
   `reencryptSecret(cipher, scope)` vérifie l'appartenance même quand il rend la valeur inchangée.
2. **Journal** : réglages d'instance → `instance.settings_updated` (journal d'instance) ; nom/lieu d'un serveur →
   `environment.updated` ; réglages d'espace, limites du serveur, préférences → `settings.updated` ; chaque ligne porte
   `metadata.scope`.
3. **`applySettingsPatch`** : validation tout-ou-rien (rien n'est écrit sur une clé invalide), autorisation par portée
   (portées refusées : résultat `refused` par clé + `error`, les autres sont appliquées). Le blocage forcé par
   l'instance ne refuse que `defaultPermissionMode = 'bypassPermissions'`. `invitationTtlHours` entre 1 et 168 h ;
   `maxConcurrentSessions` borné à 1–64, sous le plafond du serveur.
4. **Notifications** : un rafraîchissement par `dedupKey` réécrit aussi espace, projet et session ; les destinataires
   supprimés sont ignorés, ainsi que les non-membres d'un espace ; les références sont gardées seulement si elles
   appartiennent à l'espace (aucune sans espace).
5. **Retraits** (pas d'alias, pour que le compilateur liste les appels) : `getAppSettings`, `updateAppSettings`,
   `notify`, `listAudit`, `SECURITY_JOURNAL_PREFIXES`, `savePushSubscription`, `deletePushSubscription` et les formes
   sans destinataire.
6. **Tests** : aide partagée `server/notifications/test/db.ts` (préfixe `nuera_c2b`, `NUERA_DB_TEST_PREFIX`).

### Lot W1 (projets)

1. **Variables du projet** : portée de chiffrement `SecretScopes.projectEnvVar(projectId, clé)` (propriétaire
   `${projectId}:${clé}`), plus stricte que `{ table, ownerId: projectId }` et identique à `server/sessions/env.ts`.
2. **Favori et dernière ouverture** restent sur `projects` (§3.2), pas de `project_user_state`.
3. **Accueil** : une seule ligne GitHub agrégée (pire statut, dépôts additionnés), comme Figma ; le pied reconnaît les
   bandeaux `github` et `github:<sourceId>`. Le filtre par compte ne regarde que le login (la source se choisit en D03).
4. **Copie 404 du projet** : « … ou dépend d'un autre compte. » (pas « … d'un autre compte Nuera Dev. », pour ne pas
   répéter « Nuera Dev » dans la phrase).
5. **« Premiers pas »** est aussi masquée dès que l'espace a lancé une session Claude Code dans un projet (§10
   « masquée une fois complète », sans drapeau persistant).
6. **Unicité** : la base l'impose par serveur ; le contrôle « déjà cloné » de l'application est par espace (tous ses
   serveurs, retirés compris), la restauration ne regarde que le même serveur. `gitIdentityOf` délègue à
   `server/sessions/git-identity.ts`.

### Lot W2 (sessions, Workspace, terminaux)

1. **Connexion MCP** : les terminaux `mcp-login` restent dans `startMcpLogin` (W3) ; `POST /api/terminals` refuse
   toujours `mcp-login` (422). `requireLoginTerminalServer(ctx)` (`server/terminals`) partage la règle « propriétaire
   de l'espace, serveur attribué ».
2. **Acteur** : instruction, interruption et arrêt n'envoient aucun acteur au runner (le contrat v2 n'a pas de champ) ;
   la reprise le porte par `launch.gitIdentity`, la création par `createdByUserId`, les décisions par
   `decidedByUserId`, les terminaux par `actorUserId`.
3. **Copies sans Figma** : « Seul le propriétaire de l'espace peut connecter Claude Code sur son serveur. », « Seuls
   les membres de cet espace peuvent piloter cette session. » (inaccessibles en v1), « Ce worktree est sur {serveur},
   qui n'est plus le serveur de votre espace. » ; un shell demandé sans serveur reçoit la copie commune
   `NO_ENVIRONMENT`.
4. **Nom par défaut** : « le serveur » (`serverLabel`) avant l'arrivée des données, au lieu de « VPS-3 » ; la galerie
   garde « VPS-3 » comme échantillon (`SAMPLE_SERVER_NAME`). La légende « Limite réglable dans Paramètres · Serveur »
   ne change pas.

### Lot W3 (intégrations)

1. **Bandeaux** : avec une seule source GitHub (ou le jeton de secours) la cible reste `github` (Accueil et M07
   inchangés) ; avec plusieurs, `github:<sourceId>`. Chaque bandeau porte `service` et `sourceId`.
2. **Source par défaut** : la plus ancienne (`created_at`, `id`), `github_sources` n'ayant pas de colonne
   `is_default` ; elle passe en premier partout (listes, résolution, rattachement paresseux).
3. **Application GitHub** : nom unique « Nuera Dev <4 hex> · <hôte> », 34 caractères au plus (l'hôte est coupé, jamais
   le suffixe). Libellé d'une source unique dans l'espace (« atelier-test 2 »…) ; un renommage vers un libellé déjà pris
   est refusé (409 « Une autre source GitHub de votre espace porte déjà ce nom. »).
4. **État signé** chiffré lié au compte : un autre compte ne peut pas le lire ; `wrong_account` est déduit des cookies
   (`nuera_github_state_<8 hex>` d'un autre compte présent, aucun du sien). Un état v1 reste accepté pendant son heure ;
   l'ancien cookie partagé est lu en dernier recours (jamais effacé, il expire seul).
5. **Routes internes** : `/api/internal/integrations/check` vérifie l'espace de l'appelant pour tout serveur attribué
   (409 sans espace ; route supprimée depuis, Y4-2) ; `mayUseInstanceCredentials` n'est plus appelée (git-credentials par la source du projet,
   mcp-headers par l'espace de la session).
6. **Assouplissements de signature** : `getProjectMcpTools`/`setProjectMcpServer` acceptent un appel sans `spaceId`
   (espace du projet déjà vérifié) ; `listProtectedBranches` accepte trois formes d'appel (cache par espace et source).
7. **MCP** : l'épinglage de l'URL ne s'applique que si l'assistant envoie `serverUrl` (anciens CLI sans
   `CLAUDE_CODE_MCP_SERVER_URL`) ; session, projet, registre et activation sont toujours vérifiés.
8. **Garde SSRF** (`server/security/ssrf.ts`) : refuse aussi multicast, diffusion et l'hôte de
   `NUERA_WEB_INTERNAL_URL` ; transport épinglé sur `node:http(s)` avec `lookup` propre (undici n'est pas une
   dépendance). Un `fetchImpl` injecté par un test contourne entièrement la garde (aucun appel de production).
9. **Coolify** : `ip_not_allowed` devient « L'adresse du serveur de Nuera Dev n'est pas autorisée par Coolify. » (c'est
   le web qui appelle Coolify) ; nouvelle erreur `address_refused` « L'adresse de Coolify désigne une machine interne :
   elle est refusée. ».
10. **Planificateur web** : il lance aussi, à son démarrage, une passe de rechiffrement des tables d'intégration ;
    `instrumentation.ts` appelle `ensureDefaultRunnerTokenHash()`.
11. **Copies sans Figma** : « Ajouter une source GitHub », « Déconnecter la source », la confirmation et ses
    conséquences, « N sources GitHub au plus par espace… », bandeaux `source_limit`, `wrong_account`,
    `choose_source`, titres « GitHub · <libellé> » quand il y a plusieurs sources (la tuile d'une source unique reste
    celle de Figma). Bases de test : `NUERA_DB_TEST_PREFIX` (défaut `nuera_integrations`).

### Lot W4 (comptes et administration)

1. **Récupération** : celle du propriétaire est refusée depuis l'administration (« Le compte du propriétaire ne se
   récupère qu'en ligne de commande… », commande de secours de F1-6) et un lien ne vise jamais son propre compte (un
   administrateur ne peut pas prendre la main sur le propriétaire). Un lien non utilisé est considéré comme servi
   (« Ce lien a déjà servi ») dès que le compte a réenrôlé une double authentification.
2. **Codes Better Auth** : `ACTIVATION_INCOMPLETE` (compte non propriétaire sans 2FA, renvoie vers son lien) à côté de
   `SETUP_INCOMPLETE` (propriétaire, renvoie vers `/configuration`).
3. **Réponses** : `/api/admin/**` répond 403 à un membre, la page `/administration` 404 ; un identifiant malformé reçoit
   le même 404 qu'un inconnu. L'action `reset-2fa` n'existe pas : `recovery` la couvre (2FA réinitialisée + lien).
4. **Rotation** : promotion par « Vérifier », puis aussi par `resolveRunnerCaller` et `callRunner` (C2a-3).
5. **Instance** : le PATCH n'accepte que les quatre clés d'instance (autres → 422).
6. **Espace initial** adopté par le propriétaire : renommé « Espace de … ».
7. **Serveurs** : le serveur par défaut ne peut pas être retiré ; un serveur retiré a son rôle PostgreSQL passé
   NOLOGIN (gardé pour l'unicité de `db_role`) ; un serveur `pending` promis à une invitation en cours ne peut pas
   être attribué à un autre compte (« Ce serveur est promis à l'invitation adressée à … : annulez-la d'abord. ») ;
   « En ligne » seulement sur un battement de moins de 3 min (sinon l'état d'attribution, jamais une panne devinée).
8. **Suppression d'un compte** : révoque aussi ses invitations et liens en cours, remet son rôle à `member` (un
   compte supprimé ne compte jamais comme administrateur) et arrête les sessions Claude Code encore vivantes sur son
   serveur (résultat et journal : `stoppedSessions`, `failedSessions`).

### Lot W5 (Paramètres et shell)

1. **Sous-titre de Paramètres** : « Compte, sécurité, Claude Code et serveur. Chaque compte a ses propres réglages. »
   (bureau) et « Compte de {prénom} » (téléphone), à la place de la phrase « Un seul propriétaire… » (§10 la retire sans
   remplaçant). Tuile d'identité titrée par le rôle, légende rôle + « · serveur {nom} » ou « · aucun serveur
   attribué ». Reporté dans `docs/figma/screens-desktop-b.md` (§4.2) et `screens-mobile.md` (M08).
2. **Garde du clic** sur une notification : page `/parametres/notification?vers=&compte=` (pas une route `/api`), pour
   passer par `/connexion` et revenir quand personne n'est connecté. « Se déconnecter » depuis la garde y revient
   aussi après la connexion (Y5-3).
3. **Push** : `GET /api/push/subscription/renew` est public (`{ enabled, publicKey }` pour le service worker) ; `POST`
   répond toujours 204 (et ne renouvelle que les lignes du compte connecté, Y1-1). `/api/push/config` exige une
   session (`auth: 'user'`).
4. **Temps réel** : le client ignore les `notification.created` de `seq ≠ 0` (diffusion du runner) et ne lit que le
   canal web du compte ; `notification.read` est lu côté client.
5. **PATCH /api/settings** : rien d'appliqué → le refus est levé (403/409/422) ; application partielle → 200 avec le
   résultat par clé ; `updateSettingsAction` échoue au moindre refus. `getOperationLog` : un id malformé répond NOT_FOUND
   « Opération introuvable. ».
6. **T5** : `AppShell` ne remplace jamais le contenu faute de serveur (les pages concernées affichent
   `NoServerAssigned`) ; l'onglet par défaut de Paramètres (vue d'ensemble) est aussi gardé sous bandeau, car il est
   le seul chemin vers Compte et sécurité et Préférences (changement visible pour le propriétaire quand son serveur
   tombe). Au téléphone, l'administration s'ouvre depuis le groupe « Instance » de Paramètres (le shell téléphone n'a
   pas de menu du profil).
7. **Divers** : rôles facultatifs sur `UserCard`/`Sidebar` (galerie) ; indication « {plafond} au plus (plafond fixé
   par un administrateur). » sous « Sessions parallèles » ; codes de secours téléchargés sous
   `nuera-dev-codes-de-secours-<partie locale de l'e-mail>.txt`.

### Lot X1 (reliquats du runner et de la rotation)

1. **Battement** (`apps/runner/src/app.ts`) : le battement du serveur (`last_seen_at`, relecture du statut et des
   réglages) n'est pas une tâche du planificateur ; il tourne toutes les 60 s même avec `NUERA_SCHEDULER=0`, qui ne
   coupe que la disponibilité et le `git fetch` périodique.
2. **Relecture fatale** (`apps/runner/src/environment.ts` `refresh`) : une relecture périodique de la ligne (battement,
   réglages, garde de statut) qui trouve le jeton sur un autre serveur, ou sur plusieurs lignes, arrête le processus
   (`RunnerFatalError` → arrêt avec le code 1), comme au démarrage ; avant, elle était seulement journalisée.
3. **Identifiant de session fourni** (`apps/runner/src/sessions/manager.ts` `assertSessionIdFree`) : l'unicité d'un
   `sessionId` choisi par l'appelant se vérifie par l'insertion elle-même, annulée dans une transaction : la clé
   primaire est unique sur tous les serveurs alors qu'un SELECT ne verrait pas, sous rôle restreint (RLS), la ligne
   d'un autre serveur. Réponse CONFLICT « Une session porte déjà cet identifiant. » quel que soit le serveur qui la
   détient, rien n'est créé (ni worktree ni fichier). Le web n'envoie jamais de `sessionId`.
4. **Raison `ENVIRONMENT_STARTING`** (`packages/shared` `RUNNER_ERROR_REASONS`) : les 503 de l'attente du bail
   (« Un autre runner du serveur « … » est encore actif : attente de son arrêt… ») et des tâches de reprise (« Le
   runner du serveur « … » démarre : réessayez dans un instant. ») la portent (remplace C1-5).
5. **Promotion du jeton au premier usage** : en plus de « Vérifier », le premier rappel authentifié par
   `next_token_hash` (`resolveRunnerCaller`) ou la première réponse du runner obtenue avec le nouveau jeton après un
   401 (`callRunner`, relais SSE) promeut le jeton renouvelé (`environment.token_promoted`) ; l'ancien cesse alors de
   fonctionner (W4-4, C2a-3). Cas limite non traité : si `token_encrypted` est illisible et `next_token_encrypted`
   lisible, le web emploie directement le nouveau jeton et seul « Vérifier » le promeut.

### Lot Y1 (push)

1. **Renouvellement** (`server/push/index.ts` `renewSubscription`, `app/api/push/subscription/renew/route.ts`) : le
   `POST` ne déplace ou ne rafraîchit que les lignes du compte dont le service worker porte le cookie
   (`requireUserForApi`, même règle que l'abonnement) ; les lignes d'un autre compte sur le même endpoint ne sont
   jamais touchées (purgées plus tard par un 404/410, ou réactivées par ce compte). Sans session : rien n'est écrit
   ni journalisé, réponse 204 identique. `security.push_renewed` porte ce compte en auteur et en sujet (plus d'acteur
   `system`). Un secret de renouvellement par ligne a été écarté : deux comptes d'un même profil de navigateur lisent
   tous deux ce que tient le service worker.
2. **Services push seulement** : un nouvel abonnement (et le nouvel endpoint d'un renouvellement) n'est accepté que
   vers FCM, Mozilla, WNS ou Apple (https, port par défaut, sans identifiants) ou un hôte de `NUERA_PUSH_HOSTS`
   (variable nouvelle) ; hors production, les hôtes `.test` (Vitest, e2e). Refus : 422 « service de notifications push
   non reconnu ». `pushEndpointSchema` reste « tout https » pour un endpoint qui ne sert que de clé (ancien endpoint,
   déconnexion, `DELETE`). L'envoi ne suit aucune redirection et ne contacte jamais une ligne plus ancienne sur un
   autre hôte.
3. **Durée de vie liée à l'accès** : `push_subscriptions.auth_session_id` n'est plus seulement informatif (§3.2).
   `sendPush` ne livre pas à une ligne dont l'accès manque, appartient à un autre compte, a expiré ou viole la
   politique d'accès (inactivité, durée maximale), et la supprime (compté dans `pruned`) ; `listPushDevices` et
   `isEndpointSubscribed` suppriment les lignes fermées du compte lui-même ; `isEndpointSharedWithOtherAccount` ignore,
   sans écrire, celles d'un autre compte. `enforceSessionPolicy` (`nuera-plugin.ts`) supprime les abonnements d'un
   accès avant de le fermer (compte désactivé, inactivité, durée maximale). Les lignes à `auth_session_id` nul
   (antérieures à la liaison) continuent de recevoir. Aucune migration.
4. **Changement visible** : un abonnement s'arrête avec l'accès web qui l'a créé (12 h d'inactivité par défaut,
   30 jours au plus) ; après une nouvelle connexion, la personne réactive les notifications (M08 propose « Activer »).

### Lot Y2 (base et runner)

1. **Migration `0005_runner_scope`** (snapshot et journal générés par `drizzle-kit generate`, SQL écrit à la main) :
   références croisées entre serveurs d'abord effacées, uniques `worktrees_id_environment_key` et
   `sessions_id_environment_key`, puis clés étrangères composites `sessions_worktree_env_fk`,
   `command_runs_worktree_env_fk`, `operations_worktree_env_fk`, `operations_session_env_fk` en
   `ON DELETE SET NULL (colonne)` (PostgreSQL 15+ : `environment_id NOT NULL` est gardé) ; le schéma Drizzle déclare
   `set null` (il n'exprime pas la liste de colonnes). Raison : une clé étrangère est vérifiée par le propriétaire de
   la table, hors RLS.
2. **Verrous consultatifs** : `0005` retire `EXECUTE` à `PUBLIC` sur les 16 fonctions qui prennent un verrou
   consultatif et le rend au rôle qui migre et au propriétaire des tables, **seulement si `migrate` est
   superutilisateur** (sinon `RAISE WARNING` et étape sautée). Le bail d'un rôle restreint passe par
   `nuera_runner_try_lease()` / `nuera_runner_release_lease()` (`SECURITY DEFINER`, même clé que sous DSN complet) ;
   le runner restreint y bascule (`databaseAccess().restricted`) et revient à l'appel direct sur 42883 (base encore en
   `0004`). Écart au §4 (« `pg_try_advisory_lock` sur une connexion dédiée ») pour les rôles restreints. Un runner
   restreint plus ancien n'obtient plus son bail après `0005` : serveurs supplémentaires à redéployer avec
   l'instance (`docs/DEPLOY.md` §12.6).
3. **Socket tmux** : `nuera` pour le serveur par défaut (sessions vivantes retrouvées), `nuera-<8 hex de l'id>` pour
   les autres, fixé une fois le serveur connu ; `NUERA_TMUX_SOCKET` l'emporte et n'a plus de défaut dans
   `config.ts`. `reattachTmux` refuse une session tmux dont `NUERA_SESSION_ID` (`tmux show-environment`, déjà posé par
   `new-session -e`) n'est pas l'id de la ligne : ligne `interrupted`, session laissée orpheline, jamais tuée.
4. **Sauvegardes** : `--no-privileges` perd aussi les droits de `0005` ; procédure de reprise dans
   `docs/DEPLOY.md` §9.

### Lot Y3 (administration des serveurs)

1. **Adresse d'un serveur** (`server/admin/servers.ts` `updateServer`) : sur le serveur d'un autre compte, seul le
   propriétaire de l'instance, avec son mot de passe (`verifyOwnPassword`, déplacé dans `admin/common.ts`) : 403
   « Seul le propriétaire de l'instance peut changer l'adresse du serveur d'un autre compte. » ou « Confirmez avec
   votre mot de passe pour changer l'adresse du serveur d'un autre compte. », rien d'écrit, aucun appel au runner. Un
   serveur en service (attribué ou sorti de `pending`) qui change d'adresse reçoit un nouveau jeton (`next_token_*`
   effacé) ; `PATCH /api/admin/servers/:id` répond `{ server, token }` et la console affiche le jeton une fois. Le
   compte est prévenu (« L'adresse interne de votre serveur {nom} a été modifiée par un administrateur. ») et nommé
   (`subject_user_id`, métadonnées `{ url, previousUrl, rotated }`). L'écriture est conditionnée à l'état vérifié
   (espace, statut, adresse) : sinon 409 « Ce serveur vient de changer : rouvrez-le, puis réessayez. ».
2. **Une adresse par serveur en service** (enregistrement et modification, `RUNNER_URL` comprise) : 409 « Cette adresse
   est déjà celle du serveur « {nom} ». » ; l'adresse d'un serveur retiré peut être reprise.
3. **Renouvellement du jeton** : compte prévenu (« Un administrateur a renouvelé le jeton de votre serveur {nom}. ») et
   nommé dans `admin.server_token_rotated`.
4. **Rôles `nuera_env_…`** (`db-roles.ts`) : `CONNECTION LIMIT` (`NUERA_RUNNER_DB_CONNECTION_LIMIT`, variable
   nouvelle, 4 à 500, défaut 20), `statement_timeout = 2min`, `idle_in_transaction_session_timeout = 1min`, à la
   création et au renouvellement du mot de passe ; les rôles existants ne sont pas repris (`docs/DEPLOY.md` §12.6).
5. **Connexions ouvertes** : retrait du serveur, suppression du compte et nouveau DSN les ferment après la transaction
   (`closeRunnerRoleConnections`, `pg_terminate_backend`) ; un refus est compté (`closedConnections`,
   `refusedConnections` dans le journal), jamais levé. Il faut un superutilisateur ou `pg_signal_backend`.
6. **« Accès base restreint »** vérifié par PostgreSQL (`db-access.ts` : `pg_roles`, `pg_stat_activity`), plus
   seulement par le battement. La règle par serveur (`application_name` `nuera-runner:<id>`) n'agira qu'une fois le
   runner modifié en ce sens.
7. **Copies sans Figma** : champ « Votre mot de passe » (« Ce serveur est celui d'un autre compte (…) : il sera prévenu
   du changement. »), « Nouveau RUNNER_TOKEN » après un changement d'adresse ; conséquences de « Renouveler l'accès
   base restreint » : « Le rôle existant reçoit un nouveau mot de passe : l'ancien DSN cesse de fonctionner et ses
   connexions ouvertes sont fermées. », « Le runner perd l'accès à la base jusqu'à son redéploiement avec la nouvelle
   RUNNER_DATABASE_URL. ». Un simple administrateur voit encore le champ d'adresse d'un serveur d'un autre compte
   (refus 403 à l'enregistrement).

### Lot Y4 (MCP et intégrations)

1. **Terminal de connexion MCP** (`server/mcp/diagnostics.ts` `startMcpLogin(ctx, idOrName)`) : garde
   `requireMcpLoginServer(ctx)` avant toute lecture et tout appel au runner — sans serveur `CONFLICT`
   `NO_ENVIRONMENT`, non-propriétaire de l'espace `FORBIDDEN` (copie de `LOGIN_TERMINAL_OWNER_ONLY`), serveur suspendu
   ou retiré `FORBIDDEN` `ENVIRONMENT_DISABLED` (écart à C1-7, côté web seulement) ; port du serveur du contexte,
   audit par `auditIn`. Le texte est copié (`MCP_LOGIN_OWNER_ONLY`, un test vérifie l'égalité) : importer
   `server/terminals` ferait un cycle de modules. `claude-login`/`claude-status` ne refusent toujours pas un serveur
   suspendu.
2. **`/api/internal/integrations/check` supprimée** : aucun appelant (runner, contrats, déploiement) ; elle rendait le
   résumé des intégrations d'un espace à tout détenteur d'un jeton de serveur et contournait le délai de 10 min.
3. **Audits `integration.*`** : tous portent `spaceId` (vérifié pour GitHub, Coolify, MCP).

### Lot Y5 (temps réel et déconnexion)

1. **Flux global pendant une panne du runner** (`server/runner/stream.ts`, ferme le GAP de C2a) : avec un canal web,
   le relais ne termine plus le flux ; il écrit `stream.error` `RUNNER_UNAVAILABLE` (une fois par panne), puis
   `runner.unavailable { retryInMs }`, continue de livrer le canal web, retente toutes les 10 s
   (`RUNNER_PROBE_INTERVAL_MS`) en reprenant après le dernier identifiant relayé, puis écrit `runner.available`. Il
   relit le point d'accès avant chaque essai (jeton ou adresse changés) et termine le flux si le serveur est remplacé,
   retiré ou suspendu, ou après 5 min de panne (`DEGRADED_STREAM_MAX_MS`), pour que le navigateur repasse par
   l'authentification. Sans canal web (autres relais), comportement inchangé.
2. **Événements `runner.*`** : événements web (seq 0, sans `id:`), hors du contrat de `@nuera/shared` comme
   `notification.read`, lus par `hooks/useLiveEvents.tsx` (`parseRunnerAvailability`) : T5 et son compte à rebours
   sans couper le flux, aucune preuve de vie tirée des battements du web, relecture de l'état à `runner.available`.
3. **Déconnexion depuis la garde du clic** (`app/(shell)/parametres/notification`, `app/(auth)/deconnexion`) :
   « Se déconnecter » mène à `/deconnexion?suivant=<garde>` puis `/connexion?suivant=<garde>` ; chemin interne
   revalidé à chaque étape (`safeRedirectPath`), `/connexion` seul sinon.
