# Nuera Dev — Sécurité

> Référence de sécurité de l'application web (`apps/web`), du runner (`apps/runner`) et de leurs frontières, dans la
> version **multi-comptes** (`docs/MULTICOMPTE.md`, qui fait foi). Complète `docs/ARCHITECTURE.md` §9. Toute nouvelle
> route, action serveur, table ou intégration respecte les règles ci-dessous. Les risques acceptés sont listés au §11.

## 1. Modèle de menace (résumé)

Plusieurs comptes travaillent en même temps, chacun dans **son espace** et sur **son serveur** (une instance du
runner, une connexion Claude). Un compte ne doit jamais voir ni modifier les données d'un autre espace, même en
devinant des identifiants, et un administrateur gère comptes et serveurs sans voir le contenu des espaces.

| Actif | Menaces principales | Parades |
|---|---|---|
| Accès à Nuera Dev (chaque compte) | vol de mot de passe, hameçonnage, vol de cookie, force brute | mot de passe ≥ 12 caractères (scrypt), TOTP **obligatoire pour tous**, clés d'accès avec vérification de l'utilisateur, cookies `HttpOnly`/`Secure`/`SameSite=Lax`, expiration d'inactivité et absolue, limites de débit, journal personnel |
| Données d'un espace (projets, sessions, worktrees, autorisations, lancements, opérations, PR, variables, sources GitHub, Coolify, MCP, notifications, réglages) | lecture ou écriture par un autre compte, énumération d'identifiants | contexte de requête côté serveur (l'espace n'est jamais choisi par le client), gardes de portée, réponse d'un identifiant étranger **identique** à celle d'un inconnu (§4) |
| Comptes et instance | création de compte par un tiers, prise de contrôle du propriétaire, élévation de rôle | inscription fermée, `/configuration` protégée par `SETUP_TOKEN`, invitations à usage unique, rôles gardés côté serveur (§2.5), récupération du propriétaire en ligne de commande seulement |
| Sessions Claude Code, dépôts, terminaux (runners) | exécution par un tiers, fuite d'un jeton, accès d'un runner aux données d'un autre serveur | runner jamais exposé, jeton propre à chaque serveur, cloisonnement de chaque requête par serveur, rôle PostgreSQL restreint + RLS (§7), chemins confinés, `execFile` sans shell, environnement nettoyé |
| Secrets applicatifs (sources GitHub, Coolify, MCP, variables de projet, jetons des serveurs) | lecture de la base, déplacement d'un chiffré vers une autre ligne, fuite vers le navigateur | AES-256-GCM lié à sa ligne (§5), jamais renvoyés au client, affichage masqué |
| Mutations (formulaires, API JSON) | CSRF, requêtes inter-sites | vérification `Origin`/`Sec-Fetch-Site`/`Referer` contre `APP_URL`, `SameSite=Lax` |
| Réseau interne (runners, PostgreSQL) | requête sortante vers une adresse interne choisie par un compte (SSRF) | garde des requêtes sortantes (§8) |
| Intégrité de l'historique | actions sensibles non tracées | `audit_log` append-only, auteur figé, espace, serveur et sujet (§6) |

Hors périmètre : compromission du serveur Docker lui-même (root), de Coolify, d'un compte GitHub ou Claude. Nuera Dev
ne stocke **aucun** identifiant Claude (règle P2) ; chaque personne se connecte elle-même à Claude Code sur son propre
serveur.

## 2. Comptes et authentification

Implémentation : Better Auth 1.7 (`apps/web/src/server/auth/auth.ts`) + plugins `twoFactor`, `passkey`
(`@better-auth/passkey`), `nueraAuthPlugin` (`nuera-plugin.ts`, règles propres à Nuera Dev, placé après `twoFactor`)
et `nextCookies` (dernier).

### 2.1 Rôles

`user.role` : `owner` (un seul, index `user_owner_idx`), `admin`, `member` ; `role` et `disabledAt` sont des champs
additionnels que **aucun** endpoint n'accepte en entrée. L'interface dit « Propriétaire », « Administrateur »,
« Membre ». Owner et admin gèrent comptes, serveurs et instance ; personne ne voit le contenu d'un autre espace.

### 2.2 Création des comptes

- **Inscription fermée** : `user.create.before` refuse toute création (`SIGN_UP_CLOSED`, « Les inscriptions sont
  fermées : demandez une invitation à un administrateur. »). Les comptes sont écrits par les transactions de Nuera
  Dev (`server/auth/accounts.ts`).
- **Propriétaire** : `/configuration` avec `SETUP_TOKEN` (≥ 16 caractères, comparaison à temps constant, 5 essais /
  15 min / IP), sous verrou consultatif ; la page répond 404 dès qu'un propriétaire a sa 2FA (reprise par jeton
  seulement pour un propriétaire sans 2FA). La création adopte l'« Espace initial » sans propriétaire d'une base
  migrée (renommé « Espace de … »).
- **Invitation** (owner/admin) : e-mail, rôle `admin` ou `member`, validité (réglage d'instance, 48 h par défaut,
  1–168 h), serveur `pending` facultatif. Le lien `/invitation/<jeton>` est affiché **une fois** (seule son empreinte
  sha256 est stockée) ; Nuera Dev n'envoie aucun e-mail. Réinviter la même adresse remplace le lien en cours ; un lien
  se révoque. L'acceptation crée, dans **une** transaction qui consomme le jeton : compte, espace personnel, membre,
  `space_settings`, `user_preferences`, MCP préréglés et rattachement du serveur ; puis « Activation de votre compte »
  (TOTP → codes de secours → clé d'accès). Le lien reste utilisable pour reprendre l'activation, avec le mot de passe
  choisi, jusqu'à l'enrôlement de la 2FA.

### 2.3 Connexion et double authentification

- **Mot de passe** : 12 à 128 caractères, lettres + chiffre ou symbole, ni nom ni e-mail, pas de mot de passe courant
  (`password-policy.ts`), hachage scrypt. Pas de réinitialisation par e-mail : lien de récupération (§9).
- **2FA obligatoire pour tous les comptes** : TOTP (émetteur « Nuera Dev », 6 chiffres, 30 s) + 8 codes de secours à
  usage unique (chiffrés par Better Auth). `/two-factor/disable` est bloqué (HTTP et serveur). Better Auth limite chaque
  défi à 5 essais et verrouille la 2FA 15 min après 10 échecs. « Approuver cet appareil pendant 30 jours » : cookie
  signé, révocable en base, décoché par défaut. Aucune variable ne désactive la 2FA (`NUERA_REQUIRE_2FA` supprimée).
- **`session.create.before`** (après la vérification du mot de passe, sur tous les parcours, clés d'accès comprises :
  un refus ne révèle jamais si l'e-mail existe) :
  - compte désactivé ou supprimé → `ACCOUNT_DISABLED` « Ce compte est désactivé. Contactez un administrateur. » ;
  - connexion par mot de passe d'un compte sans 2FA → `SETUP_INCOMPLETE` (propriétaire, vers `/configuration`) ou
    `ACTIVATION_INCOMPLETE` (autres comptes, vers leur lien), **sauf** avec une autorisation d'enrôlement.
- **Autorisation d'enrôlement** (`enrolment-grant.ts`) : émise par un parcours qui vient de vérifier plus fort que le
  mot de passe (jeton `SETUP_TOKEN`, lien d'invitation ou de récupération), liée à **un** e-mail, à usage unique,
  60 s, transmise en en-tête d'un appel `auth.api.*` (jamais au navigateur), en mémoire du processus web.
- **Clés d'accès** : WebAuthn, `rpID` = hôte d'`APP_URL`, origine = `APP_URL`, vérification de l'utilisateur
  **exigée** (une clé d'accès vaut deux facteurs) ; ajout seulement une fois la 2FA active, sur une session de moins
  d'une heure (`SESSION_NOT_FRESH`). Changer `APP_URL` rend inutilisables les clés d'accès de tous les comptes.
- **Parcours** : `/connexion` (e-mail + mot de passe → `/connexion/deux-facteurs`) ; « Se connecter avec une clé
  d'accès » ; `/deconnexion` (POST seulement ; le formulaire envoie l'endpoint push de l'appareil pour supprimer son
  abonnement). Un compte par profil de navigateur (mention sur `/connexion`) ; pas de sélecteur de comptes en v1.

### 2.4 Désactiver, réactiver, supprimer

- **Désactiver** : accès web et appareils de confiance supprimés, abonnements push supprimés, serveur `suspended`
  (rappels internes refusés, aucune nouvelle session, clonage ni commande) ; option « Arrêter aussi ses sessions Claude
  Code en cours ». Une requête en cours d'un compte désactivé est traitée comme déconnectée (`getCurrentUser()` → null)
  et sa session supprimée à la requête suivante. **Réactiver** : l'inverse.
- **Supprimer** : seulement un compte désactivé ; anonymisation (`deleted_at`), espace archivé, serveur `retired`
  (rôle PostgreSQL passé NOLOGIN), invitations et liens en cours révoqués, rôle remis à `member`, sessions Claude encore
  vivantes arrêtées (`stoppedSessions`, `failedSessions` dans le résultat et le journal). Les dépôts GitHub ne sont
  jamais touchés.

### 2.5 Gardes

Le propriétaire n'est ni désactivé, ni supprimé, ni rétrogradé ; un administrateur n'agit jamais sur son propre
compte (aucune action qui se verrouille soi-même) ; le dernier administrateur actif est protégé ; un lien de
récupération ne vise jamais son auteur ni le propriétaire (celui-ci se récupère en ligne de commande, §9) ; un serveur
déjà utilisé n'est jamais réattribué ; un serveur promis à une invitation en cours ne peut pas être attribué à un autre
compte. Chaque fonction de `server/admin` revérifie le rôle de l'acteur qu'elle reçoit.

## 3. Sessions web

- Cookies `nuera.*` (`__Secure-nuera.*` en production), `HttpOnly`, `SameSite=Lax`, `Path=/`, sans `Domain` ; pas de
  cache de session dans un cookie : chaque requête relit la base. Le préfixe `__Host-` n'est pas possible (Better Auth
  1.7 préfixe lui-même par `__Secure-`) ; l'absence de `Domain` donne la même portée.
- **Durée absolue** : `app_settings.webSessionMaxDays` (30 j par défaut, 90 max), fixée à la création, jamais
  prolongée. **Inactivité** : `app_settings.webSessionIdleHours` (12 h), dernière activité rafraîchie au plus toutes
  les 5 min, vérifiée par `nueraAuthPlugin` avant **chaque** appel Better Auth (une session expirée est supprimée et
  journalisée). Ces réglages sont d'instance (owner/admin).
- `requireContext()` (pages, actions) redirige vers `/connexion` (ou l'étape 2FA, ou l'activation) ;
  `requireContextForApi()` lève `UNAUTHORIZED` / `FORBIDDEN`. `src/proxy.ts` ne fait qu'un contrôle **optimiste** de
  présence du cookie (redirection, 401 JSON pour `/api/*`) ; pages publiques : `/connexion`, `/configuration`,
  `/invitation/<jeton>`, `/recuperation/<jeton>`.
- **Garde d'identité multi-onglets** : le flux global annonce le compte (`stream.hello`) et les onglets d'un navigateur
  s'annoncent sur le `BroadcastChannel` « nuera-compte » ; un onglet dont le cookie désigne désormais un autre compte
  se recharge.
- Paramètres › Compte et sécurité : accès ouverts, « Cet appareil », révocation unitaire ou des autres accès (les
  abonnements push de l'accès révoqué sont supprimés, `server/auth/account.ts`).

## 4. Requêtes, cloisonnement, limitation de débit

- **`apiRoute({ auth })`** (`src/server/http.ts`) : `'space'` (**défaut** : compte avec 2FA + contexte de requête
  `{ user, space, environment }`), `'user'` (compte seul : push, notifications…), `'admin'` (owner ou admin, sinon 403),
  `false` (public). Puis vérification d'origine sur toute méthode non sûre, validation Zod (params, query, corps JSON
  ≤ 1 Mio), erreurs `{ error: { code, message, detail?, raw?, untouched?, reason? } }` sans pile d'appels. La page
  `/administration` répond 404 à un membre, `/api/admin/**` 403.
- **Contexte** (`server/tenancy/context.ts`) : v1 = l'espace personnel du compte, jamais choisi par le client ;
  `requireEnvironment(ctx)` → `CONFLICT` `NO_ENVIRONMENT` (« Aucun serveur ne vous est encore attribué : un
  administrateur doit vous en attribuer un. ») au lieu d'un appel de runner.
- **Cloisonnement** (`server/tenancy/scope.ts`) : `scopeOfProject`, `scopeOfSession`, `scopeOfWorktree`, `scopeOfRun`,
  `scopeOfOperation`, `scopeOfPermission`, `scopeOfTerminal` (et `scopeOfTerminalInput`, verdict positif gardé 60 s pour
  la frappe), `ofSpace`/`inSpace` pour les listes. Un identifiant d'un autre espace — ou qui n'est pas un uuid — reçoit
  **exactement** la réponse d'un identifiant inconnu (404, même message), sans appel au runner, sans écriture, sans
  audit métier. Les appels liés à une ressource passent par le serveur de cette ressource (`projects.environment_id`).
  Suites d'isolation : `app/api/{projects,sessions,integrations}/isolation.test.ts`, `server/tenancy/*.test.ts`,
  `e2e/isolation.spec.ts`.
- **Origine** (`security/origin.ts`) : `Origin` doit valoir l'origine d'`APP_URL` (hors production, l'origine dérivée
  de `Host` est aussi admise) ; sans `Origin`, `Sec-Fetch-Site: same-origin` ou un `Referer` de même origine ; sinon
  refus. Les actions serveur d'authentification font le même contrôle.
- **Rappels des runners** `/api/internal/*` : `internalRoute()` — `Authorization: Bearer <jeton du serveur>`
  (empreinte comparée à temps constant) → `CallerEnvironment` ; serveur `suspended`/`retired` → 403 ; chaque route
  vérifie que la ressource appartient à **ce** serveur (sinon 404 + `security.runner_scope_violation`). Le serveur par
  défaut n'est désigné que par `RUNNER_TOKEN` ; pendant une rotation, `next_token_hash` est accepté et le premier
  appel réussi avec le nouveau jeton le promeut (`environment.token_promoted`). Aucun rappel ne déclenche les
  vérifications d'intégrations (horloge du web seulement) : l'ancienne route `/api/internal/integrations/check`, sans
  appelant, est supprimée (elle rendait le résumé des intégrations d'un espace à tout détenteur d'un jeton de serveur).
- **Limites de débit** : Better Auth pour `/api/auth/*` (5 connexions / min) ; limiteur mémoire à fenêtre glissante
  (`security/rate-limit.ts`, `AUTH_RATE_LIMITS`) pour les actions serveur : jeton de configuration 5 / 15 min ;
  connexion 10 / 10 min par IP + e-mail et filet de 50 / 10 min par IP ; second facteur 10 / 10 min par compte et
  50 / 10 min par IP ; enrôlement 10 / 10 min ; jetons d'invitation/récupération 10 / 15 min par IP ; mutations
  d'administration 30 / 10 min par administrateur ; actions sensibles (re-saisie du mot de passe) 10 / 15 min. Routes
  `apiRoute()` : une fenêtre par méthode et motif de route (`api:POST:/api/worktrees/:id/push`), par IP + compte ;
  toute mutation sans règle propre reçoit 120 / min (la frappe d'un terminal s'en exclut) ; règles plus strictes
  route par route (clone 20 / 10 min, session 20 / 10 min, push et PR 30 / 10 min, commit 60 / 10 min, test MCP
  30 / min, connexion MCP 10 / 10 min, jeton Coolify 10 / 10 min…). `NUERA_RATE_LIMIT_FACTOR` n'agit **jamais** en
  production.
- **Adresse IP** : `TRUSTED_IP_HEADER` (défaut `x-real-ip`, puis la dernière entrée de `x-forwarded-for`) ; configurer
  Traefik/Coolify pour écraser `X-Real-IP`. **Lieu** : seulement avec un en-tête de confiance (`TRUSTED_CITY_HEADER`) ;
  sinon l'IP. Les administrateurs voient les IP de connexion de tous les comptes (journal d'instance, mention dans
  Paramètres).
- **En-têtes HTTP** (`next.config.ts`) : CSP (`default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`,
  `base-uri 'self'`, `form-action 'self'` + github.com pour le flux manifest ; `'unsafe-eval'` hors production
  seulement), `X-Frame-Options: DENY`, HSTS 2 ans en production, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Opener-Policy: same-origin`, pas de
  `X-Powered-By`.

## 5. Secrets et rotation de `APP_ENCRYPTION_KEY`

- `encryptSecret` / `decryptSecret` (`security/crypto.ts`) : AES-256-GCM, IV aléatoire de 96 bits, étiquette de
  128 bits ; **portée obligatoire** : identifiant de clé, table et propriétaire en données associées (`SecretScopes` :
  `githubSource(id)`, `integration(spaceId, kind)`, `mcpServer(id)`, `projectEnvVar(projectId, clé)`,
  `environmentToken(id)`, `githubManifestState(userId)`). Un chiffré copié sur une autre ligne ne se déchiffre pas.
  L'ancien format (données associées = identifiant de clé seul) reste lu ; `reencryptSecret()` le réécrit lié à sa
  ligne, `needsReencryption()` le repère. Le planificateur web fait une passe de rechiffrement des tables
  d'intégration à son démarrage ; les sources GitHub et Coolify sont rechiffrées à la lecture.
- Variables : `APP_ENCRYPTION_KEY` (32 octets en base64), `APP_ENCRYPTION_KEY_ID` (défaut `v1`),
  `APP_ENCRYPTION_PREVIOUS_KEYS` (`v0:<base64>,…`, déchiffrement seulement).
- **Rotation** : nouvelle clé ; déployer avec `APP_ENCRYPTION_KEY=<nouvelle>`, `APP_ENCRYPTION_KEY_ID=v2`,
  `APP_ENCRYPTION_PREVIOUS_KEYS=v1:<ancienne>` ; laisser la passe de rechiffrement tourner (redémarrage du web) et
  rechiffrer le reste (`project_env_vars.value_encrypted`, `mcp_servers.secrets_encrypted`,
  `environments.token_encrypted`/`next_token_encrypted`) avec `reencryptSecret()` ou en les ré-enregistrant ; puis
  retirer l'ancienne clé.
- **Jetons des serveurs** : format `nrt_` + base64url(32 octets), affichés **une fois** ; le web garde le chiffré et
  l'empreinte sha256, le runner ne compare que l'empreinte. Le jeton du serveur par défaut est `RUNNER_TOKEN`
  (`migrate` en enregistre l'empreinte, jamais la valeur) ; « Renouveler le jeton » d'un autre serveur écrit
  `next_token_*` (les deux jetons valent jusqu'à la promotion) et prévient le compte du serveur. Une **nouvelle
  adresse** sur un serveur en service (attribué, ou déjà sorti de `pending`) remplace `token_*` et efface
  `next_token_*` : l'ancien jeton, ni celui d'une rotation en cours, n'est jamais envoyé à la nouvelle adresse, et le
  nouveau est affiché une fois. L'adresse du serveur d'un autre compte ne se change que par le propriétaire de
  l'instance, avec son mot de passe (403 « Seul le propriétaire de l'instance peut changer l'adresse du serveur d'un
  autre compte. » sinon, rien d'écrit) ; le compte est prévenu et nommé (`subject_user_id`) dans
  `admin.server_updated`. L'écriture n'a lieu que si le serveur est encore dans l'état vérifié (attribution, retrait
  ou déplacement concurrent : 409 « Ce serveur vient de changer : rouvrez-le, puis réessayez. »). Deux serveurs en
  service n'ont jamais la même adresse (`RUNNER_URL` comprise, 409).
- `BETTER_AUTH_SECRET` (≥ 32 caractères) signe les cookies et chiffre le secret TOTP et les codes de secours : le
  changer **invalide toutes les sessions et la 2FA de tous les comptes**. `SETUP_TOKEN` : à retirer une fois le
  propriétaire configuré.
- Jamais de secret dans les journaux, l'audit (`sanitizeMetadata` retire les clés sensibles), les réponses d'erreur,
  les URL ou l'argv ; les jetons `nrt_` sont masqués par le runner.

## 6. Journal (`audit_log`)

`audit(entry)` / `auditIn(ctx, entry)` (`security/audit.ts`, `server/tenancy/scope.ts`) : résumé français court,
auteur (`actor_user_id` + `actor_label`, e-mail figé), `space_id`, `environment_id`, `subject_user_id` (compte visé ;
sans clé étrangère : les lignes survivent aux suppressions), IP et agent utilisateur.

- **Journal personnel** (Paramètres, `listUserJournal`) : mes événements `auth.*`, `settings.*`, `security.*` ; les
  actions `admin.*`, `auth.*`, `security.*`, `settings.*` qui me visent ; les événements `permission.*`,
  `integration.*`, `settings.*` de mon espace.
- **Journal d'instance** (Administration › Journal, `listInstanceJournal`) : `auth.*`, `admin.*`, `environment.*`,
  `instance.*`, `security.*` de tous les comptes — jamais `git.*`, `project.*`, `session.*`, `terminal.*`, jamais
  l'identité d'un compte Claude.

| Famille | Actions |
|---|---|
| Comptes | `auth.owner_created`, `auth.setup_token_rejected`, `auth.setup_codes_acknowledged`, `auth.setup_completed`, `auth.invitation_accepted`, `auth.recovery_link_used`, `auth.sign_in`, `auth.sign_in_new_device`, `auth.sign_in_failed` (avec le compte de l'e-mail essayé), `auth.2fa_enabled`, `auth.2fa_failed`, `auth.backup_code_used`, `auth.backup_codes_regenerated`, `auth.passkey_added`, `auth.passkey_removed`, `auth.password_changed`, `auth.session_revoked`, `auth.other_sessions_revoked`, `auth.session_expired`, `auth.sign_out` |
| Administration | `admin.invitation_created`, `admin.invitation_revoked`, `admin.role_changed`, `admin.account_disabled`, `admin.account_enabled`, `admin.account_deleted`, `admin.sessions_revoked`, `admin.recovery_link_created`, `admin.recovery_link_cli`, `admin.server_registered`, `admin.server_verified`, `admin.server_assigned`, `admin.server_token_rotated`, `admin.server_updated`, `admin.server_retired`, `admin.server_database_restricted` |
| Instance et serveurs | `instance.settings_updated`, `environment.registered`, `environment.updated`, `environment.token_promoted` |
| Réglages | `settings.updated` (espace, limites du serveur, préférences ; `metadata.scope`) |
| Sécurité | `security.runner_scope_violation`, `security.push_subscribed`, `security.push_unsubscribed`, `security.push_renewed` |
| Espace | `session.*` (création, reprise, arrêt, archivage, renommage), `permission.*` (décisions), `git.commit`, `git.push`, `github.pull_request`, `project.*` (création, archivage, restauration, renommage, options, commandes, branches, worktrees, clone, `claude_md_written` sans le contenu, variables sans la valeur, lancements, synchro), `maintenance.worktree_removed`, `terminal.open`, `integration.github.*`, `integration.coolify.*`, `integration.mcp.*` |

Non journalisés : indexation, interruption, envoi d'une instruction, frappe et redimensionnement d'un terminal, lecture
des notifications, thème. Les décisions d'autorisation prises **dans le terminal brut** ne passent pas par le web.

## 7. Runners (serveurs)

- **Exposition** : aucun port publié, aucun domaine ; joignable seulement sur les réseaux Docker internes. Le serveur
  des hooks de Claude écoute sur `127.0.0.1` et exige le jeton propre à chaque session. Le web vérifie l'hôte d'une URL
  de runner contre `NUERA_RUNNER_HOSTS` quand elle est définie (http(s), sans identifiants).
- **Jeton** : hook Fastify `onRequest` sur **toutes** les routes (y compris `/v1/health` et les 404), empreintes
  comparées à temps constant. Le runner trouve son serveur par `sha256(RUNNER_TOKEN)` ; inconnu, retiré ou ambigu
  (deux lignes) → attente : `/v1/health` seule, 503 `ENVIRONMENT_UNREGISTERED` ailleurs. Il ne revendique jamais une
  ligne lui-même.
- **Un runner par serveur** : bail exclusif (`pg_try_advisory_lock` dérivé de l'id du serveur, sur une connexion
  réservée ; perte du bail = arrêt) et marqueurs `.nuera-environment` dans `NUERA_DATA_DIR` et `NUERA_PROJECTS_ROOT`
  (un dossier d'un autre serveur arrête le runner). Une relecture périodique de la ligne qui trouve le jeton sur un
  autre serveur (ou sur plusieurs) arrête aussi le runner. Pendant l'attente du bail ou les tâches de reprise : 503
  `ENVIRONMENT_STARTING`.
- **Verrous consultatifs** (`0005_runner_scope.sql`) : `PUBLIC` perd `EXECUTE` sur les 16 fonctions qui prennent un
  verrou consultatif (seuls le rôle qui migre et le propriétaire des tables les gardent), sinon un rôle restreint
  pourrait tenir le verrou de `migrate`, le bail d'un autre serveur ou les verrous du web. Un rôle restreint prend
  son seul bail par `nuera_runner_try_lease()` / `nuera_runner_release_lease()` (`SECURITY DEFINER`, `search_path`
  figé, clé de **son** serveur, `false` pour un rôle sans serveur ou retiré). Les fonctions de déverrouillage restent
  publiques : une session ne libère que ses propres verrous.
- **tmux** : un socket par serveur (`nuera` pour le serveur par défaut, `nuera-<8 hex de l'id>` pour les autres ;
  `NUERA_TMUX_SOCKET` l'emporte) ; avant tout rattachement, le runner lit `NUERA_SESSION_ID` de la session tmux
  (`tmux show-environment`) et refuse une session lancée pour une autre ligne (ligne `interrupted`, session tmux
  laissée en place, jamais tuée ni adoptée).
- **Cloisonnement** : chaque liste et chaque tâche filtre `environment_id = son serveur` ; chaque recherche par id porte
  ce filtre **dans la requête** (404 identique à un inconnu, avant toute écriture). Statuts `suspended`/`retired` :
  aucune nouvelle session, clonage, lancement ni terminal de shell (`ENVIRONMENT_DISABLED`) ; lecture et arrêt restent
  possibles.
- **Rôle PostgreSQL restreint** (`0004_runner_roles.sql`) : les sessions Claude, terminaux et commandes tournent sous
  l'utilisateur du runner et peuvent lire son environnement, donc son DSN. Chaque serveur enregistré reçoit un rôle de
  connexion `nuera_env_<8 hex>` membre de `nuera_runner` (DSN affiché une fois, `RUNNER_DATABASE_URL`) : SELECT/INSERT
  sur les seules tables du runner, UPDATE colonne par colonne, ni DELETE ni TRUNCATE, colonnes explicites sur
  `environments`/`projects`/`app_settings` (seul `force_block_bypass_permissions`), **RLS** par
  `nuera_runner_environment_id()` (`SECURITY DEFINER`, `environments.db_role = session_user`, serveurs retirés
  masqués), aucun accès aux tables d'authentification, invitations, sources, intégrations, MCP, variables,
  notifications, push, journal. Les clés étrangères vers `worktrees` et `sessions` sont composites (`(worktree_id,
  environment_id)`, `(session_id, environment_id)`, `0005`) : une clé étrangère est vérifiée par le propriétaire de la
  table, hors RLS, et une clé sur l'id seul laissait un runner relier ses lignes au worktree ou à la session d'un
  autre serveur. Chaque rôle a un `CONNECTION LIMIT` (`NUERA_RUNNER_DB_CONNECTION_LIMIT`, 20 par défaut),
  `statement_timeout = 2min` et `idle_in_transaction_session_timeout = 1min` ; le retrait du serveur, la suppression
  du compte et un nouveau DSN ferment ses connexions ouvertes (`pg_terminate_backend`, compté dans le journal ; un
  refus de PostgreSQL est compté, jamais levé). Le battement publie `capabilities.database.restricted`, mais cette
  colonne est écrite par le runner : le web ne déclare un serveur « restreint » que si PostgreSQL le confirme
  (`pg_roles` : rôle de `environments.db_role` qui se connecte, ni superutilisateur ni `BYPASSRLS`, membre de
  `nuera_runner`, sans les droits du propriétaire ; `pg_stat_activity` : aucune connexion `nuera-runner…` du serveur
  par défaut sur un rôle non vérifié, `server/admin/db-access.ts`). Tant que le serveur par défaut ne l'est pas,
  l'administration affiche « Le serveur VPS-3 accède encore à toute la base de données. » (`docs/DEPLOY.md` §14).
- **Terminaux de connexion** : `claude-login`, `claude-status` (`requireLoginTerminalServer`) et `mcp-login`
  (`requireMcpLoginServer`, même copie) sont réservés au propriétaire de l'espace sur un serveur attribué ;
  `mcp-login` est aussi refusé sur un serveur suspendu ou retiré (`ENVIRONMENT_DISABLED`), avant toute lecture et tout
  appel au runner.
- **Contrat** : `RUNNER_CONTRACT_VERSION = 2` exposé par `/v1/health` ; le web refuse poliment une route plus récente
  que le contrat du runner (`RUNNER_OUTDATED`). Chaque route est déclarée dans `@nuera/shared/runner` et validée par
  Zod (corps ≤ 2 Mio).
- **Processus** : `execFile` avec tableau d'arguments (exception documentée : les commandes du projet), chemins
  `realpath` confinés à `NUERA_PROJECTS_ROOT` / `NUERA_DATA_DIR`, références Git libres passées par `refExists()`
  (refus d'un nom commençant par `-`), `GIT_TERMINAL_PROMPT=0`, hooks Git désactivés, réglages dangereux du dépôt
  refusés (`GIT_CONFIG_UNSAFE`), `core.autocrlf=false`. Jetons GitHub d'installation réduits par opération et par
  dépôt, servis par le web pour **la source du projet** et injectés par processus (`GIT_CONFIG_*` →
  `http.https://github.com/.extraheader`). Environnement nettoyé (`ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `RUNNER_TOKEN`, `DATABASE_URL`, `RUNNER_DATABASE_URL`, `BETTER_AUTH_SECRET`, `APP_ENCRYPTION_KEY*`, `SETUP_TOKEN`,
  `VAPID_*`, `GITHUB_*`, `GIT_*`…) ; seules valeurs de confiance injectées : `CLAUDE_CONFIG_DIR` (dev/tests) et
  l'identité Git du compte (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`).
- **Claude Code** : binaire officiel en session interactive ; jamais de lecture de `~/.claude/.credentials.json` ;
  `bypassPermissions` bloqué sauf si l'espace l'autorise **et** que l'instance ne le bloque pas (échec fermé si la
  colonne est illisible) ; décisions d'autorisation prises dans Nuera Dev journalisées.

## 8. Intégrations et requêtes sortantes

- **Par espace** : sources GitHub (10 au plus), Coolify, registre MCP ; un rappel de runner ne reçoit que les
  identifiants de l'espace de **sa** ressource (git-credentials : la source du projet ; mcp-headers : le registre,
  Coolify et la source de l'espace de la session, URL du serveur MCP épinglée). `GITHUB_FALLBACK_TOKEN` est réservé à
  l'espace du serveur par défaut et jamais servi au MCP. Détail : `docs/INTEGRATIONS.md`.
- **État signé GitHub** : chiffré et lié au compte (`{ purpose, userId, spaceId, sourceId? }`, une heure), cookie
  `nuera_github_state_<8 hex>` propre au compte ; une installation n'est ajoutée à la liste d'autorisation qu'avec un
  état valide émis pour cette source.
- **Garde SSRF** (`security/ssrf.ts`, `guardedFetch`) pour toute adresse venue d'un compte (serveurs MCP
  personnalisés, métadonnées OAuth, Coolify) : refus de la boucle locale, du lien-local, des adresses non spécifiées,
  du multicast et de la diffusion, des hôtes des serveurs enregistrés (`RUNNER_URL`, `environments.url`), de la base
  (`DATABASE_URL`) et de `NUERA_WEB_INTERNAL_URL`, par nom et par adresse ; chaque adresse résolue doit passer, la
  requête part vers cette adresse seule (épinglée) et ne suit aucune redirection. Exception explicite :
  `NUERA_PRIVATE_HOSTS` (hôtes ou adresses séparés par des virgules). Copie : « L'adresse de Coolify désigne une
  machine interne : elle est refusée. ».
- **Services push** (`isPushServiceEndpoint`, `server/push/index.ts`) : un endpoint venu d'un navigateur n'est
  accepté (422 « service de notifications push non reconnu » sinon, sans répéter l'adresse) et contacté que s'il est
  en https, sans identifiants, sur le port par défaut d'un service connu (`fcm.googleapis.com`,
  `*.push.services.mozilla.com`, `*.notify.windows.com`, `*.push.apple.com`) ou d'un hôte de `NUERA_PUSH_HOSTS` ; les
  hôtes `.test` ne valent qu'hors production. L'envoi ne suit aucune redirection (`redirect: 'manual'`, un 3xx compte
  comme un échec) ; une ligne plus ancienne sur un autre hôte n'est jamais contactée. Sans cela, un compte faisait
  appeler par le web (conteneur le plus privilégié du réseau interne) une adresse interne de son choix, avec le
  statut en retour.

## 9. Notifications et push

Une notification par destinataire (`createNotification(input, { spaceId?, userIds })`) : destinataires d'un événement
de serveur = membres de l'espace du serveur (administrateurs si non attribué) ; références gardées seulement si elles
appartiennent à l'espace. Chaque lecteur prend le destinataire : un compte ne voit, ne compte, ne lit ni n'ouvre les
notifications d'un autre. `sendPush(payload, { userIds })` obligatoire ; l'abonnement est supprimé à la déconnexion
(endpoint envoyé par le formulaire), à la révocation d'un accès, à la désactivation et au retrait de l'appareil, et
aussi quand l'accès expire par la politique (inactivité ou durée maximale : `enforceSessionPolicy` les supprime avant
l'accès). Un abonnement ne vit que le temps de l'accès web qui l'a créé (`auth_session_id`) : `sendPush` ne livre
jamais à une ligne dont l'accès n'existe plus, appartient à un autre compte, a dépassé `expires_at` ou la politique
d'accès, et la supprime ; les lectures du compte (`listPushDevices`, `isEndpointSubscribed`) suppriment de même ses
propres lignes fermées (M08 repropose « Activer »), et `isEndpointSharedWithOtherAccount` ignore, sans rien écrire, les
lignes fermées d'un autre compte. Le service worker renouvelle par l'ancien endpoint (`POST
/api/push/subscription/renew`, réponse 204 quoi qu'il arrive) : seulement les lignes du compte dont il porte le cookie
de session (`requireUserForApi`), jamais celles d'un autre compte du même profil de navigateur ; sans session, rien
n'est écrit ni journalisé ; `security.push_renewed` nomme ce compte (auteur et sujet). Un clic sur une notification
d'un autre compte mène à `/parametres/notification` : « Cette notification concerne un autre compte Nuera Dev :
connectez-vous avec ce compte pour l'ouvrir. » ; « Se déconnecter » y ramène, après la connexion, à cette même garde
(`/connexion?suivant=…`, chemin interne revalidé à chaque étape).

## 10. Exploitation

- **Téléphone perdu ou 2FA perdue** : se connecter ailleurs avec un code de secours, puis fermer les accès du téléphone
  (Paramètres › Accès ouverts) et régénérer les codes. Sans code de secours : un administrateur crée un **lien de
  récupération** (Administration › Comptes, mot de passe de l'administrateur redemandé) : accès, appareils de confiance
  et 2FA du compte fermés (clés d'accès gardées, sauf option « appareil perdu »), lien `/recuperation/<jeton>` affiché
  une fois, 24 h, usage unique (nouveau mot de passe + TOTP), la personne est notifiée, journal avec
  `subject_user_id`. Un lien non utilisé est considéré comme servi dès que le compte a réenrôlé une 2FA.
- **Mot de passe oublié** : même lien de récupération.
- **Propriétaire, ou aucun administrateur disponible** (secours) : `pnpm --filter @nuera/db cli recovery-link --email …
  [--remove-passkeys]` ; en production `docker compose run --rm -e APP_URL=<url> migrate node_modules/.bin/tsx
  src/cli/recovery-link.ts --email …` dans le dossier de la ressource Coolify (`docs/DEPLOY.md` §12.5). Journal :
  `admin.recovery_link_cli`. Tant qu'aucun propriétaire n'a de 2FA, `/configuration` avec `SETUP_TOKEN` reste aussi
  une voie de reprise.
- **Compte compromis** : Administration › Comptes → désactiver (accès, appareils, push supprimés, serveur suspendu ;
  cocher l'arrêt des sessions), puis récupération ou suppression.
- **Jeton d'un serveur exposé** : « Renouveler le jeton » (serveur supplémentaire) puis mettre le nouveau jeton dans sa
  ressource et la redéployer ; serveur par défaut : changer `RUNNER_TOKEN` du web, du runner et de `migrate` ensemble.
- **Réinitialisation complète** (développement) : `node scripts/create-db.mjs <base> --reset` puis `pnpm db:migrate`,
  et supprimer les marqueurs `.nuera-environment`.
- **Healthcheck** `/api/health` : sans authentification ni détail (`{ status, db, version }`), toujours 200 pour que le
  proxy continue de servir les états d'erreur de l'application.

## 11. Risques résiduels (acceptés, à surveiller)

| Risque | Détail | Atténuation / suite |
|---|---|---|
| Serveur par défaut non restreint | Tant que l'administrateur n'a pas fait `docs/DEPLOY.md` §14, le runner « VPS-3 » (et donc une session Claude du propriétaire) a le DSN complet : tous les espaces sont lisibles depuis ce serveur. | Avertissement permanent dans l'administration ; restreindre avant d'inviter quiconque. |
| DSN complet dans la configuration Docker du serveur par défaut | Même restreint, la ressource principale donne `DATABASE_URL` au conteneur runner : il reste dans l'environnement des processus lancés par Docker (healthcheck toutes les 30 s, `docker exec`), lisible un instant via `/proc` sous le même utilisateur. | Ne pas laisser de `docker exec` ouvert ; les serveurs supplémentaires ne reçoivent jamais ce DSN. |
| Un seul processus web | Bus d'événements par compte, autorisations d'enrôlement, limites de débit et caches de portée sont en mémoire : corrects pour un conteneur web, pas pour plusieurs répliques (il faudrait LISTEN/NOTIFY et la base). Chaque réplique aurait aussi sa propre horloge de vérifications (le verrou consultatif évite les doublons). | Garder `web` à une réplique. |
| Rôles restreints | Plafond de connexions et délais (`statement_timeout` 2 min, `idle_in_transaction_session_timeout` 1 min) ne sont posés qu'à la création du rôle et au renouvellement de son accès : un rôle plus ancien ne les a pas. Dans ces délais, un runner peut encore garder des verrous de tables (une migration attend alors 10 s puis échoue) et il peut consommer du disque. La révocation des verrous consultatifs n'a lieu qu'avec un `migrate` superutilisateur (sinon `WARNING`, verrous ouverts à tous) et ne survit pas à une restauration `--no-privileges`. Fermer les connexions d'un rôle exige un superutilisateur ou `pg_signal_backend` (sinon comptées, laissées ouvertes). Le mot de passe d'un rôle est écrit dans `CREATE/ALTER ROLE` : avec `log_statement=ddl\|all`, PostgreSQL le journalise. Deux restrictions simultanées du même serveur peuvent créer un rôle jamais enregistré (sans droit utile). Le chemin sans superutilisateur de `0005` n'est pas testé automatiquement. | Superutilisateur pour `migrate` et le web ; contrôles de `docs/DEPLOY.md` §12.6 ; laisser `log_statement` à `none` ; suite : vérificateur SCRAM précalculé. |
| Contrôle « restreint » des serveurs supplémentaires | Le runner nomme ses connexions `nuera-runner` et `nuera-runner-lease`, sans l'id de son serveur : la vérification par `pg_stat_activity` ne peut rattacher une connexion qu'au serveur par défaut. Pour les autres, le web croise le battement et `pg_roles` (le rôle enregistré est bien restreint) ; un tel serveur reçoit de toute façon son seul DSN restreint. | Suite : `application_name` `nuera-runner:<id>` / `nuera-runner-lease:<id>` dans le runner (le web les vérifie déjà). |
| Jetons des serveurs connus des administrateurs | Un administrateur voit le jeton d'un serveur à l'enregistrement et à chaque « Renouveler le jeton », y compris pour le serveur d'un autre compte : son détenteur peut appeler `/api/internal/*` comme ce serveur (identifiants Git et en-têtes MCP de ses sessions). Une nouvelle adresse reçoit son nouveau jeton dès le premier appel, avant que le runner ait prouvé le détenir (pas d'état « à vérifier »). | Limite de confiance des administrateurs (MULTICOMPTE §1, invariant 5) : le compte est prévenu et nommé dans le journal à chaque renouvellement et changement d'adresse ; l'adresse d'un serveur d'un autre compte est réservée au propriétaire de l'instance avec son mot de passe. Suites : réserver aussi le renouvellement du jeton d'un autre compte au propriétaire ; colonne `token_unverified_at` (nouvelle migration) levée au premier rappel fait avec le nouveau jeton. |
| Jeton courant illisible | Si `token_encrypted` ne se déchiffre plus mais `next_token_encrypted` si, le web emploie le nouveau jeton directement et un appel réussi ne le promeut pas : seul « Vérifier » le promeut. | Cas limite (clé de chiffrement perdue en partie). |
| Plages privées | La garde SSRF refuse boucle locale, lien-local et hôtes connus (runners, base, web), pas les plages RFC 1918 : un autre service du réseau interne de Coolify reste joignable par un serveur MCP personnalisé ou une URL Coolify. `GITHUB_API_URL` et `GITHUB_WEB_URL` (variables d'exploitation) ne passent pas par la garde. | Réseau Docker dédié ; `NUERA_PRIVATE_HOSTS` vide par défaut. |
| Push et profils partagés | Deux comptes d'un même profil de navigateur lisent tous deux ce que tient le service worker : aucun secret propre à une ligne ne prouverait l'appartenance, d'où un renouvellement limité au compte du cookie. Les abonnements créés avant la liaison à l'accès (`auth_session_id` nul) continuent de recevoir jusqu'à leur retrait ou leur purge par le service push. Un renouvellement garde l'accès qui a créé la ligne (il ne la relie pas à l'accès qui renouvelle). Un abonnement s'arrête avec son accès (12 h d'inactivité par défaut, 30 jours au plus) : la personne réactive les notifications après une nouvelle connexion. | Un compte par profil de navigateur (mention sur `/connexion`) ; suite possible : migration de nettoyage des lignes sans accès lié. |
| Flux global sans revérification de l'accès | Un flux `/api/stream/events` ouvert ne revérifie jamais la session : un accès révoqué ou un compte désactivé garde son propre canal web jusqu'à la fin de la connexion. Pendant une panne du runner, le flux reste ouvert au plus 5 min (`DEGRADED_STREAM_MAX_MS`) et se termine si le serveur devient suspendu ou retiré ; le navigateur se reconnecte alors en repassant par l'authentification. | Seuls les événements du compte lui-même ; suite : événement de révocation sur le bus du compte qui ferme les flux de cet accès. |
| Cache du contexte | Le contexte de requête est gardé 5 s : un serveur tout juste suspendu peut encore ouvrir un terminal `mcp-login` pendant ce délai. `claude-login` et `claude-status` restent permis sur un serveur suspendu (MULTICOMPTE §14, C1-7), et le runner ne refuse que les terminaux de shell. | Gravité basse : le serveur suspendu reste celui de la personne. |
| Anciens chiffrés | Les valeurs à l'ancien format (sans liaison à la ligne) peuvent encore être déplacées d'une ligne à l'autre jusqu'à leur rechiffrement (variables de projet et MCP : à la réécriture). | Passe de rechiffrement ; ré-enregistrer les variables sensibles. |
| Serveur retiré en service | Ses sessions tmux continuent mais ne s'arrêtent plus par Nuera (runner en attente, RLS) ; des sessions encore rattachées à l'ancien serveur d'un espace sont listées « non vérifié ». | Désactiver le compte et arrêter ses sessions **avant** de retirer ou supprimer. |
| tmux sur un hôte partagé | Chaque serveur a son socket et un runner ne rattache ni n'adopte une session tmux dont `NUERA_SESSION_ID` n'est pas l'id de la ligne. Un même `NUERA_TMUX_SOCKET` donné à la main à deux runners d'une machine les remet sur un serveur tmux commun (sessions protégées par cette vérification, mais visibles l'une de l'autre). Deux runners sous le même utilisateur Linux partagent de toute façon le système de fichiers. | En production chaque serveur a son conteneur ; ne jamais réutiliser une valeur de `NUERA_TMUX_SOCKET`. |
| Diffusion du runner | Le runner republie `notification.created` sur son flux global ; le navigateur ne lit que le canal web du compte (seq 0) et l'ignore. Les destinataires sont de toute façon les membres de l'espace du serveur. | Suite : retirer cette diffusion (les suites `sessions.test.ts` et `http.test.ts` l'observent). |
| Terminaux sans propriétaire | Un terminal ouvert par un runner plus ancien (sans `ownerUserId`) sur le serveur de l'espace est accepté : repose sur « un serveur = une personne ». | — |
| Dédoublonnage des notifications | L'unicité `(user_id, dedup_key)` ignore l'espace : deux événements de même clé venant de deux portées se fusionnent (rare : un serveur non attribué ne fait tourner aucune session). | Les alertes d'instance nomment le serveur dans leur clé. |
| Tests | La suite tmux (adoption entre serveurs et refus d'une session tmux lancée pour une autre ligne compris) ne tourne que sous Linux ; le service worker et la garde multi-onglets ne sont testés que comme logique pure ; aucun essai contre les vrais GitHub, Coolify, Claude. | À exécuter sur le serveur réel avant la mise en production (`docs/DEPLOY.md` §11). |
