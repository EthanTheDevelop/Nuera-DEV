# Intégrations — guide de mise en service et référence

> Pour chaque compte de Nuera Dev : connecter une ou plusieurs sources GitHub, installer les applications, préparer
> le jeton Coolify, connecter Figma, activer les notifications sur le téléphone. Pour les autres lots : API HTTP,
> contrats runner → web et API d'abonnement Web Push. Les intégrations sont **par espace** (`docs/MULTICOMPTE.md`
> §7) : ce qu'un compte connecte ne sert jamais à un autre espace.
> Recherche et justification des choix : `docs/research/integrations.md` (référencée « §x » ci-dessous).

Code : `apps/web/src/server/{github,coolify,mcp,integrations,notifications,push,security/ssrf.ts}`, routes
`apps/web/src/app/api/{integrations,internal,push,notifications}`, PWA `apps/web/public/sw.js`,
`apps/web/src/app/{manifest.ts,icon.tsx,apple-icon.tsx}`, planificateur `apps/web/src/instrumentation.ts`.

---

## 1. Principes

- **Par espace** : sources GitHub (`github_sources`, 10 au plus), Coolify (une ligne `integrations` par espace),
  registre MCP (`mcp_servers`, préréglages créés avec l'espace). Toute route lit l'espace du contexte de requête ;
  une source, un serveur MCP ou un projet d'un autre espace répond comme un inconnu (404, même message).
- **Aucun jeton GitHub saisi à la main** : chaque application GitHub est créée par le *flux manifest* ; ses
  identifiants (clé privée, secret client, secret webhook) sont **chiffrés** (AES-256-GCM, liés à la source,
  `APP_ENCRYPTION_KEY`) dans `github_sources.secrets_encrypted`.
- **Jetons d'installation réduits** : chaque opération obtient un jeton d'une heure limité **au dépôt concerné et aux
  droits de l'opération** (lecture pour un clone, écriture pour un push, `pull_requests: write` pour une PR…), gardé en
  mémoire uniquement (cache `appId|installationId|dépôts|droits`) et réutilisé jusqu'à 5 min avant son expiration.
- **Aucun secret renvoyé au navigateur** : empreinte (« jeton n°67 »), noms d'en-têtes, dates — jamais une valeur.
  Les messages des fournisseurs sont caviardés.
- **Diagnostics non mutants** : GET REST, `initialize` + `tools/list` MCP, `claude mcp get`. Jamais un appel d'outil,
  jamais un déploiement.
- **Production hors de portée** : client Coolify en lecture seule (GET), outils Coolify de déploiement refusés à
  Claude (`permissions.deny`), jeton limité aux environnements de développement.
- **Un accès, un projet** : chaque session Claude reçoit un `--mcp-config` qui ne contient que les serveurs activés pour
  **son** projet (`--strict-mcp-config`, connecteurs claude.ai désactivés).
- **Requêtes sortantes gardées** : toute adresse venue d'un compte (Coolify, serveurs MCP personnalisés, métadonnées
  OAuth) passe par la garde SSRF (§7).

---

## 2. GitHub — sources

### 2.1 Ajouter une source (un clic)

1. Vérifier `APP_URL` (ex. `https://dev.nuera.studio`) : les adresses de retour en dépendent. **Changer `APP_URL`
   oblige à mettre à jour les adresses de chaque application GitHub** : le fixer avant d'inviter d'autres comptes.
2. Intégrations → **Connecter GitHub** (première source) ou **Ajouter une source GitHub** (suivantes) :
   `POST /api/integrations/github/manifest` ou `POST /api/integrations/github/sources` (champs facultatifs
   `organization` — ex. `nuera-studio` — et `public`). Nuera Dev répond par une page qui transmet le *manifest* à
   github.com, avec un `state` signé valable **une heure**, chiffré et lié au compte, à son espace et à la source
   réservée (`{ purpose, userId, spaceId, sourceId }`), et un cookie HttpOnly **propre au compte**
   (`nuera_github_state_<8 hex>`, chemin `/api/integrations/github`). Espace déjà à 10 sources → retour
   `?github=source_limit`.
3. Sur GitHub, confirmer la création de « Nuera Dev <4 hex> · <hôte> » (nom unique sur GitHub, 34 caractères au plus :
   l'hôte est coupé, jamais le suffixe).
4. GitHub revient sur `/api/integrations/github/callback` : le code est échangé (`POST /app-manifests/{code}/conversions`),
   les identifiants sont chiffrés dans la source, puis GitHub affiche la page d'installation.

Manifest envoyé (construit depuis `APP_URL`) :

| Champ | Valeur |
|---|---|
| `name` | `Nuera Dev <4 hex> · <hôte d'APP_URL>` |
| `url` | `APP_URL` |
| `redirect_url`, `callback_urls` | `APP_URL/api/integrations/github/callback` |
| `setup_url` (+ `setup_on_update`) | `APP_URL/api/integrations/github/setup` (le même pour toutes les applications) |
| `hook_attributes` | `APP_URL/api/integrations/github/webhook`, **inactif** (Nuera Dev interroge GitHub) |
| `public` | **`false` par défaut** (application privée) |
| `default_permissions` | `contents: write`, `pull_requests: write`, `metadata: read`, `checks: read`, `statuses: read`, `issues: read` |

**Privée ou publique** : une application privée ne s'installe que sur le compte qui la possède. Pour l'installer à la
fois sur une organisation et sur un compte personnel, envoyer `public=true` : un tiers qui l'installerait ne donnerait
accès qu'à **ses** dépôts, et Nuera Dev ignore toute installation d'un compte qu'il n'a pas lui-même installé (§2.2).
Autre voie, plus stricte : une source privée par compte GitHub.

### 2.2 Installer sur les comptes

- Sur la page d'installation, choisir le compte puis **Only select repositories** et cocher les dépôts.
- GitHub revient sur `/api/integrations/github/setup?installation_id=…&setup_action=install&state=…`. La source est
  celle de l'état (signé pour ce compte et son espace), sinon la source de l'espace dont le JWT voit cette
  installation ; l'installation est **vérifiée avec le JWT de cette application** (`GET /app/installations/{id}`). Un
  nouveau compte GitHub n'entre dans la liste d'autorisation qu'avec un état valide émis pour cette source.
- Pour un compte GitHub de plus : `GET /api/integrations/github/install?source=<id>` (« Installer sur GitHub » /
  « Réautoriser sur GitHub ») ; sans `source`, la seule source de l'espace, ou `?github=choose_source` s'il y en a
  plusieurs.
- « Gérer l'accès » : `https://github.com/apps/<slug>/installations/new` ; chaque compte a son `manageUrl`.

Codes de retour transmis à la page Intégrations (`/integrations?github=<code>`, `server/github/redirects.ts`) :

| Code | Sens |
|---|---|
| `app_created` | application créée, à installer |
| `installed` / `updated` | installation enregistrée (vérification lancée aussitôt) — `&compte=<login>` |
| `requested` | un membre non administrateur de l'organisation a demandé l'installation |
| `state_invalid` / `state_expired` | retour GitHub non lié à une demande de ce compte dans ce navigateur / plus d'une heure |
| `wrong_account` | le retour a été lancé par **un autre compte** Nuera Dev de ce navigateur (cookie d'état d'un autre compte présent, aucun du sien) |
| `already_connected` | cette application est déjà enregistrée |
| `conversion_failed` | GitHub a refusé le code (expiré ou déjà utilisé) |
| `installation_unknown` | installation non reconnue (compte non autorisé, sans `state`) |
| `installation_failed` / `not_connected` | erreur de vérification / aucune source enregistrée |
| `source_limit` | l'espace a déjà 10 sources (« Votre espace a déjà 10 sources GitHub : déconnectez-en une d'abord. ») |
| `choose_source` | « Installer sur GitHub » sans source alors que l'espace en a plusieurs |

Un état v1 (antérieur aux sources multiples) reste accepté pendant son heure (espace = celui de l'appelant) ; l'ancien
cookie partagé `nuera_github_state` est lu en dernier recours et expire seul.

### 2.3 Plusieurs sources

- **Source par défaut** : la plus ancienne (`created_at`, `id`) ; elle passe en premier dans les listes, la résolution
  d'un dépôt et le rattachement paresseux d'un projet ancien (`projects.github_source_id` nul).
- **Libellé** : unique dans l'espace (« atelier-test », puis « atelier-test 2 » pour une seconde application du même
  propriétaire) ; `PATCH /api/integrations/github/sources/[id]` `{ label }` (1–40 caractères, journalisé) refuse un
  libellé déjà pris (409 « Une autre source GitHub de votre espace porte déjà ce nom. »). Le renommage n'a pas encore de
  contrôle dans l'interface.
- **Ajout de projet** : quand un dépôt est accessible par plusieurs sources, D03 propose un sélecteur « Source GitHub » ;
  le projet garde sa source (`projects.github_source_id`, FK composite avec l'espace).
- **Tuiles** : une source = la tuile Figma ; plusieurs = une tuile « GitHub · <libellé> » par source. Bandeaux : cible
  `github` avec une seule source, `github:<sourceId>` avec plusieurs. L'agrégat (pire statut) alimente l'Accueil et
  `GET /api/integrations/github` (ses champs détaillés `app`, `installUrl`, `lastCheck`, `history` sont vides quand il
  y a plusieurs sources ; « Réautoriser » du tiroir MCP mène alors à `/integrations`).

### 2.4 Vérification et statuts

`POST /api/integrations/github/sources/[id]/check` (« Vérifier la connexion », au plus une fois par 10 s ; la route
historique `POST /api/integrations/github/check` vérifie l'espace) et le planificateur web (15 min) exécutent, par
source : JWT → `GET /app`, `GET /app/installations`, un jeton `metadata: read` par installation, comparaison des droits,
`GET /installation/repositories`, quota restant. Statuts (`github_sources.status`) :

| Statut | Quand | Affichage |
|---|---|---|
| `pending` | application créée, pas encore installée | « Application non installée » |
| `connected` | tout répond | « Connecté » |
| `expired` | clé révoquée, installation suspendue ou supprimée, droits à accepter | « Autorisation expirée » + action GitHub |
| `error` | GitHub injoignable **deux fois de suite** (hystérésis) | « Injoignable » |

Une source dont la configuration stockée est illisible répond 404 « Source GitHub introuvable. » à la vérification
(sa tuile reste déconnectable).

### 2.5 Repli documenté (jamais dans l'interface)

`GITHUB_FALLBACK_TOKEN` (PAT *fine-grained* : Contents RW, Pull requests RW, Metadata R, Commit statuses R, Issues R) ne
sert qu'à **l'espace du serveur par défaut** et seulement s'il n'a aucune source. Son expiration est lue dans
`GitHub-Authentication-Token-Expiration` (alerte 7 jours avant, clés `integration:github:fallback:<état>`). Il sert à
l'API et à Git (runner) uniquement, **jamais confié à Claude** : un PAT ne peut être ni limité au dépôt de la session ni
réduit à la lecture, donc le serveur MCP GitHub est écarté des sessions sans source (`skipped`, `403` sur
`/api/internal/mcp-headers`). Ses alertes ne se résolvent pas seules quand une première source est ajoutée (elles
restent jusqu'à leur lecture).

### 2.6 Déconnexion

`DELETE /api/integrations/github/sources/[id]` (« Déconnecter la source ») supprime les identifiants chiffrés
(journalisé) ; 409 tant qu'un projet non archivé de l'espace utilise la source (`error.projects` : leurs id et noms).
La vérification se fait dans la transaction qui supprime, la ligne de la source verrouillée (`SELECT … FOR UPDATE`) :
un projet créé en même temps attend ou échoue. `DELETE /api/integrations/github` (historique) ne vaut que pour la seule
source d'un espace (409 s'il y en a plusieurs). L'application reste sur GitHub : la supprimer depuis sa page
(`appHtmlUrl`).

---

## 3. Coolify (par espace)

### 3.1 Créer le jeton (dans Coolify)

1. Coolify → *Keys & Tokens* → *API Tokens*, avec l'équipe ou les environnements **de développement** actifs
   (Coolify ≥ 4.6 : « selected environments » ; sinon une équipe « Développement » dédiée).
2. Nom : « Nuera Dev · Développement ». Capacités : **`read` + `read:sensitive`** (journaux, variables). Jamais
   `write`, `delete` ni `root` (refusés). `deploy` est toléré mais les outils de déploiement restent bloqués pour Claude.
3. Choisir une expiration (90 jours conseillés) et la reporter dans Nuera Dev (`expiresAt`) : l'API Coolify ne la
   renvoie pas.
4. Si Coolify filtre les IP, autoriser l'adresse **du serveur qui héberge le web de Nuera Dev** (c'est le web qui
   appelle Coolify ; copie : « L'adresse du serveur de Nuera Dev n'est pas autorisée par Coolify. »), et activer le
   serveur MCP de Coolify (*Settings › Advanced › API and MCP*) pour que Claude puisse l'utiliser.

### 3.2 Coller le jeton (D2 « Reconnecter »)

`PUT /api/integrations/coolify` `{ "token": "67|…", "baseUrl": "https://coolify.nuera.studio", "expiresAt": "2027-02-03T00:00:00Z" }`
(`baseUrl` seulement à la première connexion de l'espace ; adresse soumise à la garde SSRF, refus
`address_refused` « L'adresse de Coolify désigne une machine interne : elle est refusée. »). Validation, **uniquement
par des GET** : `/api/health` → `/api/v1/version` → `/api/v1/team` (403 « limited to selected… » = jeton limité, cas
recommandé) → projets et environnements visibles (refus si un environnement « production » est visible, sauf
`allowProductionVisible: true`) → MCP `tools/list` (refus si des outils `manage_*`/`create_*` apparaissent). En cas de
refus, le jeton précédent est conservé (`untouched`). La réponse contient aussi `mcp` (serveur MCP Coolify retesté).

**Garde-fou « Production hors de portée »** : le jeton n'est confié à Claude que si ses capacités ont été lues dans la
liste d'outils du serveur MCP Coolify sans `write`. Sans MCP joignable, il est enregistré avec « Droits du jeton non
vérifiés… » et Claude ne l'obtient qu'après un « Tester la connexion » réussi.

### 3.3 Statuts

`POST /api/integrations/coolify/check` et le planificateur : santé → version → expiration déclarée. `401`/`400 Invalid
token` → `expired` (« Coolify refuse le jeton ») ; injoignable → `error` après deux échecs ; 7 jours avant l'expiration
→ `expiring`. Applications et déploiements : `GET /api/integrations/coolify/applications[?projectId=]`.

---

## 4. Figma

Nuera Dev **ne stocke aucun secret Figma** : le serveur distant `https://mcp.figma.com/mcp` n'accepte que l'OAuth de
Claude Code, donc la connexion vit dans le CLI **du serveur de l'espace**.

1. Intégrations → Figma → activer le serveur pour les projets voulus (« ACTIVÉ DANS »).
2. « Connecter » / « Reconnecter » : `POST /api/integrations/mcp/figma/login` ouvre, sur le serveur de l'espace, un
   terminal éphémère `claude mcp login figma --no-browser` (sortie jamais enregistrée ; réservé au propriétaire de
   l'espace, serveur attribué exigé, refusé sur un serveur suspendu ou retiré : 403 `ENVIRONMENT_DISABLED`). Ouvrir l'URL affichée, « Allow access », coller l'URL de redirection `localhost…`.
3. Nuera Dev inscrit au préalable l'entrée `figma` dans la portée utilisateur du CLI de ce serveur
   (`claude mcp add-json --scope user`, via le runner). Les sessions ne voient que leur `--mcp-config`.
4. Écritures Figma refusées à Claude (`permissions.deny` : `mcp__figma__use_figma`, `generate_figma_design`,
   `create_new_file`, `upload_assets`…).

---

## 5. Serveurs MCP (registre par espace)

### 5.1 Registre

Quatre serveurs préréglés, créés avec l'espace (désactivés tant qu'aucun projet ne les active), unicité
`(space_id, name)` :

| Nom | Transport | Authentification | Refusé à Claude |
|---|---|---|---|
| `figma` | HTTP `https://mcp.figma.com/mcp` | OAuth dans le Claude Code du serveur | outils d'écriture Figma |
| `github` | HTTP `https://api.githubcopilot.com/mcp/` + `X-MCP-Readonly: true`, `X-MCP-Toolsets: repos,issues,pull_requests` | jeton d'installation **lecture seule limité au dépôt de la session**, de la source du projet (jamais le PAT de secours) | outils d'écriture GitHub |
| `coolify` | HTTP `<Coolify>/mcp` | jeton Coolify de l'espace (§3), seulement s'il est vérifié sans `write` | `deploy`, `control`, `cancel_deployment`, `rollback_application` |
| `playwright` | stdio `npx -y @playwright/mcp@0.0.84 --headless --isolated` | aucune | — |

Serveurs personnalisés : `POST /api/integrations/mcp` — HTTP/SSE (adresse soumise à la garde SSRF ; en-têtes secrets
chiffrés, seuls leurs noms sont exposés) ou stdio (commande sans espace, arguments ; pas de variables secrètes).
L'état CLI/OAuth (entrées de portée utilisateur, autorisations OAuth) vit sur le serveur de l'espace :
`resetCliMcpState(spaceId)` remet les serveurs stdio/OAuth « à tester » quand ce serveur change.

### 5.2 Configuration de session (`buildSessionMcpConfig(projectId)`)

Renvoie `{ mcpConfig, denyRules, env, skipped }` conforme à `McpConfigSchema` (`@nuera/shared/runner`), avec les seuls
serveurs de l'espace activés pour le projet :

```json
{
  "mcpServers": {
    "figma":      { "type": "http", "url": "https://mcp.figma.com/mcp" },
    "github":     { "type": "http", "url": "https://api.githubcopilot.com/mcp/",
                    "headers": { "X-MCP-Readonly": "true", "X-MCP-Toolsets": "repos,issues,pull_requests" },
                    "headersHelper": "nuera" },
    "playwright": { "type": "stdio", "command": "npx", "args": ["-y", "@playwright/mcp@0.0.84", "--headless", "--isolated"] }
  }
}
```

`headersHelper: "nuera"` est remplacé par le runner par `bin/nuera-mcp-headers.mjs` (seule commande acceptée par le
contrat) ; l'assistant obtient les en-têtes auprès du web via `POST /api/internal/mcp-headers`, avec l'URL que Claude
Code s'apprête à appeler (`CLAUDE_CODE_MCP_SERVER_URL`) : un identifiant n'est jamais servi pour une autre adresse.
`env` = `{ "ENABLE_CLAUDEAI_MCP_SERVERS": "false" }`. `skipped` liste les serveurs activés mais écartés.

### 5.3 Diagnostic et statuts (`mcp_servers.status`)

`POST /api/integrations/mcp/<nom>/check` (« Tester la connexion ») et planificateur (serveurs activés dans au moins un
projet de l'espace) : HTTP avec identifiant (`initialize` → `notifications/initialized` → `tools/list` paginé →
`DELETE`, 10 s, transport épinglé) ; OAuth (sonde sans authentification puis `claude mcp get` sur le serveur de
l'espace) ; stdio (`claude mcp get` via le runner).

| Statut | Badge | Bouton |
|---|---|---|
| `connected` | Connecté | Configurer |
| `needs_auth` | Connexion requise | Reconnecter |
| `expired` (401 après avoir fonctionné) | Autorisation expirée | Reconnecter |
| `error` (injoignable deux fois, 404, refus) | Injoignable | Configurer |
| `disabled` (aucun projet, ou désactivé) | Désactivé | Activer |
| `unknown` | Non vérifié | Configurer |

Dernier diagnostic et historique des 20 derniers : `lastCheck` / `history` (« Voir le journal ») ; « Dernier appel »
vient des événements d'outil `mcp__<nom>__*` des sessions de l'espace.

### 5.4 Activation par projet

`PUT /api/integrations/mcp/<nom>/projects/<projectId>` `{ "enabled": true }` (le serveur et le projet doivent être du
même espace) ; « Désactiver partout » : `POST /api/integrations/mcp/<nom>/disable-all`. Effet sur les sessions démarrées
ou reprises ensuite.

---

## 6. Notifications et Web Push (par destinataire)

### 6.1 Clés VAPID (instance)

```bash
npx web-push generate-vapid-keys      # → VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
VAPID_SUBJECT=mailto:<adresse de l'exploitant>   # optionnel : APP_URL (https) par défaut
```

Sans ces variables (ou invalides), le push est **désactivé** et `GET /api/push/config` (session exigée) renvoie la
raison. Sur iPhone, le push n'existe que pour l'application **installée sur l'écran d'accueil**.

### 6.2 Abonner l'appareil (`features/settings/components/usePushSubscription.ts`)

```ts
const config = await (await fetch('/api/push/config')).json();          // { enabled, publicKey, reason }
if (!config.enabled) return showReason(config.reason);
const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
const permission = await Notification.requestPermission();               // depuis un geste utilisateur
if (permission !== 'granted') return;
const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(config.publicKey) });
await fetch('/api/push/subscription', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ...subscription.toJSON(), deviceLabel: null }) });
// État : GET /api/push/subscription?endpoint=… → { subscribed, devices } ; désactiver : DELETE { endpoint } ; test : POST /api/push/test
```

Un abonnement appartient à **un** compte (unicité `(user_id, endpoint)`) et vit le temps de l'accès web qui l'a créé
(`auth_session_id`). Il est supprimé à la déconnexion (le formulaire envoie l'endpoint courant), à la révocation de
cet accès, à son expiration par la politique (inactivité, durée maximale), à la désactivation du compte et au
retrait de l'appareil ; un envoi ou une lecture du compte qui trouve son accès fermé ne livre rien et supprime la
ligne (M08 propose de nouveau « Activer »). L'endpoint d'un nouvel abonnement doit être celui d'un service push
connu (FCM, Mozilla, WNS, Apple, ou un hôte de `NUERA_PUSH_HOSTS` ; 422 « service de notifications push non reconnu »
sinon) ; l'envoi ne suit jamais de redirection. Le service worker (`/sw.js`) affiche `title`, `body`, l'icône, regroupe par `tag` et, au clic,
met au premier plan ou ouvre la page (même domaine seulement) ; une notification d'un autre compte que celui de
l'onglet mène à `/parametres/notification?vers=&compte=` : « Cette notification concerne un autre compte Nuera Dev :
connectez-vous avec ce compte pour l'ouvrir. ». `pushsubscriptionchange` renouvelle par l'ancien endpoint
(`GET /api/push/subscription/renew` public → `{ enabled, publicKey }` ; `POST` → toujours 204, limité en débit) :
seule la ligne du compte dont le service worker porte le cookie de session est renouvelée (journalisé
`security.push_renewed` au nom de ce compte), jamais celle d'un autre compte du même navigateur ; sans session, rien
n'est écrit ; sans ancien endpoint connu,
la personne réactive les notifications dans Paramètres. Les abonnements qui répondent 404/410 sont supprimés à l'envoi.

### 6.3 Centre de notifications

| Route | Rôle |
|---|---|
| `GET /api/notifications?limit=&offset=&unread=1` | les miennes : non lues d'abord, puis les plus récentes ; `counts` |
| `GET /api/notifications/counts` | `{ unread, total, unreadBySeverity }` |
| `POST /api/notifications/read` | `{ ids: [...] }` ou `{ all: true }` (publié `notification.read` sur mes autres onglets) |

Une notification par destinataire : `createNotification(input, { spaceId?, userIds })` ; destinataires d'un événement
de serveur = membres de l'espace du serveur (administrateurs si non attribué). Dédoublonnage : une seule notification
**non lue** par destinataire et `dedupKey` (un nouvel événement la met à jour, espace et références compris, sans
nouveau push). Clés : `permission:<id>`, `session:<id>:…`, `claude:auth`, `integration:coolify:<état>`,
`integration:mcp:<nom>:<état>`, `integration:github:<sourceId>:<état>`, `integration:github:fallback:<état>` ; une
alerte d'instance nomme son serveur (`server:<environmentId>:…`).

Notifications d'intégration (T7) : « Autorisation <Service> bientôt expirée » (avant), « L'accès <Service> a été
retiré » (après), « <Service> ne répond plus depuis 09:12 » (injoignable) ; marquées lues dès que l'intégration
redevient saine. Bandeaux de diagnostic : `GET /api/integrations` → `diagnostics` (D07 et Accueil), chacun avec
`service` et `sourceId` ; une action n'est fournie que si elle a une destination.

---

## 7. Garde des requêtes sortantes (SSRF)

`guardedFetch` / `assertAllowedDestination` (`server/security/ssrf.ts`) pour Coolify, les serveurs MCP personnalisés et
les métadonnées OAuth : refus de la boucle locale, du lien-local, des adresses non spécifiées, du multicast et de la
diffusion, des hôtes des serveurs enregistrés (`RUNNER_URL`, `environments.url`), de la base (`DATABASE_URL`) et de
`NUERA_WEB_INTERNAL_URL`, par nom **et** par adresse. Chaque adresse résolue doit passer ; la requête part vers cette
adresse seule (transport `node:http(s)` épinglé, HTTP/1.1, variables de proxy ignorées) et ne suit aucune redirection.
Exception volontaire : `NUERA_PRIVATE_HOSTS` (hôtes ou adresses séparés par des virgules, ex. un Coolify sur le réseau
privé). Les plages RFC 1918 ne sont pas refusées (`docs/SECURITY.md` §11). Cache des hôtes connus :
`invalidateSsrfCache()` après un changement d'adresse de serveur.

---

## 8. Contrats runner → web (`/api/internal/*`)

Toutes exigent `Authorization: Bearer <jeton du serveur appelant>` (empreinte comparée à temps constant ;
`RUNNER_TOKEN` pour le serveur par défaut) ; le web en déduit le serveur (`suspended`/`retired` → 403). Une ressource
d'un autre serveur répond 404 et écrit `security.runner_scope_violation`.

| Route | Corps | Réponse |
|---|---|---|
| `POST /api/internal/mcp-headers` | `{ sessionId, serverName, serverUrl?, projectId? }` | `{ headers: { Authorization: "Bearer …" }, expiresAt }` — session vivante de **ce** serveur, serveur MCP de l'espace activé pour son projet, `serverUrl` = l'URL de ce serveur MCP (403 sinon) ; identifiants de l'espace de la session seulement |
| `POST /api/internal/git-credentials` | `{ projectId, access: "read" \| "write" }` | `{ extraHeader: "AUTHORIZATION: basic <base64(x-access-token:TOKEN)>", expiresAt }` pour **un** processus git — projet de ce serveur, jeton de **sa** source (rattachée paresseusement si nulle) ou `GITHUB_FALLBACK_TOKEN` pour l'espace du serveur par défaut sans source ; écriture journalisée |
| `POST /api/internal/notify` | `{ kind, severity?, title, body?, href?, sessionId?, projectId?, dedupKey? }` | `{ created, recipients, notification? }` — une notification par membre de l'espace du serveur ; une référence inconnue perd seulement son lien |

Les vérifications d'intégrations sont cadencées par le web uniquement (§9) ; aucun rappel du runner ne les déclenche
(l'ancienne route `POST /api/internal/integrations/check`, sans appelant, est supprimée). Erreurs : `{ error: { code,
message, detail?, raw?, untouched?, reason? } }`.

---

## 9. Planificateur web

`src/instrumentation.ts` démarre `server/integrations/scheduler.ts` : toutes les 15 min, pour chaque espace qui a
quelque chose à vérifier, les vérifications GitHub (par source), Coolify et MCP de cet espace sous un verrou
consultatif PostgreSQL (une réplique par espace), en sautant ce qui a été vérifié il y a moins de 10 min. Au
démarrage : passe de rechiffrement des tables d'intégration (lignes à l'ancien format réécrites liées à leur ligne,
comparer-et-échanger) et empreinte du jeton du serveur par défaut (`ensureDefaultRunnerTokenHash`).
`NUERA_WEB_SCHEDULER=off` le coupe (tests).

---

## 10. API navigateur (session + 2FA, Origin vérifiée sur les mutations, espace du contexte)

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/integrations` | vue d'ensemble D07/M07/D01 (sources GitHub, grille MCP, Coolify, bandeaux, garde-fous, push) |
| GET / DELETE | `/api/integrations/github` | agrégat + `sources[]` / déconnexion de la seule source |
| GET / POST | `/api/integrations/github/sources` | `{ sources, sourceCount, maxSources, canAddSource }` / ajouter une source (page auto-soumise) |
| GET / PATCH / DELETE | `/api/integrations/github/sources/[id]` | une source / `{ label }` / déconnecter (409 si un projet l'utilise) |
| POST | `/api/integrations/github/sources/[id]/check` · `/api/integrations/github/check` | vérifier une source · l'espace |
| POST | `/api/integrations/github/manifest` | première source (page auto-soumise) |
| GET | `/api/integrations/github/callback`, `/setup`, `/install[?source=]` | retours GitHub / installation (publics pour le navigateur, état exigé) |
| GET | `/api/integrations/github/repos?owner=&q=` | dépôts accessibles par les sources de l'espace (A1) |
| GET / PUT / DELETE | `/api/integrations/coolify` | état / reconnexion / suppression du jeton de l'espace |
| POST | `/api/integrations/coolify/check` | vérifier Coolify |
| GET | `/api/integrations/coolify/applications?projectId=` | applications et déploiements |
| GET / POST | `/api/integrations/mcp[?projectId=]` | grille MCP (ou « Outils MCP du projet » D04) / ajout d'un serveur |
| GET / PATCH / DELETE | `/api/integrations/mcp/<nom>` | détail / modification / suppression |
| POST | `/api/integrations/mcp/<nom>/check` · `/disable-all` · `/login` | tester · désactiver partout · terminal `claude mcp login` → `{ terminalId, streamUrl }` |
| PUT | `/api/integrations/mcp/<nom>/projects/<projectId>` | activer pour un projet |
| GET | `/api/push/config` | clé publique VAPID ou raison |
| GET / POST / DELETE | `/api/push/subscription` | abonnement de l'appareil pour ce compte |
| GET / POST | `/api/push/subscription/renew` | renouvellement par le service worker (public) |
| POST | `/api/push/test` | notification de test |
| GET / POST | `/api/notifications`, `/api/notifications/counts`, `/api/notifications/read` | centre de notifications du compte |

PWA : `/manifest.webmanifest`, icônes `/icon/32`, `/icon/192`, `/icon/512`, `/icon/maskable`, `/apple-icon`, service
worker `/sw.js`.

---

## 11. Variables d'environnement

| Variable | Rôle |
|---|---|
| `APP_URL` | URL publique (adresses des manifests GitHub, redirections, clés d'accès) |
| `APP_ENCRYPTION_KEY` | clé AES-256-GCM des secrets (32 octets base64) |
| `RUNNER_TOKEN` | jeton du serveur par défaut (les autres serveurs ont leur jeton en base) |
| `NUERA_PRIVATE_HOSTS` | hôtes privés que la garde SSRF laisse joindre (vide par défaut) |
| `NUERA_WEB_SCHEDULER` | `on` (défaut) / `off` (tests) |
| `NUERA_WEB_INTERNAL_URL` | adresse interne du web (refusée comme destination sortante) |
| `GITHUB_API_URL` | base de l'API GitHub (tests uniquement ; défaut `https://api.github.com`) |
| `GITHUB_WEB_URL` | base github.com des redirections navigateur (tests e2e uniquement) |
| `GITHUB_FALLBACK_TOKEN` | PAT de secours de l'espace du serveur par défaut, jamais proposé dans l'interface |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push |
| `NUERA_PUSH_HOSTS` | hôtes de services push supplémentaires (`hôte` ou `*.domaine`, séparés par des virgules) ; les hôtes `.test` ne sont acceptés qu'hors production |

Tests : `pnpm --filter @nuera/web test` crée et migre une base par fichier de test (`<NUERA_DB_TEST_PREFIX>_<suite>`,
défaut `nuera_integrations`) sur le PostgreSQL local (`NUERA_TEST_PG_ADMIN_URL`, défaut
`postgres://nuera:nuera@127.0.0.1:54329/postgres`), avec de faux GitHub (plusieurs applications), Coolify et serveurs
MCP locaux (`NUERA_PRIVATE_HOSTS=127.0.0.1,localhost` pour qu'ils passent la garde). Isolation :
`app/api/integrations/isolation.test.ts` ; e2e : `e2e/github-sources.spec.ts`, `e2e/integrations.spec.ts`.
