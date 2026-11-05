# Nuera Dev — Sécurité

> Référence de sécurité de l’application web (`apps/web`) et de ses frontières avec le runner.
> Complète `docs/ARCHITECTURE.md` §9. Toute nouvelle route, action serveur ou intégration doit
> respecter les règles ci-dessous.

## 1. Modèle de menace (résumé)

| Actif | Menaces principales | Parades |
|---|---|---|
| Accès à Nuera Dev (un seul propriétaire) | vol de mot de passe, hameçonnage, vol de cookie, force brute | mot de passe ≥ 12 caractères (scrypt), TOTP **obligatoire**, clés d’accès avec vérification de l’utilisateur, cookies `HttpOnly`/`Secure`/`SameSite=Lax`, expiration d’inactivité et absolue, limitation de débit, journal de sécurité |
| Configuration initiale | création d’un propriétaire par un tiers avant le vrai propriétaire | `/configuration` exige `SETUP_TOKEN` (≥ 16 caractères, comparaison à temps constant, 5 essais / 15 min / IP), n’existe plus dès que le propriétaire a activé la 2FA ; index unique `user_single_owner_idx` : la table `user` n’accepte qu’une ligne |
| Sessions Claude Code, dépôts, terminaux (runner) | exécution de commandes par un tiers, fuite de jetons GitHub | le runner n’est jamais exposé, `Bearer RUNNER_TOKEN` (temps constant), chemins confinés, `execFile` sans shell, environnement nettoyé (§7) |
| Secrets applicatifs (GitHub App, Coolify, MCP, variables de projet) | lecture de la base, fuite vers le navigateur | AES-256-GCM avec identifiant de clé (§5), jamais renvoyés au client, affichage masqué |
| Mutations (formulaires, API JSON) | CSRF, requêtes inter-sites | vérification `Origin`/`Sec-Fetch-Site`/`Referer` contre `APP_URL` (§4), `SameSite=Lax` |
| Intégrité de l’historique | actions sensibles non tracées | `audit_log` append-only, résumé français, IP et agent utilisateur (§6) |

Hors périmètre : compromission de VPS-3 lui-même (root), du compte GitHub ou Claude du
propriétaire, de Coolify. Nuera Dev ne stocke **aucun** identifiant Claude (règle P2).

## 2. Authentification

Implémentation : Better Auth 1.7 (`apps/web/src/server/auth/auth.ts`) + plugins `twoFactor`,
`passkey` (`@better-auth/passkey`), `nextCookies` (dernier) et `nueraAuthPlugin`
(`nuera-plugin.ts`, règles propres à Nuera Dev).

- **Propriétaire unique.** Inscription publique fermée (`disableSignUp`, `/sign-up/email`
  désactivé). Le compte est créé par `/configuration` (jeton `SETUP_TOKEN`), dans une transaction ;
  un hook refuse tout second utilisateur et l’index unique `user_single_owner_idx` le garantit en base.
- **Mot de passe.** 12 à 128 caractères, lettres + chiffre ou symbole, ni nom ni e-mail, pas de mot
  de passe courant (`password-policy.ts`). Hachage scrypt (Better Auth). Pas de réinitialisation par
  e-mail : en cas d’oubli, procédure d’exploitation (§8).
- **Double authentification obligatoire.** TOTP (émetteur « Nuera Dev », 6 chiffres, 30 s) +
  8 codes de secours à usage unique (chiffrés par Better Auth). `/two-factor/disable` est bloqué
  (HTTP et serveur). Better Auth limite chaque défi à 5 essais et verrouille la 2FA 15 min après
  10 échecs consécutifs. Option « Approuver cet appareil pendant 30 jours » (cookie signé, révocable
  en base) — décochée par défaut.
- **Configuration inachevée.** Tant que le propriétaire n’a pas activé la 2FA, la connexion par mot
  de passe est refusée partout (`SETUP_INCOMPLETE`), sauf depuis `/configuration` avec le jeton
  (preuve à usage unique, en mémoire du processus). Les clés d’accès ne peuvent être ajoutées qu’une
  fois la 2FA active.
- **Clés d’accès.** WebAuthn, `rpID` = hôte d’`APP_URL`, origine = `APP_URL`, vérification de
  l’utilisateur **exigée** (une clé d’accès vaut deux facteurs). Ajout réservé aux sessions ouvertes
  depuis moins d’une heure (`freshAge`, code `SESSION_NOT_FRESH`).
- **Parcours.** `/connexion` (e-mail + mot de passe → `/connexion/deux-facteurs` : code TOTP ou code
  de secours) ; « Se connecter avec une clé d’accès » (et remplissage automatique) ;
  `/deconnexion` (formulaire POST, un GET ne déconnecte jamais).

## 3. Sessions web

- Cookies `nuera.*` (`__Secure-nuera.*` en production), `HttpOnly`, `SameSite=Lax`, `Secure` en
  production ; pas de cache de session dans un cookie : chaque requête relit la base.
- **Durée absolue** : `app_settings.webSessionMaxDays` (30 j par défaut, 90 max), écrite à la
  création de la session, jamais prolongée (`disableSessionRefresh`).
- **Inactivité** : `app_settings.webSessionIdleHours` (12 h par défaut) ; la dernière activité
  (`session.updated_at`) est rafraîchie au plus toutes les 5 min. Vérifiée par `nueraAuthPlugin`
  avant **chaque** appel Better Auth (HTTP ou `auth.api`) : une session expirée est supprimée et
  l’événement journalisé.
- `requireUser()` (pages, actions) redirige vers `/connexion` (ou l’étape 2FA) et vers
  `/configuration/double-facteur` tant que la 2FA n’est pas active ; `requireUserForApi()` lève
  `UNAUTHORIZED` / `FORBIDDEN`. `src/proxy.ts` ne fait qu’un contrôle **optimiste** de présence du
  cookie (redirection, 401 JSON pour `/api/*`) : il ne remplace jamais ces vérifications.
- Paramètres · Accès ouverts : liste, « Cet appareil », révocation unitaire ou des autres accès
  (`src/server/auth/account.ts`).

## 4. Requêtes, CSRF, limitation de débit

- Toute route `apiRoute()` (`src/server/http.ts`) : session + 2FA (sauf `auth: false`), vérification
  d’origine sur toute méthode non sûre, validation Zod (params, query, corps JSON ≤ 1 Mio), erreurs
  `{ error: { code, message, detail?, raw?, untouched? } }` sans pile d’appels.
- **Origine** (`security/origin.ts`) : `Origin` doit valoir l’origine d’`APP_URL` (hors production,
  l’origine dérivée de `Host` est aussi admise) ; sans `Origin`, `Sec-Fetch-Site: same-origin` ou un
  `Referer` de la même origine ; sinon refus. Les actions serveur de l’authentification font le même
  contrôle, en plus de celui de Next.js.
- **Callbacks du runner** `/api/internal/*` : `internalRoute()` — `Authorization: Bearer RUNNER_TOKEN`
  (comparaison à temps constant sur empreintes SHA-256, jeton ≥ 16 caractères), pas de session.
- **Limitation de débit** : Better Auth pour `/api/auth/*` (5 connexions / min, règles 2FA du
  plugin) ; limiteur mémoire à fenêtre glissante (`security/rate-limit.ts`) pour les actions serveur
  (jeton de configuration 5 / 15 min, mot de passe 10 / 10 min, 2FA 10 / 10 min, re-saisie du mot de
  passe 10 / 15 min) et pour les routes `apiRoute()` :
  - une fenêtre par **méthode et motif de route** (`api:POST:/api/worktrees/:id/push`, identifiants
    UUID/numériques remplacés par `:id`, `defaultRateLimitScope()`), par IP + utilisateur : un nouvel
    identifiant n’ouvre pas une nouvelle fenêtre et la lecture d’une ressource (GET) ne consomme pas
    le budget de ses mutations ;
  - toute mutation (POST/PUT/PATCH/DELETE) sans règle propre reçoit `DEFAULT_MUTATION_RATE_LIMIT`
    (120 / min) ; seule la frappe d’un terminal (`/api/terminals/[id]/input`) s’en exclut
    (`rateLimit: false`) ;
  - règles plus strictes déclarées route par route : clone / ajout de projet 20 / 10 min, session
    créée 20 / 10 min, push et PR 30 / 10 min, commit 60 / 10 min, terminaux (par type, dans
    `server/terminals`), test MCP 30 / min, connexion MCP 10 / 10 min, jeton Coolify 10 / 10 min,
    vérification GitHub 20 / min…

  `NUERA_RATE_LIMIT_FACTOR` n’agit **jamais** en production (seulement pour les tests locaux).
- **Adresse IP** : en-tête fixé par le proxy inverse, `TRUSTED_IP_HEADER` (défaut `x-real-ip`, puis
  la dernière entrée de `x-forwarded-for`). Configurer Traefik/Coolify pour écraser `X-Real-IP`.
- **Lieu** : uniquement si un en-tête de confiance existe (`TRUSTED_CITY_HEADER`, ex. `cf-ipcity`) ;
  sinon l’IP est affichée. Nuera Dev n’invente jamais de lieu.
- En-têtes HTTP (`next.config.ts`, toutes les réponses) : CSP (`default-src 'self'`, `frame-ancestors
  'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` + github.com pour le flux
  manifest ; `'unsafe-eval'` seulement hors production), `X-Frame-Options: DENY`, HSTS 2 ans en
  production, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`,
  `X-Content-Type-Options: nosniff`, `Cross-Origin-Opener-Policy: same-origin`, pas de `X-Powered-By`.
- Cookies : `HttpOnly`, `SameSite=Lax`, `Path=/`, sans `Domain` ; en production `Secure` et préfixe
  `__Secure-`. Le préfixe `__Host-` n’est pas possible : Better Auth 1.7 préfixe lui-même chaque nom
  de cookie par `__Secure-` (`createCookieGetter`), noms que relit le proxy
  (`getSessionCookie`) ; l’absence de `Domain` donne déjà la même portée (hôte seul).

## 5. Secrets et rotation de `APP_ENCRYPTION_KEY`

- `encryptSecret` / `decryptSecret` / `encryptJson` / `decryptJson` (`security/crypto.ts`) :
  AES-256-GCM, IV aléatoire de 96 bits, étiquette de 128 bits, identifiant de clé authentifié (AAD).
  Format : `<id>:<iv>.<tag>.<données>` (base64url), par ex. `v1:…`.
- Variables : `APP_ENCRYPTION_KEY` (32 octets en base64, `pnpm setup:env`), `APP_ENCRYPTION_KEY_ID`
  (défaut `v1`), `APP_ENCRYPTION_PREVIOUS_KEYS` (`v0:<base64>,…`, déchiffrement seulement).
- **Rotation** :
  1. générer une nouvelle clé (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`) ;
  2. déployer avec `APP_ENCRYPTION_KEY=<nouvelle>`, `APP_ENCRYPTION_KEY_ID=v2`,
     `APP_ENCRYPTION_PREVIOUS_KEYS=v1:<ancienne>` ;
  3. rechiffrer les valeurs stockées (`integrations.secrets_encrypted`, `mcp_servers.secrets_encrypted`,
     `project_env_vars.value_encrypted`) avec `reencryptSecret()` — ou les ré-enregistrer depuis l’UI ;
     `needsReencryption()` repère celles qui restent ;
  4. retirer l’ancienne clé de `APP_ENCRYPTION_PREVIOUS_KEYS`.
- `BETTER_AUTH_SECRET` (≥ 32 caractères) signe les cookies et chiffre le secret TOTP et les codes de
  secours : le changer **invalide toutes les sessions et la 2FA** (réenrôlement nécessaire). Better
  Auth accepte `BETTER_AUTH_SECRETS` (versions multiples) si une rotation sans coupure devient utile.
- `SETUP_TOKEN` : à retirer de l’environnement une fois la configuration terminée (la page renvoie
  404 de toute façon). `RUNNER_TOKEN` : changer des deux côtés en même temps.
- Jamais de secret dans les journaux, l’audit (`sanitizeMetadata` retire les clés sensibles), les
  réponses d’erreur, les URL ou l’argv.

## 6. Journal de sécurité (`audit_log`)

`audit({ action, summary, targetType?, targetId?, metadata?, actorUserId?, actorKind? })` —
`security/audit.ts`. Résumé français court, affiché après la date dans Paramètres
(« hier 18:04 · connexion depuis un nouvel appareil (Lyon) »). `listAudit()` / `listSecurityJournal()`.

| Action | Résumé (exemples) | Source |
|---|---|---|
| `auth.owner_created` | compte propriétaire créé (…) | configuration |
| `auth.setup_token_rejected` | configuration initiale : jeton refusé | configuration |
| `auth.setup_codes_acknowledged`, `auth.setup_completed` | codes de secours conservés · configuration initiale terminée | configuration |
| `auth.sign_in_new_device`, `auth.sign_in` | connexion depuis un nouvel appareil (Lyon) · connexion par clé d’accès (203.0.113.7) | hook Better Auth |
| `auth.sign_in_failed` | échec de connexion : e-mail ou mot de passe refusé | hook |
| `auth.2fa_failed` | code de double authentification refusé · code de secours refusé | hook |
| `auth.2fa_enabled` | double authentification activée (application d’authentification) | hook |
| `auth.backup_code_used`, `auth.backup_codes_regenerated` | code de secours utilisé · codes de secours régénérés | hook |
| `auth.passkey_added`, `auth.passkey_removed` | clé d’accès ajoutée (Mac · Safari) | hook / `account.ts` |
| `auth.password_changed` | mot de passe modifié · autres accès fermés | hook |
| `auth.session_revoked`, `auth.other_sessions_revoked` | accès révoqué : iPhone · Safari · 2 autres accès fermés | `account.ts` |
| `auth.session_expired` | accès expiré après 12 h d’inactivité (PC Windows · Chrome) | `nueraAuthPlugin` |
| `auth.sign_out` | déconnexion (Mac · Safari) | hook |
| `settings.updated` | réglages modifiés : sessions parallèles, thème | `settings.ts` |
| `session.create`, `session.resume`, `session.stop`, `session.archive`, `session.rename` | session lancée / reprise / arrêtée / archivée | `server/sessions/service.ts` |
| `permission.decision` | autorisation accordée / refusée (outil, cible, « toujours ») | `server/workspace/permissions.ts` |
| `git.commit`, `git.push`, `github.pull_request` | commit a3f9c12 « … » · push de feature/x vers origin/feature/x · PR #12 | `server/workspace/git.ts` |
| `project.created`, `project.archived`, `project.restored`, `project.discarded`, `project.renamed`, `project.options_updated`, `project.commands_updated`, `project.clone_retried`, `project.synced` | projets | `server/projects/*` |
| `project.branch_created`, `project.checkout`, `project.worktree_removed`, `maintenance.worktree_removed` | branches et suppression de worktree (« branche conservée / supprimée ») | `server/projects/branches.ts`, `server/preferences/worktrees.ts` |
| `project.claude_md_written` | CLAUDE.md modifié (N lignes), commit … (jamais le contenu) | `server/projects/claude-md.ts` |
| `project.env_created`, `project.env_updated`, `project.env_deleted` | variable ajoutée / modifiée / supprimée (jamais la valeur) | `server/projects/env.ts` |
| `project.run_started`, `project.run_stopped` | commande du projet lancée / arrêtée | `server/projects/runs.ts` |
| `terminal.open` | terminal ouvert (worktree, `claude auth login`, `/status`) | `server/terminals/index.ts` |
| `integration.github.*`, `integration.coolify.*`, `integration.mcp.*` (`created`, `updated`, `credentials_updated`, `deleted`, `project_enabled`, `project_disabled`, `disabled_everywhere`, `login_started`, `checked`) | intégrations, activation MCP par projet, terminal de connexion MCP | `server/github`, `server/coolify`, `server/mcp` |
| `security.push_subscribed`, `security.push_unsubscribed` | notifications push de cet appareil | `/api/push/subscription` |

Non journalisés (pas d’effet sensible) : indexation (stage/unstage), interruption d’une session,
envoi d’une instruction, frappe et redimensionnement d’un terminal, lecture des notifications, thème.
Les décisions d’autorisation prises **dans le terminal brut** de la session (et non par l’interface)
ne passent pas par le web et ne sont pas journalisées (le runner n’écrit pas l’audit).

Les autres lots ajoutent leurs actions sous la forme `domaine.verbe` (préfixes affichés dans le
journal : `auth.`, `settings.`, `security.`, `permission.`, `integration.`).

## 7. Runner — rappels d’isolation

- **Exposition** : `RUNNER_HOST` vaut `127.0.0.1` par défaut ; l’image Docker écoute sur `0.0.0.0`
  **dans** le conteneur, sans port publié (`docker-compose.yml` : réseau `nuera-internal`, aucun
  `ports:`), sans domaine dans Coolify. Le serveur des hooks de Claude écoute toujours sur
  `127.0.0.1` et exige le jeton propre à chaque session (comparaison à temps constant).
- **Jeton** : hook Fastify `onRequest` sur **toutes** les routes (y compris `/v1/health` et les 404) ;
  `Bearer RUNNER_TOKEN` comparé à temps constant sur empreintes SHA-256 (`http/route.ts`
  `bearerMatches`). Côté web, `/api/internal/*` exige le même jeton (`internalRoute`).
- **Contrat** : chaque route du runner est déclarée dans `@nuera/shared/runner` (`RUNNER_ROUTES`) et
  ses params / query / corps sont validés par Zod (`defineRoute`), corps ≤ 2 Mio.
- **Chemins et références** : chemins relatifs via `RelativePathSchema` puis `resolveInWorktree`
  (`realpath`, confinement au worktree, lui-même confiné à `NUERA_PROJECTS_ROOT`) ; destinations de
  clone via `resolveDestination` ; branches via `BranchNameSchema` (`isValidBranchName`) ; toute
  référence libre (`from`, `base`, `ref`) passe par `refExists()`, qui refuse un nom commençant par
  `-` (jamais lu comme option, p. ex. `--output=…`) avant tout usage dans une commande Git.

- Seul composant qui touche aux dépôts, à Git, aux PTY et aux processus ; jamais exposé (réseau
  interne / 127.0.0.1), utilisateur non-root, `Bearer RUNNER_TOKEN` sur toutes ses routes.
- `execFile` avec tableau d’arguments (jamais de shell), chemins `realpath` confinés à
  `NUERA_PROJECTS_ROOT` / `NUERA_DATA_DIR`, `GIT_TERMINAL_PROMPT=0`, hooks Git désactivés.
- Jetons GitHub d’installation réduits par opération et par dépôt, injectés par processus
  (`GIT_CONFIG_*` → `http.https://github.com/.extraheader`), jamais dans une URL, l’argv ou
  `.git/config`.
- Environnement des processus nettoyé : `ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`, `RUNNER_TOKEN`,
  `DATABASE_URL`, `BETTER_AUTH_SECRET`, `APP_ENCRYPTION_KEY*`, `SETUP_TOKEN`…
- Claude Code : binaire officiel en session interactive ; jamais de lecture de
  `~/.claude/.credentials.json` ; `bypassPermissions` bloqué par défaut ; décisions d’autorisation
  journalisées.

## 8. Exploitation

- **Téléphone perdu** : se connecter depuis un autre appareil avec un code de secours, puis fermer
  les accès du téléphone (Paramètres · Accès ouverts). Sa clé TOTP reste dans l’application du
  téléphone et la double authentification ne se retire pas depuis l’interface : la changer (et, sans
  code de secours, retrouver l’accès) demande l’accès au serveur — sauvegarder la base, puis, dans
  une transaction, supprimer la ligne `two_factor`, remettre `user.two_factor_enabled = false`
  **et supprimer toutes les lignes `session`** (sinon un accès resté ouvert sur le téléphone perdu
  pourrait réenrôler une clé avec le seul mot de passe). La connexion par mot de passe reste alors
  refusée et `/configuration` propose « Reprendre la configuration » (jeton `SETUP_TOKEN` exigé, à
  remettre dans l’environnement le temps de la reprise) : nouvelle clé TOTP, nouveaux codes de
  secours affichés, clé d’accès proposée (les étapes sont rattachées à l’enrôlement courant).
- **Mot de passe oublié** : pas de réinitialisation par e-mail. Accès au serveur requis : calculer
  un hachage (`hashPassword` de `better-auth/crypto`, depuis `apps/web`), l’écrire dans
  `account.password` (ligne `provider_id = 'credential'`), puis fermer les accès
  (`delete from session`).
- **Réinitialisation complète** (aucun projet à garder) : `node scripts/create-db.mjs <base> --reset`
  puis `pnpm db:migrate` (développement uniquement).
- **Healthcheck** `/api/health` : sans authentification ni détail (`{ status, db, version }`),
  toujours 200 pour que le proxy continue de servir les états d’erreur de l’application.
