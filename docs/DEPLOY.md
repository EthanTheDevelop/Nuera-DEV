# Déploiement — Nuera Dev sur VPS-3 via Coolify (VPS-1)

> Cible : `https://dev.nuera.studio`, application **web** exposée, **runner** privé, PostgreSQL distinct non exposé.
> **Rien dans ce document n'a été exécuté sur les serveurs réels.** Les images et le compose ont été construits et
> essayés **localement** avec Docker (§10) ; ce qui reste à vérifier sur VPS-3 est listé au §11. Les étapes marquées
> **[propriétaire]** demandent des accès que seul le propriétaire possède.

## 1. Vue d'ensemble

```
Coolify (VPS-1) ── déploie ──► VPS-3
                                 ├─ PostgreSQL 17 (ressource Coolify, réseau privé, sauvegardes)
                                 └─ Compose « nuera-dev » (deploy/docker-compose.yml)
                                      ├─ migrate  (ponctuel : applique packages/db/drizzle puis s'arrête)
                                      ├─ web      (Next.js standalone, port 3000 → dev.nuera.studio, HTTPS Traefik)
                                      └─ runner   (aucun port publié ; volumes /srv/dev, /data, /home/nuera)
```

| Image | Dockerfile (cible) | Contenu | Taille mesurée (essai local) |
|---|---|---|---|
| `nuera-dev-web` | `deploy/docker/web.Dockerfile` (`runtime`) | `node:24-bookworm-slim`, sortie standalone Next, `curl`, `tini` ; utilisateur `node` (uid 1000) | 477 Mo (115 Mo compressés) |
| `nuera-dev-migrate` | `deploy/docker/web.Dockerfile` (`migrate`) | `@nuera/db` seul (drizzle-orm, postgres.js, tsx) ; utilisateur `node` | 864 Mo (217 Mo compressés) |
| `nuera-dev-runner` | `deploy/docker/runner.Dockerfile` | runner groupé (esbuild) + dépendances de prod, git 2.39, tmux 3.3a, Node 24, bubblewrap, socat, locale `fr_FR.UTF-8` ; utilisateur `nuera` (uid 1001) | 567 Mo (131 Mo compressés) |

Garanties du compose (`deploy/docker-compose.yml`) :

- `web` : non-root, système de fichiers racine en **lecture seule** (`tmpfs` sur `/tmp` et `.next/cache`),
  `cap_drop: ALL`, `no-new-privileges`, **aucun socket Docker**, aucun volume.
- `runner` : non-root (`nuera`), `no-new-privileges`, limites CPU/mémoire/PID (`RUNNER_CPUS`, `RUNNER_MEMORY`,
  4096 PID), **aucun port publié** : joignable uniquement par `web` sur le réseau interne `nuera-internal`
  (`http://runner:4100`, jeton `RUNNER_TOKEN` exigé sur chaque route, `401` sans lui). L'écoute des hooks du CLI
  (4101) reste sur `127.0.0.1` dans le conteneur.
- `migrate` doit se terminer en succès avant le démarrage de `web` et `runner`.

Données persistantes (volumes nommés) — **jamais supprimées par un redéploiement** :

| Volume | Monté dans | Contenu |
|---|---|---|
| `nuera-projects` | runner `/srv/dev` | clones GitHub et worktrees (`/srv/dev/<projet>`, `/srv/dev/.worktrees/…`) |
| `nuera-runner-data` | runner `/data` | réglages par session, journaux du runner, configuration tmux |
| `nuera-claude-home` | runner `/home/nuera` | CLI Claude Code officiel (installé au 1er démarrage dans `~/.local/bin`), `~/.claude` (connexion, conversations) |

## 2. Prérequis [propriétaire]

1. DNS : enregistrement `A`/`AAAA` `dev.nuera.studio` → IP de VPS-3.
2. VPS-3 ajouté comme serveur dans Coolify (VPS-1), Docker installé par Coolify.
3. Accès GitHub au dépôt `EthanTheDevelop/-Nuera-DEV` depuis Coolify (application GitHub de Coolify ou clé de déploiement).
4. VPS-3 : au moins 4 vCPU / 8 Go conseillés (le runner est limité par défaut à 6 CPU / 12 Go, à ajuster).

## 3. PostgreSQL

1. Coolify → *New resource* → **PostgreSQL 17** sur VPS-3. Ne **pas** activer « Make it publicly available ».
2. Noter l'URL interne (`postgres://…@<service>:5432/<db>`). Activer les **sauvegardes planifiées** Coolify (quotidiennes,
   rétention ≥ 14 jours, idéalement vers un stockage S3).
3. Complément : `deploy/scripts/backup-db.sh` et `restore-db.sh` (§9).

## 4. Application (Docker Compose)

1. Coolify → *New resource* → **Docker Compose** depuis le dépôt, branche `main`, fichier `deploy/docker-compose.yml`
   (Coolify construit les trois images sur VPS-3 ; aucun registre n'est nécessaire).
2. Réseau : activer « Connect to predefined network » pour que `migrate`, `web` et `runner` joignent PostgreSQL.
3. Domaine : sur le service **web** uniquement, `https://dev.nuera.studio` (port 3000). **Aucun domaine pour `runner`**
   ni pour `migrate`.
4. Variables d'environnement (onglet *Environment Variables*, les secrets marqués *secret* / *locked*) :

| Variable | Service | Valeur |
|---|---|---|
| `DATABASE_URL` | tous | URL interne PostgreSQL (§3) |
| `APP_URL` | web, runner | `https://dev.nuera.studio` (cookies `__Secure-`, contrôle d'Origin, adresses de retour GitHub) |
| `RUNNER_TOKEN` | web, runner | **secret** — 32 octets aléatoires (`openssl rand -base64 32`) |
| `BETTER_AUTH_SECRET` | web | **secret** — 32 octets aléatoires |
| `APP_ENCRYPTION_KEY` | web | **secret** — `openssl rand -base64 32` (32 octets, base64). **À sauvegarder hors du serveur** : sans elle, les secrets chiffrés (GitHub App, Coolify, MCP, variables de projet) sont perdus |
| `SETUP_TOKEN` | web | **secret** — jeton à usage unique de `/configuration` ; **à retirer** après la création du compte (§5) |
| `TRUSTED_IP_HEADER` | web | `x-real-ip` (valeur par défaut du compose) : Traefik (Coolify) écrit l'adresse du client dans `X-Real-IP` ; c'est le seul en-tête d'IP pris en compte (journal de sécurité, limites de débit) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | web | **secret** (privée) — `npx web-push generate-vapid-keys` (notifications téléphone) |
| `VAPID_SUBJECT` | web | optionnel : `mailto:<adresse du propriétaire>` ou URL https (défaut : `APP_URL`) |
| `NUERA_SERVER_STATUS_URL` | web | optionnel : page d'état de l'hébergeur (https), proposée quand le serveur est injoignable |
| `GITHUB_FALLBACK_TOKEN` | web | optionnel, **secret** : PAT de secours (déconseillé, jamais servi au MCP GitHub) — laisser vide avec l'application GitHub |
| `LOG_LEVEL` | web, runner | optionnel : `info` (défaut) |
| `RUNNER_CPUS` / `RUNNER_MEMORY` | runner | optionnel (défauts 6 CPU / `12g`) |
| `NUERA_IMAGE_TAG` | build | optionnel : étiquette des images construites (défaut `latest`, utile au retour arrière §8) |

À ne **jamais** définir : `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_GROWTHBOOK` (le point d'entrée du runner retire les quatre
premières par sécurité ; les deux dernières désactiveraient Remote Control).

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
   Nuera Dev ne lit ni n'enregistre aucun identifiant ; la connexion vit dans le volume `nuera-claude-home`.
4. **Coolify (lecture seule)** : créer dans Coolify un jeton limité à l'équipe/environnement *Développement*, abilities
   `read` (et `read:sensitive` si besoin), **sans** `write`/`deploy` ; le saisir dans Intégrations → Coolify
   (`docs/INTEGRATIONS.md` §3). Un jeton qui expose des outils `manage_*`/`create_*` reste hors de portée de Claude.
5. **Notifications** : générer les clés VAPID (`npx web-push generate-vapid-keys`), les renseigner (§4), redéployer
   `web`, puis Paramètres → Notifications → activer sur le téléphone (PWA installée sur iOS).
6. **MCP** (optionnel) : Figma (`claude mcp login figma` dans le terminal proposé), Playwright.
7. Ajouter un premier projet (Projets → Ajouter un projet) et ouvrir le Workspace.

## 6. Vérifications après déploiement

- `GET https://dev.nuera.studio/api/health` → `{"status":"ok","db":true,"version":"…"}`.
- Le runner n'est **pas** joignable depuis Internet : aucun port publié (`docker port <runner>` vide), pas de domaine.
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

- **Mise à jour** : push sur `main` → redéploiement Coolify. `migrate` applique les nouvelles migrations (Drizzle,
  jamais destructives par convention) avant le redémarrage de `web` et `runner`.
- Avant toute mise à jour comportant une migration : sauvegarde (`backup-db.sh` ou sauvegarde Coolify à la demande).
- **Retour arrière** : Coolify → *Deployments* → redéployer le commit précédent (ou fixer `NUERA_IMAGE_TAG` sur
  l'étiquette précédente si les images sont conservées). Si la version précédente ne lit pas le schéma migré :
  arrêter `web`/`runner`, restaurer la sauvegarde prise avant la mise à jour (§9), redéployer l'ancien commit.
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

- **Restauration** : arrêter `web` et `runner`, puis `restore-db.sh <fichier.dump>` (demande de taper `RESTAURER`,
  ou `RESTORE_CONFIRM=RESTAURER` en non interactif ; `pg_restore --clean --if-exists --single-transaction`),
  redémarrer, vérifier `/api/health`.
- **Hors base** : `APP_ENCRYPTION_KEY` (gestionnaire de mots de passe), volume `nuera-claude-home` (sinon refaire
  `claude auth login`), `nuera-projects` (le travail non poussé n'existe que là).

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

La production n'a **pas** été testée.
