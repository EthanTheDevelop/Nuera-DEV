# Intégrations — guide de mise en service et référence

> Pour le propriétaire de Nuera Dev : connecter GitHub en un clic, installer l'application, préparer le
> jeton Coolify, connecter Figma, activer les notifications sur le téléphone. Pour les autres lots : API
> HTTP, contrats runner → web et API d'abonnement Web Push.
> Recherche et justification des choix : `docs/research/integrations.md` (référencée « §x » ci-dessous).

Code : `apps/web/src/server/{github,coolify,mcp,integrations,notifications,push}`, routes
`apps/web/src/app/api/{integrations,internal,push,notifications}`, PWA `apps/web/public/sw.js`,
`apps/web/src/app/{manifest.ts,icon.tsx,apple-icon.tsx}`.

---

## 1. Principes

- **Aucun jeton GitHub saisi à la main** : l'application GitHub est créée par le *flux manifest* ; ses
  identifiants (clé privée, secret client, secret webhook) sont **chiffrés** (AES-256-GCM,
  `APP_ENCRYPTION_KEY`) dans `integrations.secrets_encrypted`.
- **Jetons d'installation réduits** : chaque opération obtient un jeton d'une heure limité **au dépôt
  concerné et aux droits de l'opération** (lecture du contenu pour un clone, écriture pour un push,
  `pull_requests: write` pour ouvrir une PR…), gardé en mémoire uniquement et réutilisé jusqu'à 5 min
  avant son expiration.
- **Aucun secret renvoyé au navigateur** : l'API expose une empreinte (« jeton n°67 »), des noms
  d'en-têtes, des dates — jamais une valeur. Les messages des fournisseurs sont caviardés.
- **Diagnostics non mutants** : GET REST, `initialize` + `tools/list` MCP, `claude mcp get`. Jamais un
  appel d'outil, jamais un déploiement.
- **Production hors de portée** : client Coolify en lecture seule (GET), outils Coolify de déploiement
  refusés à Claude (`permissions.deny`), jeton limité aux environnements de développement.
- **Un accès, un projet** : chaque session Claude reçoit un `--mcp-config` qui ne contient que les
  serveurs activés pour **son** projet (`--strict-mcp-config`, connecteurs claude.ai désactivés).

---

## 2. GitHub

### 2.1 Créer l'application (un clic)

1. Vérifier `APP_URL` (ex. `https://dev.nuera.studio`) : les adresses de retour en dépendent.
2. Intégrations → **Connecter GitHub**. Le formulaire envoie `POST /api/integrations/github/manifest`
   (champs facultatifs `organization` — ex. `nuera-studio` — et `public`). Nuera Dev répond par une page
   qui transmet automatiquement le *manifest* à github.com, avec un `state` signé valable **une heure** et
   lié au navigateur (cookie HttpOnly `nuera_github_state`).
3. Sur GitHub, confirmer la création de « Nuera Dev · <hôte> » (34 caractères maximum ; GitHub permet de
   modifier le nom si déjà pris).
4. GitHub revient sur `/api/integrations/github/callback` : le code est échangé
   (`POST /app-manifests/{code}/conversions`), les identifiants sont chiffrés et stockés, puis GitHub
   affiche la page d'installation.

Manifest envoyé (construit depuis `APP_URL`) :

| Champ | Valeur |
|---|---|
| `name` | `Nuera Dev · <hôte d'APP_URL>` |
| `url` | `APP_URL` |
| `redirect_url`, `callback_urls` | `APP_URL/api/integrations/github/callback` |
| `setup_url` (+ `setup_on_update`) | `APP_URL/api/integrations/github/setup` |
| `hook_attributes` | `APP_URL/api/integrations/github/webhook`, **inactif** (Nuera Dev interroge GitHub) |
| `public` | `true` par défaut (voir ci-dessous) |
| `default_permissions` | `contents: write`, `pull_requests: write`, `metadata: read`, `checks: read`, `statuses: read`, `issues: read` |

**Pourquoi « publique »** : une application privée ne peut être installée que sur le compte qui la
possède ; il faut une application publique pour l'installer à la fois sur l'organisation `nuera-studio`
et sur le compte personnel `ethanthedevelop`. Si un tiers l'installait, cela ne donnerait accès qu'à
**ses** dépôts, jamais aux vôtres — et Nuera Dev ignore toute installation d'un compte qu'il n'a pas
lui-même installé (liste d'autorisation, §2.2). Si tous les dépôts sont dans l'organisation, envoyer
`public=false` (application privée) est plus strict.

### 2.2 Installer sur les comptes

- Sur la page d'installation, choisir le compte puis **Only select repositories** et cocher les dépôts.
- GitHub revient sur `/api/integrations/github/setup?installation_id=…&setup_action=install&state=…`.
  L'installation est **vérifiée avec le JWT de l'application** (`GET /app/installations/{id}`) ; un
  nouveau compte n'est ajouté à la liste d'autorisation que si le `state` signé par Nuera Dev pour ce
  navigateur est présent et valide. Une installation inconnue est ignorée et journalisée.
- Pour un second compte : `GET /api/integrations/github/install` (bouton « Installer sur GitHub » /
  « Réautoriser sur GitHub ») génère un nouveau `state` et redirige vers la page d'installation.
- « Gérer l'accès » : `https://github.com/apps/<slug>/installations/new` (chaque compte y a son lien
  « Configure ») ; chaque compte a aussi son `manageUrl` (page de l'installation).

Codes de retour transmis à la page Intégrations (`/integrations?github=<code>`) :

| Code | Sens |
|---|---|
| `installed` / `updated` | installation enregistrée (vérification lancée aussitôt) — `&compte=<login>` |
| `requested` | un membre non administrateur a demandé l'installation |
| `state_invalid` / `state_expired` | retour GitHub non lié à une demande de ce navigateur / plus d'une heure |
| `already_connected` | une application est déjà enregistrée |
| `conversion_failed` | GitHub a refusé le code (expiré ou déjà utilisé) |
| `installation_unknown` | installation non reconnue (compte non autorisé, sans `state`) |
| `installation_failed` / `not_connected` | erreur de vérification / aucune application enregistrée |

### 2.3 Vérification et statuts

`POST /api/integrations/github/check` (« Vérifier la connexion », au plus une fois par 10 s) et le
planificateur (15 min) exécutent : JWT → `GET /app`, `GET /app/installations`, un jeton
`metadata: read` par installation, comparaison des droits, `GET /installation/repositories` (nombre de
dépôts), quota restant. Statuts (`integrations.status`) :

| Statut | Quand | Affichage |
|---|---|---|
| `pending` | application créée, pas encore installée | « Application non installée » |
| `connected` | tout répond | « Connecté » |
| `expired` | clé révoquée, installation suspendue ou supprimée, droits à accepter | « Autorisation expirée » + action GitHub |
| `error` | GitHub injoignable **deux fois de suite** (hystérésis) | « Injoignable » |

`DROITS` est calculé depuis les droits réellement accordés (« Contenu · pull requests » / « lecture et
écriture ; issues, checks et statuts en lecture »).

### 2.4 Repli documenté (jamais dans l'interface)

`GITHUB_FALLBACK_TOKEN` (PAT *fine-grained* : Contents RW, Pull requests RW, Metadata R, Commit statuses
R, Issues R) est utilisé seulement si aucune application n'est enregistrée. Son expiration est lue dans
l'en-tête `GitHub-Authentication-Token-Expiration` (alerte 7 jours avant). Pas d'API Checks avec un PAT.
Il sert à l'API et à Git (runner) uniquement : **il n'est jamais confié à Claude**. Un PAT ne peut être ni
limité au dépôt de la session ni réduit à la lecture, donc le serveur MCP GitHub est écarté des sessions
tant que l'application GitHub n'est pas connectée (`skipped`, et `403` sur `/api/internal/mcp-headers`).

### 2.5 Déconnexion

`DELETE /api/integrations/github` supprime les identifiants chiffrés (journalisé). L'application reste
sur GitHub : la supprimer depuis sa page (`appHtmlUrl`).

---

## 3. Coolify

### 3.1 Créer le jeton (dans Coolify)

1. Coolify → *Keys & Tokens* → *API Tokens*, avec l'équipe ou les environnements **de développement**
   actifs (Coolify ≥ 4.6 : « selected environments » ; sinon une équipe « Développement » dédiée).
2. Nom : « Nuera Dev · Développement ». Capacités : **`read` + `read:sensitive`** (journaux, variables).
   Jamais `write`, `delete` ni `root` (refusés par Nuera Dev). `deploy` est toléré mais les outils de
   déploiement restent bloqués pour Claude.
3. Choisir une expiration (90 jours conseillés) et la reporter dans Nuera Dev (`expiresAt`) : l'API
   Coolify ne la renvoie pas, c'est elle qui permet l'alerte « bientôt expirée ».
4. Autoriser l'IP de VPS-3 si une liste d'IP est configurée, et activer le serveur MCP de Coolify
   (*Settings › Advanced › API and MCP*) pour que Claude puisse l'utiliser.

### 3.2 Coller le jeton (D2 « Reconnecter »)

`PUT /api/integrations/coolify` `{ "token": "67|…", "baseUrl": "https://coolify.nuera.studio", "expiresAt": "2027-02-03T00:00:00Z" }`
(`baseUrl` seulement à la première connexion). Validation, **uniquement par des GET** :
`/api/health` → `/api/v1/version` (jeton + `read`) → `/api/v1/team` (200 = jeton d'équipe ; 403 « limited
to selected… » = jeton limité, cas recommandé) → projets et environnements visibles (refus si un
environnement « production » est visible, sauf `allowProductionVisible: true`) → MCP `tools/list`
(capacités déduites des outils listés ; refus si des outils `manage_*`/`create_*` apparaissent).
En cas de refus, le jeton précédent est conservé (`untouched`). Le jeton est chiffré et n'est plus
jamais affiché (« jeton n°67 »). La réponse contient aussi `mcp` : l'état du serveur MCP Coolify retesté
aussitôt avec le nouveau jeton (la carte et le bandeau de diagnostic se mettent à jour sans attendre).

**Garde-fou « Production hors de portée »** : le jeton n'est confié à Claude (assistant d'en-têtes MCP)
que si ses capacités ont été lues dans la liste d'outils du serveur MCP Coolify et ne comprennent pas
`write`. Si le serveur MCP est indisponible pendant la reconnexion (désactivé, 404…), le jeton est
enregistré avec l'avertissement « Droits du jeton non vérifiés… » et Claude ne l'obtient qu'après un
« Tester la connexion » réussi du serveur MCP Coolify ; si ce test révèle des outils d'écriture, le
serveur passe en erreur et le jeton reste refusé (`skipped` dans la configuration de session, `403` sur
`/api/internal/mcp-headers`).

### 3.3 Statuts

`POST /api/integrations/coolify/check` et le planificateur : santé → version → expiration déclarée.
`401`/`400 Invalid token` → `expired` (« Coolify refuse le jeton ») immédiatement ; injoignable → `error`
après deux échecs ; 7 jours avant l'expiration déclarée → `expiring` (bandeau T7 « avant »).
Lecture des applications et déploiements : `GET /api/integrations/coolify/applications[?projectId=]`
(correspondance dépôt + branche, champs sans secret).

---

## 4. Figma

Nuera Dev **ne stocke aucun secret Figma** : le serveur distant `https://mcp.figma.com/mcp` n'accepte que
l'OAuth de Claude Code.

1. Intégrations → Figma → activer le serveur pour les projets voulus (« ACTIVÉ DANS »).
2. « Reconnecter » / « Connecter » : `POST /api/integrations/mcp/figma/login` ouvre un terminal web
   éphémère qui lance `claude mcp login figma --no-browser` (sortie jamais enregistrée). Ouvrir l'URL
   affichée, cliquer « Allow access », copier l'URL de redirection `localhost…` depuis la barre d'adresse
   et la coller dans le terminal.
3. Nuera Dev inscrit au préalable l'entrée `figma` dans la portée utilisateur de Claude Code
   (`claude mcp add-json --scope user`, via le runner) pour que `claude mcp login` et `claude mcp get`
   fonctionnent. Les sessions, elles, ne voient que leur `--mcp-config`.
4. Écritures Figma refusées à Claude par des règles `permissions.deny` (`mcp__figma__use_figma`,
   `generate_figma_design`, `create_new_file`, `upload_assets`…).

---

## 5. Serveurs MCP

### 5.1 Registre

Quatre serveurs intégrés (créés au premier affichage, désactivés tant qu'aucun projet ne les active) :

| Nom | Transport | Authentification | Refusé à Claude |
|---|---|---|---|
| `figma` | HTTP `https://mcp.figma.com/mcp` | OAuth dans Claude Code | outils d'écriture Figma |
| `github` | HTTP `https://api.githubcopilot.com/mcp/` + `X-MCP-Readonly: true`, `X-MCP-Toolsets: repos,issues,pull_requests` | jeton d'installation **lecture seule limité au dépôt de la session** (application GitHub uniquement, jamais le PAT de secours) | outils d'écriture GitHub |
| `coolify` | HTTP `<Coolify>/mcp` | jeton Coolify (§3), seulement s'il est vérifié sans `write` | `deploy`, `control`, `cancel_deployment`, `rollback_application` |
| `playwright` | stdio `npx -y @playwright/mcp@0.0.84 --headless --isolated` | aucune | — |

Serveurs personnalisés : `POST /api/integrations/mcp` — HTTP/SSE (en-têtes secrets chiffrés, seuls leurs
noms sont exposés) ou stdio (commande sans espace, arguments ; pas de variables secrètes en stdio).

### 5.2 Configuration de session (`buildSessionMcpConfig(projectId)`)

Renvoie `{ mcpConfig, denyRules, env, skipped }` conforme à `McpConfigSchema` (`@nuera/shared/runner`) :

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

`headersHelper: "nuera"` est remplacé par le runner par son propre assistant (`bin/nuera-mcp-headers.mjs`,
seule commande acceptée par le contrat runner) ; l'assistant obtient les en-têtes auprès du web via
`POST /api/internal/mcp-headers`. `env` = `{ "ENABLE_CLAUDEAI_MCP_SERVERS": "false" }`. `skipped` liste
les serveurs activés mais écartés (ex. « Coolify n'est pas connecté. »).

### 5.3 Diagnostic et statuts (`mcp_servers.status`)

`POST /api/integrations/mcp/<nom>/check` (« Tester la connexion ») et planificateur (serveurs activés
dans au moins un projet) :

- HTTP avec identifiant Nuera (GitHub, Coolify, personnalisés) : `initialize` → `notifications/initialized`
  → `tools/list` (paginé) → `DELETE` de la session, délai 10 s, avec l'identifiant qu'aurait la session ;
- OAuth (Figma) : sonde sans authentification (401 + `WWW-Authenticate` attendu) puis `claude mcp get` ;
- stdio : `claude mcp get` via le runner.

| Statut | Badge | Bouton |
|---|---|---|
| `connected` | Connecté | Configurer |
| `needs_auth` | Connexion requise | Reconnecter |
| `expired` (401 après avoir fonctionné) | Autorisation expirée | Reconnecter |
| `error` (injoignable deux fois, 404, refus) | Injoignable | Configurer |
| `disabled` (aucun projet, ou désactivé) | Désactivé | Activer |
| `unknown` | Non vérifié | Configurer |

Le dernier diagnostic (étapes, codes HTTP, en-têtes autorisés, sortie caviardée) et l'historique des 20
derniers sont dans `lastCheck` / `history` (« Voir le journal »). « Dernier appel » (`lastCall` : date,
outil, projet, succès) vient des évènements d'outil `mcp__<nom>__*` enregistrés par le pont de hooks du
runner (`session_events`).

### 5.4 Activation par projet

`PUT /api/integrations/mcp/<nom>/projects/<projectId>` `{ "enabled": true }` ; « Désactiver partout » :
`POST /api/integrations/mcp/<nom>/disable-all`. Effet sur les sessions démarrées ou reprises ensuite.

---

## 6. Notifications et Web Push

### 6.1 Clés VAPID (serveur)

```bash
npx web-push generate-vapid-keys      # → VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
VAPID_SUBJECT=mailto:<adresse du propriétaire>   # optionnel : APP_URL (https) par défaut
```

Sans ces trois variables (ou si elles sont invalides), le push est **désactivé** et
`GET /api/push/config` renvoie la raison (`enabled: false, reason: "Notifications push désactivées : …"`).
Sur iPhone, le push n'existe que pour l'application **installée sur l'écran d'accueil**.

### 6.2 Abonner l'appareil (code client, à placer dans `src/features/…`)

```ts
const config = await (await fetch('/api/push/config')).json();          // { enabled, publicKey, reason }
if (!config.enabled) return showReason(config.reason);
const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
const permission = await Notification.requestPermission();               // depuis un geste utilisateur
if (permission !== 'granted') return;
const subscription = await registration.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: urlBase64ToUint8Array(config.publicKey),
});
await fetch('/api/push/subscription', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ...subscription.toJSON(), deviceLabel: null }),  // libellé optionnel
});
// État du réglage M08 : GET /api/push/subscription?endpoint=<subscription.endpoint> → { subscribed, devices }
// Désactiver : await subscription.unsubscribe(); DELETE /api/push/subscription { endpoint }
// Vérifier : POST /api/push/test → { sent, pruned, failed, skipped }
```

Le service worker (`/sw.js`) affiche `title`, `body`, l'icône, regroupe par `tag` et, au clic, met au
premier plan l'onglet déjà ouvert sur la page, sinon navigue un onglet ouvert, sinon en ouvre un. Seuls
les chemins du même domaine sont ouverts. `pushsubscriptionchange` réabonne automatiquement.
Les abonnements qui répondent 404/410 sont supprimés à l'envoi.

### 6.3 Centre de notifications

| Route | Rôle |
|---|---|
| `GET /api/notifications?limit=&offset=&unread=1` | non lues d'abord, puis les plus récentes ; `counts` |
| `GET /api/notifications/counts` | `{ unread, total, unreadBySeverity }` |
| `POST /api/notifications/read` | `{ ids: [...] }` ou `{ all: true }` |

Déduplication : une seule notification **non lue** par `dedupKey` (un nouvel évènement la met à jour, sans
nouveau push). Côté serveur : `notify(input)` (`@/server/notifications`).

Notifications d'intégration (T7) : « Autorisation <Service> bientôt expirée » / « Renouvelez l'accès
avant le 12 novembre. » (avant), « L'accès <Service> a été retiré » + ce qui s'arrête (après),
« <Service> ne répond plus depuis 09:12 » (injoignable). Elles sont marquées lues dès que l'intégration
redevient saine. Un serveur MCP jamais autorisé (« Connexion requise ») n'en crée pas : rien n'a été
retiré ; il figure dans `attention` (Accueil) et sa carte propose « Reconnecter ».

Bandeaux de diagnostic (`GET /api/integrations` → `diagnostics`, D07 et Accueil) :

| État | Titre | Corps | Actions |
|---|---|---|---|
| injoignable (`error`) | « <Service> ne répond plus depuis 09:12 » | raison + ce qui continue | Voir le journal, Reconnecter |
| jeton Coolify refusé | « Coolify ne répond plus depuis 09:12 » (Figma D07) | « Le jeton du serveur MCP a expiré. Les sessions de <projets> continuent, sans accès aux environnements de développement. » | Voir le journal, Reconnecter |
| accès retiré (autres services) | « L'accès <Service> a été retiré » (T7 après) | raison + ce qui s'arrête | Voir le journal, action du service (« Réautoriser sur GitHub »…) |
| expiration connue proche (`expiring`) | « Autorisation <Service> bientôt expirée » (T7 avant, ton alerte) | « Renouvelez l'accès avant le 12 novembre. » | Renouveler (Coolify) ; aucune pour le PAT de secours |

Une action n'est fournie que si elle a une destination (`href`).

---

## 7. Contrats runner → web (`/api/internal/*`)

Toutes exigent `Authorization: Bearer ${RUNNER_TOKEN}` (comparaison à temps constant), corps JSON.

| Route | Corps | Réponse |
|---|---|---|
| `POST /api/internal/mcp-headers` | `{ sessionId: uuid, serverName }` | `{ headers: { Authorization: "Bearer …" }, expiresAt }` — refus `403` si la session n'est pas `new`/`running`/`waiting_permission`/`waiting_input` ou si le serveur n'est pas activé pour son projet, `404` session inconnue |
| `POST /api/internal/git-credentials` | `{ projectId: uuid, access: "read" \| "write" }` | `{ extraHeader: "AUTHORIZATION: basic <base64(x-access-token:TOKEN)>", expiresAt }` — valeur de `http.https://github.com/.extraheader` pour **un** processus git (`GIT_CONFIG_COUNT`) ; écriture journalisée |
| `POST /api/internal/notify` | `{ kind, severity?, title, body?, href?, sessionId?, projectId?, dedupKey? }` | `{ notification, created, push }` |
| `POST /api/internal/integrations/check` | `{ trigger?: "schedule" \| "startup" \| "hook" \| "git_failure" }` | `{ startedAt, durationMs, github, coolify, mcp[] }` |

Erreurs : `{ error: { code, message, detail?, raw?, untouched? } }` (`401 UNAUTHORIZED` si le jeton est
absent ou faux, `422 VALIDATION`, `404`, `409 CONFLICT` si l'intégration n'est pas connectée).

---

## 8. API navigateur (session + 2FA, Origin vérifiée sur les mutations)

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/integrations` | vue d'ensemble D07/M07/D01 (GitHub, grille MCP, Coolify, bandeaux, garde-fous, push) |
| GET / DELETE | `/api/integrations/github` | statut / déconnexion |
| POST | `/api/integrations/github/manifest` | création de l'application (page auto-soumise) |
| GET | `/api/integrations/github/callback`, `/setup`, `/install` | retours GitHub / installation |
| POST | `/api/integrations/github/check` | vérifier la connexion |
| GET | `/api/integrations/github/repos?owner=&q=` | dépôts accessibles (A1) |
| GET / PUT / DELETE | `/api/integrations/coolify` | état / reconnexion / suppression du jeton |
| POST | `/api/integrations/coolify/check` | vérifier Coolify |
| GET | `/api/integrations/coolify/applications?projectId=` | applications et déploiements |
| GET / POST | `/api/integrations/mcp[?projectId=]` | grille MCP (ou « Outils MCP du projet » D04 avec `projectId`) / ajout d'un serveur |
| GET / PATCH / DELETE | `/api/integrations/mcp/<nom>` | détail (tiroir) / modification / suppression |
| POST | `/api/integrations/mcp/<nom>/check` | tester la connexion |
| PUT | `/api/integrations/mcp/<nom>/projects/<projectId>` | activer pour un projet |
| POST | `/api/integrations/mcp/<nom>/disable-all` | désactiver partout |
| POST | `/api/integrations/mcp/<nom>/login` | terminal `claude mcp login <nom> --no-browser` → `{ terminalId, streamUrl, inputUrl }` |
| GET | `/api/push/config` | clé publique VAPID ou raison |
| GET / POST / DELETE | `/api/push/subscription` | abonnement de l'appareil |
| POST | `/api/push/test` | notification de test |
| GET / POST | `/api/notifications`, `/api/notifications/counts`, `/api/notifications/read` | centre de notifications |

PWA : `/manifest.webmanifest`, icônes `/icon/32`, `/icon/192`, `/icon/512`, `/icon/maskable`,
`/apple-icon` (pastille « DEV » de Figma S5), service worker `/sw.js`.

---

## 9. Variables d'environnement

| Variable | Rôle |
|---|---|
| `APP_URL` | URL publique (adresses du manifest GitHub, redirections) |
| `APP_ENCRYPTION_KEY` | clé AES-256-GCM des secrets (32 octets base64) |
| `RUNNER_TOKEN` | jeton partagé web ⇄ runner (routes internes) |
| `GITHUB_API_URL` | base de l'API GitHub (tests uniquement ; défaut `https://api.github.com`) |
| `GITHUB_WEB_URL` | base github.com des redirections navigateur (tests e2e uniquement) |
| `GITHUB_FALLBACK_TOKEN` | PAT de secours, jamais proposé dans l'interface |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push |

Tests : `pnpm --filter @nuera/web test` crée et migre une base par fichier de test
(`nuera_integrations_<suite>`) sur le PostgreSQL local (`NUERA_TEST_PG_ADMIN_URL`, défaut
`postgres://nuera:nuera@127.0.0.1:54329/postgres`), avec de faux GitHub, Coolify et serveurs MCP locaux.
