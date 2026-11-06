# Déploiement — Nuera Dev via Coolify

> Cible : application **web** exposée (https://nuera-dev.perso.nuera.studio aujourd'hui, `https://dev.nuera.studio`
> prévu), **runners** privés (un par serveur), PostgreSQL distinct non exposé.
> Les images et le compose principal ont été construits et essayés **localement** avec Docker (§10) ; le déploiement
> réel du 5 novembre 2026 sur NUERA-PERSO-01 est consigné en fin de document. La version **multi-comptes** (§12 à
> §14 : `migrate` avec `RUNNER_TOKEN`, point d'entrée du runner, `deploy/docker-compose.runner.yml`) a été préparée
> sur un poste **sans Docker** : aucune image n'en a été construite, aucun conteneur lancé. Ce qui reste à vérifier
> est listé au §11. Les étapes marquées **[propriétaire]** demandent des accès que seul le propriétaire de
> l'instance possède.

## 1. Vue d'ensemble

```
Coolify ── déploie ──► serveur Docker (VPS-3 prévu ; en service : NUERA-PERSO-01)
                         ├─ PostgreSQL 17 (ressource Coolify, réseau privé, sauvegardes)
                         ├─ Compose « nuera-dev » (deploy/docker-compose.yml) : ressource principale
                         │    ├─ migrate  (ponctuel : applique packages/db/drizzle, enregistre l'empreinte du jeton
                         │    │            du serveur par défaut, puis s'arrête)
                         │    ├─ web      (Next.js standalone, port 3000 → domaine HTTPS, Traefik)
                         │    └─ runner   (serveur par défaut « VPS-3 » ; aucun port publié ; volumes /srv/dev,
                         │                 /data, /home/nuera)
                         └─ Compose d'un serveur supplémentaire (deploy/docker-compose.runner.yml), un par serveur
                              └─ environment-runner (aucun port publié ; ses propres volumes, §13)
```

Un **serveur** (environnement d'exécution) est une instance du runner : son disque, son tmux, son CLI Claude Code et
la connexion Claude d'**une seule personne**. Un serveur = un espace = une personne = une connexion Claude.

| Image | Dockerfile (cible) | Contenu | Taille mesurée (essai local) |
|---|---|---|---|
| `nuera-dev-web` | `deploy/docker/web.Dockerfile` (`runtime`) | `node:24-bookworm-slim`, sortie standalone Next, `curl`, `tini` ; utilisateur `node` (uid 1000) | 477 Mo (115 Mo compressés) |
| `nuera-dev-migrate` | `deploy/docker/web.Dockerfile` (`migrate`) | `@nuera/db` seul (drizzle-orm, postgres.js, tsx) ; utilisateur `node` | 864 Mo (217 Mo compressés) |
| `nuera-dev-runner` | `deploy/docker/runner.Dockerfile` | runner groupé (esbuild) + dépendances de prod, git 2.39, tmux 3.3a, Node 24, bubblewrap, socat, locale `fr_FR.UTF-8` ; utilisateur `nuera` (uid 1001). Chaque serveur supplémentaire construit la même image, sans étiquette partagée | 567 Mo (131 Mo compressés) |

Garanties des compose (`deploy/docker-compose.yml`, `deploy/docker-compose.runner.yml`) :

- `web` : non-root, système de fichiers racine en **lecture seule** (`tmpfs` sur `/tmp` et `.next/cache`),
  `cap_drop: ALL`, `no-new-privileges`, **aucun socket Docker**, aucun volume.
- `runner` : non-root (`nuera`), `no-new-privileges`, limites CPU/mémoire/PID (`RUNNER_CPUS`, `RUNNER_MEMORY`,
  4096 PID), **aucun port publié** : joignable seulement sur les réseaux Docker internes (`nuera-internal`, où `web`
  l'appelle en `http://runner:4100`, et le réseau prédéfini de Coolify quand l'option est activée), jeton
  `RUNNER_TOKEN` exigé sur chaque route (`401` sans lui). L'écoute des hooks du CLI (4101) reste sur `127.0.0.1` dans
  le conteneur. Quand `RUNNER_DATABASE_URL` est renseignée, son point d'entrée la substitue à `DATABASE_URL` avant de
  lancer `tini` et le runner (§14).
- `environment-runner` (`deploy/docker-compose.runner.yml`) : mêmes garanties et mêmes limites ; ne reçoit jamais le
  DSN complet de l'instance, seulement le DSN restreint de son serveur (§13).
- `migrate` doit se terminer en succès avant le démarrage de `web` et `runner`. Il reçoit `RUNNER_TOKEN` pour
  enregistrer l'empreinte SHA-256 du jeton du serveur par défaut (jamais le jeton lui-même).

Données persistantes (volumes nommés) — **jamais supprimées par un redéploiement** :

| Volume | Monté dans | Contenu |
|---|---|---|
| `nuera-projects` | runner `/srv/dev` | clones GitHub et worktrees (`/srv/dev/<projet>`, `/srv/dev/.worktrees/…`) |
| `nuera-runner-data` | runner `/data` | réglages par session, journaux du runner, configuration tmux |
| `nuera-claude-home` | runner `/home/nuera` | CLI Claude Code officiel (installé au 1er démarrage dans `~/.local/bin`), `~/.claude` (connexion, conversations) |
| `nuera-server-<slug>-projects`, `-data`, `-home` | `environment-runner` (mêmes chemins) | idem pour chaque serveur supplémentaire ; noms demandés d'après `NUERA_SERVER_SLUG`. Coolify renomme les volumes qu'il gère (sa documentation ne garantit pas le `name:` du compose) : relever les noms réels (§13, étape 4) |

Les trois volumes du serveur par défaut gardent leurs noms d'avant la version multi-comptes : ne jamais les renommer.

## 2. Prérequis [propriétaire]

1. DNS : enregistrement `A`/`AAAA` `dev.nuera.studio` → IP de VPS-3.
2. VPS-3 ajouté comme serveur dans Coolify (VPS-1), Docker installé par Coolify.
3. Accès GitHub au dépôt `EthanTheDevelop/-Nuera-DEV` depuis Coolify (application GitHub de Coolify ou clé de déploiement).
4. VPS-3 : au moins 4 vCPU / 8 Go conseillés (le runner est limité par défaut à 6 CPU / 12 Go, à ajuster) ; compter
   environ 2 vCPU / 4 Go de plus par serveur supplémentaire (§13).

## 3. PostgreSQL

1. Coolify → *New resource* → **PostgreSQL 17** sur VPS-3. Ne **pas** activer « Make it publicly available ».
2. Noter l'URL interne (`postgres://…@<service>:5432/<db>`). Activer les **sauvegardes planifiées** Coolify (quotidiennes,
   rétention ≥ 14 jours, idéalement vers un stockage S3).
3. Complément : `deploy/scripts/backup-db.sh` et `restore-db.sh` (§9).
4. L'utilisateur de `DATABASE_URL` doit pouvoir créer des rôles : la migration `0004_runner_roles` crée le rôle
   `nuera_runner` (sans connexion) et l'administration crée un rôle `nuera_env_…` par serveur (§13, §14). Le
   superutilisateur de la ressource PostgreSQL Coolify convient, et c'est le choix conseillé : seul un
   superutilisateur peut retirer aux autres rôles les verrous consultatifs (migration `0005`, §12.6) et fermer les
   connexions d'un rôle restreint sans droit supplémentaire. Sinon, il faut au moins `CREATEROLE` et
   `GRANT pg_signal_backend TO <utilisateur de DATABASE_URL>` (§12.6).
5. **PostgreSQL 15 ou plus récent** : la migration `0005_runner_scope` emploie `ON DELETE SET NULL (colonne)`.
   La ressource Coolify en PostgreSQL 17 convient.

## 4. Application (Docker Compose)

1. Coolify → *New resource* → **Docker Compose** depuis le dépôt, branche `main`, fichier `deploy/docker-compose.yml`
   (Coolify construit les trois images sur VPS-3 ; aucun registre n'est nécessaire).
2. Réseau : activer « Connect to predefined network » pour que `migrate`, `web` et `runner` joignent PostgreSQL.
3. Domaine : sur le service **web** uniquement, `https://dev.nuera.studio` (port 3000). **Aucun domaine pour `runner`**
   ni pour `migrate`.
4. Variables d'environnement (onglet *Environment Variables*, les secrets marqués *secret* / *locked*) :

| Variable | Service | Valeur |
|---|---|---|
| `DATABASE_URL` | tous | URL interne PostgreSQL (§3). Jamais donnée à un serveur supplémentaire |
| `APP_URL` | web, runner | `https://dev.nuera.studio` (cookies `__Secure-`, contrôle d'Origin, adresses de retour GitHub) |
| `RUNNER_TOKEN` | migrate, web, runner | **secret** — jeton du serveur par défaut, 32 octets aléatoires (`openssl rand -base64 32`) ; `migrate` n'en garde que l'empreinte |
| `BETTER_AUTH_SECRET` | web | **secret** — 32 octets aléatoires |
| `APP_ENCRYPTION_KEY` | web | **secret** — `openssl rand -base64 32` (32 octets, base64). **À sauvegarder hors du serveur** : sans elle, les secrets chiffrés (GitHub App, Coolify, MCP, variables de projet, jetons des serveurs) sont perdus |
| `SETUP_TOKEN` | web | **secret** — jeton de `/configuration` (création du propriétaire ; reprise d'un propriétaire sans double authentification, §12.5) ; **à retirer** une fois la double authentification du propriétaire activée (§5) |
| `TRUSTED_IP_HEADER` | web | `x-real-ip` (valeur par défaut du compose) : Traefik (Coolify) écrit l'adresse du client dans `X-Real-IP` ; c'est le seul en-tête d'IP pris en compte (journal de sécurité, limites de débit) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | web | **secret** (privée) — `npx web-push generate-vapid-keys` (notifications téléphone) |
| `VAPID_SUBJECT` | web | optionnel : `mailto:<adresse du propriétaire>` ou URL https (défaut : `APP_URL`) |
| `NUERA_SERVER_STATUS_URL` | web | optionnel : page d'état de l'hébergeur (https), proposée quand le serveur est injoignable |
| `PREVIEW_HOST` | web | optionnel : hôte de l'**Aperçu** (site en développement d'un worktree), par exemple `nuera-dev-apercu.perso.nuera.studio` ; un autre hôte que celui d'`APP_URL`, de préférence un sous-domaine du même domaine (cookie `SameSite=Lax`). Le même service `web` le sert : ajouter ce domaine au service **web** (voir « Aperçu » ci-dessous). Vide = aperçu désactivé, la raison s'affiche dans le Workspace |
| `GITHUB_FALLBACK_TOKEN` | web | optionnel, **secret** : PAT de secours (déconseillé), réservé à l'espace du serveur par défaut, jamais servi au MCP GitHub — laisser vide avec l'application GitHub |
| `NUERA_PRIVATE_HOSTS` | web | optionnel : hôtes privés que la garde des requêtes sortantes (serveurs MCP, Coolify) laisse quand même joindre, séparés par des virgules ; vide = aucun |
| `NUERA_WEB_SCHEDULER` | web | optionnel : `on` (défaut) — vérifications périodiques des intégrations ; `off` réservé aux tests |
| `NUERA_RUNNER_HOSTS` | web | optionnel : hôtes (ou `hôte:port`) autorisés pour l'adresse interne d'un serveur saisie dans l'administration, séparés par des virgules ; vide = tout hôte (http(s), sans identifiants). Conseillé dès le premier serveur supplémentaire, par exemple les noms `environment-runner-<uuid>` |
| `NUERA_RUNNER_DB_CONNECTION_LIMIT` | web | optionnel : plafond de connexions PostgreSQL (`CONNECTION LIMIT`) de chaque rôle restreint `nuera_env_…`, entre 4 et 500, défaut 20 ; posé à la création du rôle et à « Renouveler l'accès base restreint » (§12.6). Garder au moins `NUERA_DB_POOL_MAX` + 3 du runner concerné |
| `NUERA_PUSH_HOSTS` | web | optionnel : hôtes de services Web Push supplémentaires (`hôte` ou `*.domaine`), séparés par des virgules ; vide = FCM (Chrome), Mozilla, WNS (Edge) et Apple seulement. Un abonnement vers un autre hôte est refusé (422) et jamais contacté ; les hôtes `.test` ne sont acceptés qu'hors production |
| `RUNNER_DATABASE_URL` | runner | optionnel, **secret** : DSN restreint du serveur par défaut (§14) ; vide = `DATABASE_URL` |
| `NUERA_DB_POOL_MAX` | runner | optionnel : connexions PostgreSQL du runner (défaut 5, au plus 15) ; ses connexions se nomment `nuera-runner:<id du serveur>` quand `NUERA_ENVIRONMENT_ID` est posé (vérification « accès base restreint » du web) |
| `LOG_LEVEL` | web, runner | optionnel : `info` (défaut) |
| `RUNNER_CPUS` / `RUNNER_MEMORY` | runner | optionnel (défauts 6 CPU / `12g`) |
| `NUERA_IMAGE_TAG` | build | optionnel : étiquette des images construites (défaut `latest`, utile au retour arrière §8) |

À ne **jamais** définir : `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_GROWTHBOOK` (le point d'entrée du runner retire les quatre
premières par sécurité ; les deux dernières désactiveraient Remote Control), ni `NUERA_CLAUDE_CONFIG_DIR`
(développement et tests seulement : en production, chaque conteneur garde la connexion Claude dans son HOME). La
double authentification est obligatoire pour tous les comptes : aucune variable ne la désactive.

**Aperçu (`PREVIEW_HOST`)** : le code du projet prévisualisé n'est pas de confiance, il ne s'exécute donc jamais sur
l'origine de l'application. Dans Coolify, service **web** → *Domains* : ajouter, à côté de l'URL de l'application, le
domaine d'aperçu (séparés par une virgule, port 3000, certificat Let's Encrypt automatique), puis poser
`PREVIEW_HOST` au même nom (sans `https://`). Le web répond sur ce domaine uniquement par le relais de l'aperçu (aucune
page ni route de l'application) et l'application n'y sert rien d'autre. DNS : `*.perso.nuera.studio` couvre déjà
`nuera-dev-apercu.perso.nuera.studio` et `nuera-dev-staging-apercu.perso.nuera.studio`.

5. Déployer. Vérifier : `migrate` termine en succès (« Migrations appliquées. »), `web` et `runner` passent *healthy*
   (le premier démarrage du runner télécharge le CLI Claude Code : ~15 s, dans la marge de 90 s du healthcheck).

## 5. Première mise en service [propriétaire]

1. **Compte propriétaire** : ouvrir `https://dev.nuera.studio/configuration`, saisir `SETUP_TOKEN`, créer le compte
   (mot de passe sans le nom ni l'e-mail), enrôler la double authentification (application TOTP), **conserver les 8
   codes de secours**, puis éventuellement une clé d'accès. `/configuration` répond ensuite `404`.
   **Retirer `SETUP_TOKEN`** des variables Coolify et redéployer `web`.
2. **GitHub** : Intégrations → « Connecter GitHub » → GitHub crée l'application Nuera Dev par le **flux manifest**
   (aucun jeton saisi à la main, `docs/INTEGRATIONS.md` §2) → l'installer sur l'organisation `nuera-studio` et/ou le
   compte personnel, en choisissant **Only select repositories**.
3. **Claude Code** : Paramètres → Claude Code (« Déconnecté » sur une installation neuve) → « Se reconnecter dans un
   terminal » : le terminal Nuera lance la procédure officielle `claude auth login` (compte Claude, formule Max).
   Nuera Dev ne lit ni n'enregistre aucun identifiant ; la connexion vit dans le volume `nuera-claude-home`. C'est la
   connexion du propriétaire : personne d'autre ne l'utilise.
4. **Coolify (lecture seule)** : créer dans Coolify un jeton limité à l'équipe/environnement *Développement*, abilities
   `read` (et `read:sensitive` si besoin), **sans** `write`/`deploy` ; le saisir dans Intégrations → Coolify
   (`docs/INTEGRATIONS.md` §3). Un jeton qui expose des outils `manage_*`/`create_*` reste hors de portée de Claude.
5. **Notifications** : générer les clés VAPID (`npx web-push generate-vapid-keys`), les renseigner (§4), redéployer
   `web`, puis Paramètres → Notifications → activer sur le téléphone (PWA installée sur iOS).
6. **MCP** (optionnel) : Figma (`claude mcp login figma` dans le terminal proposé), Playwright.
7. Ajouter un premier projet (Projets → Ajouter un projet) et ouvrir le Workspace.
8. **Autres personnes** : chacune reçoit son propre compte par invitation (Administration › Comptes), avec double
   authentification obligatoire et son espace ; pour lancer des sessions Claude, il lui faut son propre serveur (§13).

## 6. Vérifications après déploiement

- `GET https://dev.nuera.studio/api/health` → `{"status":"ok","db":true,"version":"…"}`.
- Le runner n'est **pas** joignable depuis Internet : aucun port publié (`docker port <runner>` vide), pas de domaine.
  Idem pour chaque serveur supplémentaire.
- En-têtes : `Strict-Transport-Security`, `Content-Security-Policy`, `X-Frame-Options: DENY` sur toutes les pages.
- Liste de contrôle Claude Code sur VPS-3 (version, `claude auth status --json`, hooks, tmux, reprise après
  redémarrage) : `docs/research/claude-code.md` §15, et §11 ci-dessous.
- Redéployer `web` : les sessions tmux du runner continuent ; redéployer `runner` : sessions « Interrompue · reprise
  possible », reprise via `claude --resume`.

## 7. Claude Code dans le conteneur runner

- **Installation** : `deploy/docker/runner-entrypoint.sh` installe le binaire **officiel non modifié** (installateur
  natif `https://claude.ai/install.sh`, canal `stable`) dans le HOME persistant au premier démarrage, puis le CLI se
  met à jour par son propre mécanisme. Sans réseau, le runner démarre quand même et Nuera affiche « CLI absent ».
  Le runner démarre et répond sans que le CLI soit connecté (état « Déconnecté »).
- **Une connexion par serveur** : chaque serveur a son HOME (`nuera-claude-home` pour le serveur par défaut, volume
  `home` de chaque serveur supplémentaire), donc son CLI, ses conversations et la connexion Claude de la seule
  personne à qui il est attribué. Cette personne se connecte elle-même, avec son propre abonnement ; une connexion
  n'est jamais partagée, copiée d'un serveur à l'autre ni faite par un administrateur pour quelqu'un d'autre
  (`docs/research/claude-code.md` §1.3 et §14.3).
- **Version** : l'essai local du 2026-11-05 a reçu `2.1.311` sur le canal `stable`, alors que la liste de contrôle
  vise ≥ 2.1.317 (`docs/research/claude-code.md`). Vérifier la version sur VPS-3 (Paramètres → Claude Code →
  Vérifier) avant de s'appuyer sur `--remote-control` ou les champs récents de `claude auth status --json`.
- **Bac à sable du CLI (bubblewrap / seccomp)** : sur Linux, `/sandbox` du CLI s'appuie sur `bubblewrap` et `socat`
  (installés dans l'image). Essai local : avec le profil seccomp **par défaut** de Docker, `bwrap` échoue (« No
  permissions to create new namespace ») ; avec `seccomp=unconfined` il crée les espaces de noms mais ne peut monter
  `/proc` que si `systempaths=unconfined` est aussi donné. Choix par défaut : **bac à sable du CLI désactivé**, la
  frontière est le conteneur runner (non-root, `no-new-privileges`, limites, aucun socket Docker, aucun secret
  applicatif dans l'environnement des sessions). Pour l'activer, il faudrait un profil seccomp personnalisé
  autorisant `unshare`/`clone(CLONE_NEWUSER)` (plutôt que `unconfined`) et `systempaths=unconfined` sur `runner`
  seulement — à évaluer sur VPS-3, cela affaiblit l'isolement du conteneur.
- **Remote Control** : option par session (`--remote-control`) ; demande un CLI connecté à un compte Pro/Max et un
  accès sortant vers Anthropic depuis VPS-3. Non testé localement (CLI non connecté).

## 8. Mises à jour et retour arrière

- **Mise à jour** : push sur `main` → redéploiement Coolify de la ressource principale. `migrate` applique les
  nouvelles migrations (Drizzle, jamais destructives par convention) avant le redémarrage de `web` et `runner`. Les
  serveurs supplémentaires (ressources séparées) se redéploient ensuite (§13), sans attendre : un runner restreint
  plus ancien que `0005` ne reprend pas son bail (§12.6).
- Avant chaque push sur `main` : sauvegarde de la base (`backup-db.sh` ou sauvegarde Coolify à la demande), aucune
  session Claude en cours, suites complètes vertes avec PostgreSQL exigé
  (`pnpm typecheck && pnpm lint && NUERA_REQUIRE_PG=1 pnpm test`).
- **Retour arrière** : Coolify → *Deployments* → redéployer le commit précédent (ou fixer `NUERA_IMAGE_TAG` sur
  l'étiquette précédente si les images sont conservées). Si la version précédente ne lit pas le schéma migré :
  arrêter `web`/`runner` (et les serveurs supplémentaires), recréer la base **vide** puis y restaurer la sauvegarde
  prise avant la mise à jour (§12.4 ; `pg_restore --clean` ne retire pas les tables créées depuis la sauvegarde),
  redéployer l'ancien commit.
- **CLI Claude Code** : mis à jour par son mécanisme officiel (Paramètres → Claude Code → Vérifier), jamais pendant une
  session. Les volumes ne sont jamais supprimés par un redéploiement ; ne jamais utiliser `down -v` en production.
- **Rotation de `APP_ENCRYPTION_KEY`** : `docs/SECURITY.md` §5.

## 9. Sauvegardes et restauration

- **Base** : sauvegardes planifiées Coolify (§3) et/ou `deploy/scripts/backup-db.sh` (pg_dump format custom,
  compression 9, fichiers `0600`, rotation des 14 dernières, `BACKUP_KEEP` pour changer). Les deux scripts ont besoin
  de `pg_dump`/`pg_restore` ≥ 17 : les lancer dans l'image `postgres:17-bookworm` sur le réseau de la base :

```bash
docker run --rm --network <réseau de la base> -v "$PWD/deploy/scripts:/scripts:ro" -v /srv/backups:/backups \
  -e DATABASE_URL='postgres://…' postgres:17-bookworm sh /scripts/backup-db.sh /backups
```

- **Restauration** : arrêter `web`, `runner` **et chaque serveur supplémentaire** (tous écrivent dans la base), puis
  `restore-db.sh <fichier.dump>` (demande de taper `RESTAURER`, ou `RESTORE_CONFIRM=RESTAURER` en non interactif ;
  `pg_restore --clean --if-exists --single-transaction`), redémarrer, vérifier `/api/health`.
- **Rôles des serveurs** : les rôles PostgreSQL (`nuera_runner`, `nuera_env_…`) appartiennent au serveur PostgreSQL,
  pas à la base. `backup-db.sh` sauvegarde sans les droits et `restore-db.sh` ne les restaure pas
  (`--no-privileges`), mais les politiques de cloisonnement par ligne (RLS), qui nomment le rôle `nuera_runner`,
  sont bien sauvegardées et restaurées. Pour une sauvegarde postérieure à la version multi-comptes :
  - sur le **même** serveur PostgreSQL, les rôles existent encore mais n'ont plus aucun droit sur les tables
    restaurées : les serveurs à accès restreint (« VPS-3 » compris après le §14) échouent (« permission denied »)
    tant que les instructions `REVOKE` et `GRANT` de `packages/db/drizzle/0004_runner_roles.sql` ne sont pas
    rejouées (pas le fichier entier : ses politiques existent déjà). Rejouer aussi, en superutilisateur, le bloc
    `DO $$ … $$` (étape 4) et les quatre dernières instructions `REVOKE`/`GRANT` (étape 5) de
    `0005_runner_scope.sql` : sans elles, les verrous consultatifs redeviennent ouverts à tous les rôles et
    `nuera_runner_try_lease()` exécutable par tous (sans danger : elle ne rend `false` qu'à un rôle sans serveur) ;
  - sur un **nouveau** serveur PostgreSQL, créer le rôle `nuera_runner` **avant** de restaurer
    (`CREATE ROLE nuera_runner NOLOGIN;`) : sans lui, la restauration échoue entièrement (une seule transaction).
    Rejouer ensuite ces mêmes droits ; les rôles `nuera_env_…` n'existent pas, l'accès restreint de chaque serveur
    est à refaire (§13, §14).
- **Hors base** : `APP_ENCRYPTION_KEY` (gestionnaire de mots de passe) ; volumes de projets (`nuera-projects`,
  `nuera-server-<slug>-projects`) : le travail non poussé n'existe que là, pousser régulièrement.
- **Jamais** le volume HOME d'un serveur en bloc (`nuera-claude-home`, `nuera-server-<slug>-home`) : il contient
  `~/.claude/.credentials.json` et `~/.claude.json`, qui portent la connexion Claude de la personne et ne sont jamais
  sauvegardés, copiés ni lus par Nuera Dev. Après une perte, la personne refait `claude auth login` dans son terminal.

## 10. Essai local (Docker, sans serveur réel)

Fichiers réservés à l'essai : `deploy/docker-compose.test.yml` (ajoute PostgreSQL au compose, publie `web` sur
`127.0.0.1:3510`, remplace GitHub par un dossier de dépôts nus monté **en lecture seule**),
`deploy/scripts/test-env.mjs` (écrit `deploy/.env.test`, git-ignoré, secrets aléatoires) et
`deploy/scripts/smoke-test.mjs` (parcours navigateur). Commandes exécutées le 2026-11-05 (Docker 29.9, Compose 5.6) :

```bash
# 1. Images (derrière un proxy TLS : --network host, certificat racine en secret BuildKit, proxy pour next/font)
B="--network host --secret id=build_ca,src=/root/.ccr/ca-bundle.crt --build-arg HTTPS_PROXY=$HTTPS_PROXY --build-arg NO_PROXY=$NO_PROXY"
docker build $B -f deploy/docker/web.Dockerfile --target runtime -t nuera-dev-web:test .
docker build $B -f deploy/docker/web.Dockerfile --target migrate -t nuera-dev-migrate:test .
docker build $B -f deploy/docker/runner.Dockerfile -t nuera-dev-runner:test .
#    (sans proxy : docker build -f … suffit ; le contexte de build venait de `git archive HEAD` + deploy/)

# 2. Environnement jetable et démarrage (dépôts nus : <dossier>/nuera-studio/demo.git, appartenant à l'uid 1001)
node deploy/scripts/test-env.mjs --port 3510 --remotes /chemin/remotes --ca /root/.ccr/ca-bundle.crt
C="docker compose -p nuera-deploy-test --env-file deploy/.env.test -f deploy/docker-compose.yml -f deploy/docker-compose.test.yml"
$C up -d --no-build --wait --wait-timeout 300

# 3. Parcours de fumée (Chromium préinstallé des tests e2e)
node deploy/scripts/smoke-test.mjs --env deploy/.env.test --chromium /opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell

# 4. Clone d'un dépôt nu local : ligne `projects` (status cloning) puis POST http://runner:4100/v1/repos/clone
#    depuis le conteneur web (seul à joindre le runner) ; 5. persistance : $C down && $C up -d --wait ;
# 6. sauvegarde/restauration : backup-db.sh puis restore-db.sh dans postgres:17-bookworm (§9) ;
$C down -v   # 7. fin : conteneurs ET volumes de l'essai supprimés
```

Résultats : `migrate` « Migrations appliquées. » ; `web` et `runner` *healthy* en ~15 s ; `/api/health` →
`{"status":"ok","db":true}` ; `/configuration` avec `SETUP_TOKEN` crée le propriétaire (TOTP, 8 codes de secours)
puis répond `404` ; déconnexion puis connexion mot de passe + TOTP ; shell chargé (« Claude Code déconnecté » dans la
barre latérale, CPU/RAM du conteneur) ; Paramètres → Claude Code « Déconnecté » ; terminal `claude-status` ouvert par
le runner (`alive: true`) puis fermé (`204`) ; aucun `~/.claude/.credentials.json` créé ; clone
`file:///srv/remotes/nuera-studio/demo.git` → opération `succeeded`, projet `ready` ; écriture refusée dans les dépôts
montés (« Read-only file system ») ; runner sans port publié, `401` sans jeton, injoignable depuis un conteneur hors
du réseau interne (`ENOTFOUND`) ; `web` en `node`, racine en lecture seule, `CapDrop=[ALL]`, aucun montage ;
après `down`/`up` : clone, fichiers de `/data` et du HOME conservés, CLI non réinstallé, compte toujours présent ;
sauvegarde 64 Ko, refus de restauration sans `RESTAURER`, restauration après suppression des lignes → compte, projet
et journal des migrations rétablis, services de nouveau *healthy*.

Cet essai date d'avant la version multi-comptes : il n'a couvert ni les migrations 0001–0005, ni le nouveau point
d'entrée du runner, ni `deploy/docker-compose.runner.yml`.

## 11. Testé localement / reste à vérifier sur VPS-3

| Sujet | Essai local (Docker) | À vérifier sur VPS-3 [propriétaire] |
|---|---|---|
| Build des trois images, utilisateurs non-root, `.dockerignore` | oui | build par Coolify (sans proxy) |
| `migrate`, healthchecks, réseau interne, volumes persistants | oui | idem avec la ressource PostgreSQL Coolify et le réseau prédéfini |
| `/configuration`, TOTP, connexion, shell, Paramètres | oui, en `http://localhost` | en HTTPS derrière Traefik (`__Secure-`, HSTS, `x-real-ip` dans le journal de sécurité) |
| CLI officiel installé, « Déconnecté », terminal `claude-status` | oui (CLI 2.1.311, non connecté) | `claude auth login` réel, version ≥ 2.1.317, mises à jour automatiques |
| Backend tmux avec le **vrai** CLI connecté (sessions, reprise `--resume`) | non (seul le démarrage du backend tmux est vérifié) | oui |
| Hooks (`PermissionRequest`, `Stop`…) et status line du vrai CLI | non | oui |
| Remote Control | non | oui |
| Bac à sable `/sandbox` (bubblewrap) | `bwrap` refusé sous le seccomp par défaut (§7) | décision : désactivé ou profil seccomp dédié |
| Clone GitHub (application GitHub, jetons d'installation) | non (dépôt nu local seulement) | oui |
| Notifications Web Push | non | oui (clés VAPID, téléphone) |
| Sauvegarde/restauration | oui (`pg_dump`/`pg_restore` 17) | sauvegardes planifiées Coolify + essai de restauration |
| Mise à jour multi-comptes : `migrate` 0001–0005 sur la base existante, empreinte de `RUNNER_TOKEN` | non (aucun Docker sur le poste de préparation) | oui (§12) |
| Point d'entrée du runner : PID 1 cédé à `tini`, `RUNNER_DATABASE_URL` substituée à `DATABASE_URL` | non (logique du script vérifiée hors conteneur, sous `sh`) | oui (§14) |
| Serveur supplémentaire : build par une seconde ressource, noms réels des volumes et du conteneur, réseau prédéfini, appels `web` ⇄ `environment-runner` | non | oui (§13) |
| Lien de récupération de secours (`docker compose run --rm … migrate …` dans le dossier de la ressource Coolify) | non | oui (§12.5) |
| Suite tmux du runner (`apps/runner/test/tmux.test.ts`, dont la non-adoption d'une session d'un autre serveur) | non (ignorée sous Windows) | oui, sous Linux avec tmux, **avant** la mise à jour |
| Rôle restreint en production : `0004` avec le superutilisateur Coolify, création d'un `nuera_env_…`, runner restreint (§14) | non | oui |
| `0005` en production : aucun `WARNING` « sans superutilisateur » dans le journal de `migrate`, bail du runner restreint par `nuera_runner_try_lease()`, plafond de connexions et délais du rôle (`\du+`), fermeture des connexions au retrait (§12.6) | non | oui |

En production, seules les vérifications de la dernière section ont été faites.

## 12. Mise à jour vers la version multi-comptes

La ressource Coolify principale ne change pas de forme (mêmes services `migrate`, `web`, `runner`, mêmes volumes, même
réseau) : la mise à jour se fait par un simple push, sans variable à ajouter. Le runner existant devient le **serveur
par défaut** de l'espace du propriétaire, sous le nom affiché aujourd'hui (« VPS-3 » par défaut).

### 12.1 Avant de pousser [propriétaire]

1. **Double authentification du propriétaire** : elle redevient obligatoire pour tous les comptes. Si Coolify contient
   `NUERA_REQUIRE_2FA=false` et que le compte ne l'a jamais activée : se connecter, ouvrir
   `/configuration/double-facteur`, l'activer (application TOTP) et **conserver les 8 codes de secours**. Si la
   mise à jour est déjà faite sans cette étape : §12.5.
2. **Un compte = une personne** : si plusieurs personnes utilisaient le compte du propriétaire, chacune recevra son
   propre compte par invitation après la mise à jour. La connexion Claude du serveur « VPS-3 » reste celle du
   propriétaire seul ; une autre personne lance ses sessions sur son propre serveur (§13).
3. **Sauvegarde** de la base avec `deploy/scripts/backup-db.sh` (commande du §9), fichier copié hors du serveur. C'est
   le seul retour arrière possible (§12.4).
4. **Aucune session Claude en cours** : les arrêter (elles restent reprenables). Le runner est recréé par le
   déploiement, et la migration attend 10 s au plus les verrous des tables qu'il écrit. Ne pas utiliser Nuera Dev
   pendant le déploiement : entre la fin de la migration et le redémarrage de `web` et `runner`, l'ancienne version
   ne peut plus créer de lignes (projets, sessions, opérations).
5. Suites complètes vertes avec PostgreSQL exigé (§8), puis **push sur `main`**.

### 12.2 Ce que fait le déploiement

Coolify reconstruit les trois images, puis `migrate` applique, dans une seule transaction (un échec n'en laisse
aucune trace) :

1. `0001_tenancy_expand` : nouvelles tables (espaces, membres, serveurs, invitations, réglages d'espace, préférences,
   sources GitHub), nouvelles colonnes encore facultatives, index `user_single_owner_idx` (un seul compte) remplacé
   par `user_owner_idx` (un seul propriétaire, plusieurs comptes). Si un verrou n'est pas obtenu en 10 s, `migrate`
   échoue sans rien modifier et les anciens conteneurs continuent de servir : relancer le déploiement.
2. `0002_tenancy_backfill` : un espace personnel par compte existant (le plus ancien devient propriétaire), réglages
   et préférences repris des réglages actuels, **serveur par défaut** (relié à `RUNNER_URL`/`RUNNER_TOKEN`, nom, lieu
   et limites repris des réglages), rattachement de toutes les lignes existantes (projets, worktrees, sessions,
   événements, autorisations, lancements, opérations, intégrations, MCP, notifications, journal), sources GitHub
   reprises de l'intégration GitHub.
3. `0003_tenancy_enforce` : colonnes obligatoires, unicités par serveur, clés étrangères composites.
4. `0004_runner_roles` : rôle `nuera_runner` (sans connexion), fonction d'identification, droits minimaux et
   cloisonnement par ligne (RLS) pour les rôles restreints des serveurs (§13, §14).
5. `0005_runner_scope` : une session, une opération ou un lancement ne peut plus désigner le worktree ou la session
   d'un autre serveur (clés étrangères composites ; une référence croisée existante est d'abord effacée) ; verrous
   consultatifs retirés à `PUBLIC` et bail des rôles restreints par `nuera_runner_try_lease()` (§12.6). Attente des
   verrous de tables : 10 s au plus, comme `0001`.

Puis `migrate` enregistre l'**empreinte** SHA-256 de `RUNNER_TOKEN` sur le serveur par défaut (le jeton lui-même n'est
jamais stocké). `web` et `runner` redémarrent ensuite : le runner retrouve son serveur par cette empreinte, ses
volumes et la connexion Claude du propriétaire sont intacts.

### 12.3 Vérifications

1. Coolify : `migrate` termine en succès (« Migrations appliquées. », précédé de la ligne qui confirme
   l'enregistrement de l'empreinte du jeton), `web` et `runner` passent *healthy*. Un avertissement « Aucun serveur
   par défaut » dans ce journal est anormal (la migration crée toujours ce serveur) : ne pas aller plus loin.
2. `GET /api/health` → `{"status":"ok","db":true,…}`.
3. Le propriétaire se connecte (mot de passe puis code TOTP) ; projets, historique des sessions, intégrations et
   réglages sont intacts ; Paramètres → Claude Code montre la même connexion qu'avant.
4. Administration › Serveurs : « VPS-3 », serveur par défaut, répond. L'avertissement « Le serveur VPS-3 accède encore
   à toute la base de données. » est attendu jusqu'au §14.
5. Supprimer `NUERA_REQUIRE_2FA` des variables Coolify : elle n'est plus lue.

### 12.4 Retour arrière

Retour arrière = restaurer la sauvegarde d'avant la mise à jour **et** redéployer l'image précédente. Ne jamais
redéployer l'ancien commit sur la base migrée : l'ancienne version ne connaît ni les espaces ni les serveurs (ses
insertions sont refusées) et, avec plusieurs comptes, prendrait un compte au hasard pour propriétaire.

1. Coolify : couper le déploiement automatique de la ressource principale, l'arrêter, ainsi que chaque serveur
   supplémentaire éventuel.
2. Facultatif : sauvegarder l'état actuel (`backup-db.sh`) pour l'analyse.
3. Recréer la base **vide** (`pg_restore --clean` ne supprime pas les tables créées par 0001–0005, dont les clés
   étrangères bloqueraient le remplacement des anciennes) :

```bash
docker run --rm --network <réseau de la base> postgres:17-bookworm \
  psql 'postgres://<utilisateur>:<mot de passe>@<hôte>:5432/postgres' -v ON_ERROR_STOP=1 \
  -c 'DROP DATABASE "<base>" WITH (FORCE);' -c 'CREATE DATABASE "<base>";'
```

4. Restaurer la sauvegarde prise au §12.1 avec `restore-db.sh` (§9).
5. Redéployer le commit d'avant la mise à jour (Coolify → *Deployments*), avec les variables Coolify telles qu'elles
   étaient avant, puis vérifier `/api/health` et la connexion.
6. Corriger le problème, puis reprendre au §12.1 (nouvelle sauvegarde) avant de réactiver le déploiement automatique.

Les comptes, serveurs et données créés depuis la mise à jour sont perdus. Les rôles PostgreSQL créés entre-temps
(`nuera_runner`, `nuera_env_…`) restent sur le serveur PostgreSQL, sans aucun droit sur la base restaurée : les garder
ou les supprimer (`DROP ROLE`).

### 12.5 Propriétaire sans double authentification après la mise à jour

La connexion par mot de passe seul est refusée. Deux voies :

- **`SETUP_TOKEN`** : tant qu'aucun propriétaire n'a de double authentification, `/configuration` reprend la
  configuration du propriétaire avec ce jeton. Le remettre dans Coolify s'il a été retiré, redéployer `web`, terminer
  l'activation, puis le retirer de nouveau.
- **Lien de récupération (secours)** : la commande `recovery-link` de `packages/db` (`docs/MULTICOMPTE.md` §6 ; en
  développement : `pnpm --filter @nuera/db cli recovery-link --email …`). En production, sur le serveur, dans le
  dossier où Coolify a écrit le `docker-compose.yaml` et le `.env` de la ressource principale (en général
  `/data/coolify/applications/<uuid>`), avec l'image `migrate`. Celle-ci ne reçoit pas `APP_URL` : la passer
  (sinon la commande s'arrête sans rien faire) ; `tsx` est appelé directement, `pnpm` n'étant pas préparé pour
  l'utilisateur `node` de l'image :

```bash
docker compose run --rm -e APP_URL=<APP_URL de la ressource> migrate \
  node_modules/.bin/tsx src/cli/recovery-link.ts --email <e-mail du propriétaire>
```

  Elle réinitialise la double authentification du compte, ferme ses accès web et retire ses appareils de confiance
  (ses clés d'accès restent, sauf avec `--remove-passkeys` si l'appareil qui les porte est perdu), puis affiche une
  seule fois un lien `/recuperation/<jeton>` valable 24 h, à usage unique : nouveau mot de passe, puis double
  authentification. Non essayée en production (§11).

### 12.6 Durcissement du cloisonnement (migration 0005, rôles restreints, tmux, push)

À vérifier à la mise à jour qui apporte `0005_runner_scope`, puis à garder en tête pour chaque serveur.

1. **Verrous consultatifs** : `0005` ne les retire aux autres rôles que si `DATABASE_URL` est superutilisateur ;
   sinon elle émet le `WARNING` « Nuera Dev : migration 0005 sans superutilisateur, les verrous consultatifs restent
   ouverts à tous les rôles. » et continue. Contrôle : `SELECT has_function_privilege('public',
   'pg_catalog.pg_try_advisory_lock(bigint)', 'EXECUTE');` doit rendre `false`. Sinon, rejouer en superutilisateur le
   bloc `DO $$ … $$` (étape 4) de `packages/db/drizzle/0005_runner_scope.sql` : tant que ce n'est pas fait, une
   session Claude d'un serveur restreint peut prendre le verrou de `migrate` (déploiements bloqués) ou le bail d'un
   autre serveur.
2. **Runners à jour ensemble** : après `0005` (en superutilisateur), un runner **restreint** d'une version antérieure
   se voit refuser son bail (« permission denied ») et reste en attente. Redéployer chaque serveur supplémentaire
   avec la nouvelle image juste après la ressource principale (§13 « Redéploiements »). L'inverse est sans risque :
   un runner récent contre une base encore en `0004` prend son bail par l'appel direct.
3. **Plafond et délais des rôles restreints** : un rôle `nuera_env_…` créé (ou dont l'accès est renouvelé) par cette
   version reçoit `CONNECTION LIMIT` (`NUERA_RUNNER_DB_CONNECTION_LIMIT`, défaut 20), `statement_timeout = 2min` et
   `idle_in_transaction_session_timeout = 1min`. Un rôle créé avant ne les a pas : « Renouveler l'accès base
   restreint » (nouveau DSN, point 5), ou en SQL, pour chaque rôle de `environments.db_role` :
   `ALTER ROLE "nuera_env_…" CONNECTION LIMIT 20; ALTER ROLE "nuera_env_…" SET statement_timeout = '2min';
   ALTER ROLE "nuera_env_…" SET idle_in_transaction_session_timeout = '1min';`. Garder la limite au moins égale à
   `NUERA_DB_POOL_MAX` + 3 du runner (pool, connexion du bail, marge), sinon il reçoit « too many connections for
   role ».
4. **Fermeture des connexions** : retirer un serveur, supprimer un compte ou renouveler l'accès restreint ferme, après
   l'écriture, les connexions encore ouvertes du rôle (`pg_terminate_backend`). Il faut un superutilisateur ou
   `GRANT pg_signal_backend TO <utilisateur de DATABASE_URL>` (`CREATEROLE` seul ne suffit pas depuis PostgreSQL 16).
   Sans ce droit, rien n'échoue : le journal d'instance ajoute « … connexion(s) à la base encore ouverte(s) :
   PostgreSQL refuse de les fermer » ; les fermer à la main :
   `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'nuera_env_…';`.
5. **« Renouveler l'accès base restreint »** ferme aussitôt les connexions de l'ancien DSN : le runner perd la base
   jusqu'à son redéploiement avec la nouvelle `RUNNER_DATABASE_URL`. Le faire sans session en cours.
6. **Adresse d'un serveur** : changer l'adresse interne d'un serveur en service remplace son jeton (affiché une fois,
   l'ancien est refusé aussitôt) : le mettre dans `RUNNER_TOKEN` de sa ressource et redéployer. L'adresse d'un serveur
   d'un autre compte ne se change que par le propriétaire de l'instance, avec son mot de passe ; le compte est
   prévenu. Deux serveurs en service ne partagent jamais une adresse (409 « Cette adresse est déjà celle du serveur
   « … ». »), `RUNNER_URL` du serveur par défaut comprise.
7. **« Accès base restreint »** : l'avertissement « Le serveur … accède encore à toute la base de données. » ne
   disparaît que si PostgreSQL le confirme (rôle de `environments.db_role` qui se connecte, sans superutilisateur ni
   `BYPASSRLS`, membre de `nuera_runner`, sans les droits du propriétaire des tables ; pour le serveur par défaut,
   aucune connexion `nuera-runner…` visible sur un rôle qui ne soit pas un rôle restreint vérifié), plus seulement
   d'après le battement du runner.
8. **tmux** : chaque serveur a son propre socket (`nuera` pour le serveur par défaut, inchangé ; `nuera-<8 hex de
   l'id>` pour les autres) et un runner ne rattache une session tmux que si son `NUERA_SESSION_ID` est celui de la
   ligne (sinon la ligne passe « Interrompue » et la session tmux est laissée en place). Rien à faire en production
   (un conteneur par serveur) ; ne jamais donner le même `NUERA_TMUX_SOCKET` à deux runners d'une machine. Suite
   `apps/runner/test/tmux.test.ts` à lancer sous Linux avant la mise à jour (§11).
9. **Notifications push** : un abonnement ne reçoit plus rien une fois fermé l'accès web qui l'a créé (déconnexion,
   révocation, 12 h d'inactivité par défaut, 30 jours au plus) ; après une nouvelle connexion, réactiver dans
   Paramètres › Notifications. Seuls les services push connus sont contactés (`NUERA_PUSH_HOSTS` pour en ajouter).
   Les abonnements antérieurs à la version multi-comptes (sans accès lié) continuent de recevoir jusqu'à leur retrait.

## 13. Ajouter un serveur (environnement d'exécution)

Un serveur supplémentaire est une **ressource Coolify séparée**, construite depuis `deploy/docker-compose.runner.yml`
(un seul service `environment-runner`, ses propres volumes, aucun domaine ni port). Il est attribué à **une seule
personne**, qui s'y connecte à Claude Code avec son propre abonnement. Ce fichier ne sert jamais au serveur par défaut.

**Capacité.** Prévoir par serveur environ 2 vCPU et 4 Go de mémoire (minimum de Claude Code :
`docs/research/claude-code.md` §9) et au moins 20 Go de disque. NUERA-PERSO-01 (6 cœurs, 11,4 Go, qui héberge aussi
d'autres sites ; le serveur par défaut y est limité à 4 CPU / 6 Go) porte raisonnablement **deux serveurs** en tout :
le serveur par défaut et un serveur supplémentaire (`RUNNER_CPUS=2`, `RUNNER_MEMORY=4g`, quitte à réduire le premier).
Au-delà, une machine plus grande : un serveur doit tourner sur la même machine que la ressource principale (réseau
prédéfini de Coolify). Les volumes Docker n'ont pas de quota : un serveur peut remplir le disque de tous, PostgreSQL
compris ; surveiller l'espace libre. Chaque runner ouvre jusqu'à `NUERA_DB_POOL_MAX` connexions PostgreSQL, plus une
connexion dédiée à son bail ; son rôle restreint est plafonné à `NUERA_RUNNER_DB_CONNECTION_LIMIT` connexions (20 par
défaut, §12.6), si bien qu'un serveur ne peut pas épuiser `max_connections` de toute l'instance.

Étapes [propriétaire ou administrateur] :

1. **Coolify** : *New resource* → **Docker Compose** depuis le même dépôt, branche `main`, dossier de base `/deploy`,
   fichier `/docker-compose.runner.yml`. Activer « Connect to predefined network » ; **aucun domaine**. Couper le
   déploiement automatique (voir la fin de la section). Ne pas déployer encore : noter l'identifiant (UUID) de la
   ressource ; le conteneur s'appellera en principe `environment-runner-<uuid>` (à confirmer à l'étape 4).
2. **Nuera** : Administration › Serveurs › « Ajouter un serveur » (nom, lieu, adresse interne
   `http://environment-runner-<uuid>:4100` ; si `NUERA_RUNNER_HOSTS` est définie sur `web`, l'hôte doit y figurer ;
   une adresse déjà prise par un serveur en service est refusée).
   Nuera affiche **une seule fois** le jeton du serveur et son DSN restreint (rôle `nuera_env_…`) : les copier aussitôt
   dans la ressource Coolify. Le serveur reste `pending` (jamais utilisé) jusqu'à son attribution.
3. **Coolify** : variables de la ressource (les secrets marqués *secret* / *locked*) :

| Variable | Valeur |
|---|---|
| `RUNNER_TOKEN` | **secret** — jeton affiché à l'étape 2 |
| `RUNNER_DATABASE_URL` | **secret** — DSN restreint affiché à l'étape 2 ; jamais le `DATABASE_URL` de l'instance |
| `APP_URL` | même valeur que la ressource principale |
| `NUERA_WEB_INTERNAL_URL` | `http://<conteneur web>:3000` : nom réel du conteneur `web` de la ressource principale (`docker ps` ; en principe `web-<uuid de la ressource principale>`), joignable sur le réseau prédéfini |
| `NUERA_SERVER_SLUG` | nom court en minuscules, chiffres et tirets, **unique et jamais réutilisé** (par exemple le prénom et les 8 caractères hexadécimaux du rôle `nuera_env_…`) : il nomme les volumes |
| `NUERA_ENVIRONMENT_ID` | optionnel : identifiant du serveur (Administration) ; s'il ne correspond pas au jeton, le runner refuse de démarrer |
| `RUNNER_CPUS` / `RUNNER_MEMORY` | optionnel : mêmes défauts que le serveur par défaut (6 / `12g`) ; sur NUERA-PERSO-01, `2` / `4g` |
| `NUERA_DB_POOL_MAX` / `LOG_LEVEL` | optionnel : `5` / `info` |

   Ne jamais y mettre `DATABASE_URL`, `BETTER_AUTH_SECRET`, `APP_ENCRYPTION_KEY`, `SETUP_TOKEN`, `VAPID_*`,
   `GITHUB_FALLBACK_TOKEN`, ni les variables interdites du §4.
4. **Coolify** : déployer. Le premier démarrage installe le CLI officiel dans le HOME du serveur (~15 s). Tant que
   Nuera ne reconnaît pas son jeton, le runner attend (santé seule) et réessaie toutes les 15 s. Vérifier les noms
   réels du conteneur et des volumes (`docker ps`, `docker volume ls`) et, depuis le conteneur, l'accès au web :
   `docker exec environment-runner-<uuid> curl -fsS http://web-<uuid principal>:3000/api/health`. Si le conteneur
   porte un autre nom que celui saisi à l'étape 2, corriger l'adresse interne sur la fiche du serveur.
5. **Nuera** : « Vérifier » sur la fiche du serveur : il doit répondre.
6. **Attribuer** le serveur à un compte : à l'invitation (Administration › Comptes) ou plus tard depuis sa fiche.
7. **La personne** : accepte l'invitation (mot de passe, double authentification obligatoire), puis Paramètres →
   Claude Code → « Se reconnecter dans un terminal » : `claude auth login` avec **son propre** compte Claude, dans le
   terminal de **son** serveur. Une personne = une connexion Claude, jamais partagée (conditions d'Anthropic :
   `docs/research/claude-code.md` §1.3 et §14.3) ; un administrateur ne se connecte jamais à la place d'une autre
   personne. Ensuite : ses sources GitHub (Intégrations) et ses connexions MCP (`claude mcp login figma` dans son
   terminal).

**Redéploiements.** Avec le déploiement automatique, chaque push sur `main` redémarrerait ce serveur en même temps que
la ressource principale (sessions interrompues, et démarrage possible avant la fin des migrations). Le couper, et
redéployer le serveur à la main une fois la ressource principale à jour, après avoir prévenu la personne (ses
sessions en cours seront interrompues, reprise possible).

**Renouveler le jeton d'un serveur supplémentaire.** Administration › Serveurs › la fiche → « Renouveler le jeton » :
le nouveau jeton est affiché une fois et les deux jetons valent en attendant. Le mettre dans `RUNNER_TOKEN` de la
ressource Coolify, redéployer le serveur, puis « Vérifier » : le premier appel réussi avec le nouveau jeton le promeut
(journal `environment.token_promoted`) et l'ancien cesse de fonctionner ; un rappel du runner fait avec le nouveau
jeton, ou un appel du web qu'il accepte, le promeut aussi. Le compte du serveur est prévenu du renouvellement. Changer
l'adresse interne d'un serveur en service renouvelle aussi son jeton (§12.6). Le serveur par défaut, lui, change de jeton
par `RUNNER_TOKEN` dans la ressource principale (`migrate`, `web` et `runner` ensemble ; `migrate` met l'empreinte à
jour).

**Retirer un serveur.** Un serveur déjà utilisé n'est jamais réattribué ; le serveur par défaut ne se retire pas, et un
serveur qui porte encore des projets actifs non plus. La personne pousse son travail ; **arrêter ses sessions avant le
retrait** (désactiver le compte en cochant « Arrêter aussi ses sessions Claude Code en cours ») : une fois le serveur
retiré, son runner repasse en attente et ne peut plus arrêter ses sessions tmux. Administration › Serveurs → retirer
le serveur (son rôle PostgreSQL passe NOLOGIN et ses connexions ouvertes sont fermées, §12.6) ; puis supprimer la ressource Coolify **avec ses volumes** (clones,
données, connexion Claude). Pour la même personne ou une autre : un nouveau serveur, avec un nouveau
`NUERA_SERVER_SLUG`.

**Désactiver, supprimer un compte.** Administration › Comptes. Désactiver suspend aussi son serveur (aucun nouveau
travail, rappels refusés) ; supprimer (seulement un compte désactivé) archive l'espace, retire le serveur et arrête les
sessions encore vivantes ; les dépôts GitHub ne sont jamais touchés.

## 14. Restreindre l'accès du serveur par défaut à la base

Les sessions Claude, les terminaux et les commandes de projet tournent sous l'utilisateur du runner : ils peuvent lire
son environnement. Les serveurs supplémentaires n'y trouvent que leur DSN restreint (§13). Le serveur par défaut, lui,
garde le DSN complet de l'instance (accès à tous les espaces) jusqu'à cette étape ; tant qu'elle n'est pas faite,
l'administration affiche « Le serveur VPS-3 accède encore à toute la base de données. ».

1. Aucune session Claude en cours sur « VPS-3 ».
2. Administration › Serveurs › « VPS-3 » : créer son accès restreint à la base ; le DSN (rôle `nuera_env_…`) est
   affiché une seule fois.
3. Coolify, ressource principale : renseigner la variable `RUNNER_DATABASE_URL` (créée vide par la mise à jour) avec
   ce DSN et la marquer **secrète**. Ne pas toucher à `DATABASE_URL` : `migrate` et `web` en ont besoin.
4. Redéployer. Le point d'entrée du runner substitue `RUNNER_DATABASE_URL` à `DATABASE_URL` avant de lancer `tini` et
   le runner : le DSN complet n'est plus dans l'environnement d'aucun processus durable du conteneur (runner, tmux,
   sessions, terminaux).
5. Vérifier : « VPS-3 » répond, l'avertissement a disparu, une session démarre.

Limite : la ressource principale fournit toujours `DATABASE_URL` au conteneur `runner` (variables communes). Il reste
dans la configuration Docker du conteneur, donc dans l'environnement des processus que Docker y lance lui-même
(healthcheck toutes les 30 s, `docker exec`) le temps de leur exécution, sous le même utilisateur que les sessions.
Un processus du conteneur qui surveille `/proc` peut donc encore le lire : cette étape réduit l'exposition du
serveur par défaut, elle ne la supprime pas. Les serveurs supplémentaires, eux, ne reçoivent jamais ce DSN. Ne pas
laisser de `docker exec` ouvert dans le runner.

Retour arrière : vider `RUNNER_DATABASE_URL` et redéployer ; le runner reprend `DATABASE_URL`. Un DSN erroné empêche
le runner de joindre la base : même remède.

Ne pas activer `log_statement = ddl` (ou `all`) sur PostgreSQL : `CREATE/ALTER ROLE` porte le mot de passe du rôle en
clair dans la requête (PostgreSQL n'y accepte pas de paramètre), et il serait écrit dans le journal du serveur.

## 15. Actions du propriétaire (récapitulatif)

1. Avant la mise à jour multi-comptes : 2FA du propriétaire active, sauvegarde, aucune session (§12.1).
2. Après : supprimer `NUERA_REQUIRE_2FA` de Coolify, vérifier « VPS-3 » dans Administration › Serveurs (§12.3).
3. Fixer `APP_URL` définitivement (domaine `dev.nuera.studio`) **avant** d'inviter quiconque (clés d'accès, adresses
   des applications GitHub).
4. Restreindre l'accès du serveur par défaut à la base (§14) **avant** d'inviter quiconque, après avoir vérifié les
   points 1 et 4 du §12.6 (verrous consultatifs retirés, droit de fermer les connexions des rôles restreints).
5. Pour chaque autre personne : un serveur supplémentaire (§13), puis une invitation (Administration › Comptes) avec ce
   serveur pré-attribué ; lui transmettre le lien affiché une fois. Elle connecte elle-même Claude Code et ses
   sources GitHub.
6. Garder `web` à **une** réplique (autorisations d'enrôlement, limites de débit et événements par compte sont en
   mémoire du processus : `docs/SECURITY.md` §11).

## Déploiement réel — NUERA-PERSO-01 (5 novembre 2026)

Mis en place par l'API de Coolify, sur le modèle de Nuera OS (NUERA-PROD-01 : app + PostgreSQL dédié non exposé) :

- Projet Coolify **« Nuera Studio - Nuera Dev »**, environnement `production`, serveur **NUERA-PERSO-01**.
- Base **`nuera-dev-postgres`** : `postgres:17-alpine`, non publique, base et utilisateur `nuera_dev`, sauvegarde
  quotidienne à 3 h UTC (14 conservées, locales — pas de S3).
- App **`nuera-dev`** : source « Github Ethan », dépôt `EthanTheDevelop/Nuera-DEV`, branche `main`, build pack
  Docker Compose, **dossier de base `/deploy`** et fichier `/docker-compose.yml` (le contexte `..` des services est
  résolu depuis le dossier de base), option **« Connect to predefined network »** activée (sinon `migrate` ne joint
  pas la base, placée sur le réseau de Coolify).
- Domaine du service `web` : https://nuera-dev.perso.nuera.studio (domaine automatique de PERSO). Pour
  `dev.nuera.studio` : créer l'enregistrement A vers `159.173.129.249`, ajouter le domaine au service `web`, mettre
  `APP_URL` à jour puis redéployer. Le faire avant d'inviter d'autres comptes : un changement d'`APP_URL` rend
  inutilisables les clés d'accès de tous les comptes et oblige à mettre à jour les adresses de retour de chaque
  source GitHub.
- Variables (dans Coolify, jamais dans le dépôt) : `DATABASE_URL`, `RUNNER_TOKEN`, `BETTER_AUTH_SECRET`,
  `APP_ENCRYPTION_KEY`, `SETUP_TOKEN`, `VAPID_*`, `APP_URL`, `TRUSTED_IP_HEADER=x-real-ip`, `RUNNER_CPUS=4`,
  `RUNNER_MEMORY=6g` (PERSO a 6 cœurs / 11,4 Go et héberge d'autres sites).
- **CloudBeaver** `nuera-dev-cloudbeaver` (même modèle que `db.staging.nuera.studio` en PROD) : https://db-dev.perso.nuera.studio,
  admin `nueraadmin`, mot de passe = variable `SERVICE_PASSWORD_CBADMIN` du service ; relié au réseau `coolify`
  pour joindre la base par son nom interne (hôte = UUID de la base, port 5432).
- Vérifié après déploiement : statut `running:healthy`, `/api/health` → `{"status":"ok","db":true}`,
  `/configuration` → 200.

## Environnements : staging et production (6 novembre 2026)

Deux environnements Coolify dans le projet « Nuera Studio - Nuera Dev », tous deux sur NUERA-PERSO-01, chacun avec
sa propre base, ses secrets, son runner et son CloudBeaver :

| | Staging (développement) | Production |
|---|---|---|
| Branche GitHub | `staging` | `main` |
| App Coolify | `nuera-dev-staging` | `nuera-dev` |
| URL | https://nuera-dev-staging.perso.nuera.studio | https://nuera-dev.perso.nuera.studio |
| Base PostgreSQL 17 | `nuera-dev-staging-postgres` (`nuera_dev_staging`) | `nuera-dev-postgres` (`nuera_dev`) |
| CloudBeaver | https://db-dev-staging.perso.nuera.studio | https://db-dev.perso.nuera.studio |
| Runner | 2 cœurs / 3 Go | 4 cœurs / 6 Go |
| Déploiement | automatique à chaque push sur `staging` | automatique à chaque push sur `main` |

Aperçu : chaque environnement a son domaine d'aperçu, ajouté au service **web** de son app Coolify et recopié dans
sa variable `PREVIEW_HOST` :

| | Staging | Production |
|---|---|---|
| Domaines du service web | `https://nuera-dev-staging.perso.nuera.studio,https://nuera-dev-staging-apercu.perso.nuera.studio` | `https://nuera-dev.perso.nuera.studio,https://nuera-dev-apercu.perso.nuera.studio` |
| `PREVIEW_HOST` | `nuera-dev-staging-apercu.perso.nuera.studio` | `nuera-dev-apercu.perso.nuera.studio` |

Flux de travail : on développe et on pousse sur `staging` (ou une branche fusionnée dans `staging`), on vérifie sur
l'URL de staging, puis on fusionne `staging` dans `main` par pull request : seul ce merge met à jour la production.
Les deux instances sont indépendantes : le compte propriétaire, la connexion à Claude (`claude auth login`), la
GitHub App (page Intégrations) et le `SETUP_TOKEN` se configurent séparément sur staging. Les secrets sont propres à
chaque environnement (variables de l'app dans Coolify) ; ne jamais copier ceux de la production.
