# Déploiement — Nuera Dev sur VPS-3 via Coolify (VPS-1)

> Cible : `https://dev.nuera.studio`, application **web** exposée, **runner** privé, PostgreSQL distinct non exposé.
> Rien dans ce document n'a été exécuté sur les serveurs réels : les étapes marquées **[propriétaire]** demandent des
> accès que seul le propriétaire possède.

## 1. Vue d'ensemble

```
Coolify (VPS-1) ── déploie ──► VPS-3
                                 ├─ PostgreSQL 17 (ressource Coolify, réseau privé, sauvegardes)
                                 └─ Compose « nuera-dev » (deploy/docker-compose.yml)
                                      ├─ migrate  (ponctuel : applique packages/db/drizzle)
                                      ├─ web      (Next.js, port 3000 → domaine dev.nuera.studio, HTTPS Traefik)
                                      └─ runner   (aucun port public ; volumes /srv/dev, /data, /home/nuera)
```

Données persistantes (volumes nommés) — **jamais supprimées par un redéploiement** :

| Volume | Monté dans | Contenu |
|---|---|---|
| `nuera-projects` | runner `/srv/dev` | clones GitHub et worktrees (`/srv/dev/<projet>`, `/srv/dev/.worktrees/…`) |
| `nuera-runner-data` | runner `/data` | réglages par session, journaux du runner |
| `nuera-claude-home` | runner `/home/nuera` | CLI Claude Code officiel (installé au 1er démarrage), `~/.claude` (connexion, conversations) |

## 2. Prérequis [propriétaire]

1. DNS : enregistrement `A`/`AAAA` `dev.nuera.studio` → IP de VPS-3.
2. VPS-3 ajouté comme serveur dans Coolify (VPS-1), Docker installé par Coolify.
3. Accès GitHub au dépôt `EthanTheDevelop/-Nuera-DEV` depuis Coolify (application GitHub de Coolify ou clé de déploiement).

## 3. PostgreSQL

1. Coolify → *New resource* → **PostgreSQL 17** sur VPS-3. Ne **pas** activer « Make it publicly available ».
2. Noter l'URL interne (`postgres://…@<service>:5432/<db>`). Activer les **sauvegardes planifiées** Coolify (quotidiennes,
   rétention ≥ 14 jours, idéalement vers un stockage S3).
3. Alternative/complément : `deploy/scripts/backup-db.sh` et `restore-db.sh` (pg_dump/pg_restore).

## 4. Application (Docker Compose)

1. Coolify → *New resource* → **Docker Compose** depuis le dépôt, branche `main`, fichier `deploy/docker-compose.yml`.
2. Réseau : activer « Connect to predefined network » pour que `web`/`runner` joignent PostgreSQL.
3. Domaine : sur le service **web** uniquement, `https://dev.nuera.studio` (port 3000). Aucun domaine pour `runner`.
4. Variables d'environnement (onglet *Environment Variables*, marquées *secret*) :

| Variable | Valeur |
|---|---|
| `DATABASE_URL` | URL interne PostgreSQL (§3) |
| `APP_URL` | `https://dev.nuera.studio` |
| `RUNNER_TOKEN` | 32 octets aléatoires (`openssl rand -base64 32`) |
| `BETTER_AUTH_SECRET` | 32 octets aléatoires |
| `APP_ENCRYPTION_KEY` | `openssl rand -base64 32` (32 octets, base64) — **à sauvegarder hors du serveur** : sans elle, les secrets chiffrés (GitHub App, Coolify, variables de projet) sont perdus |
| `SETUP_TOKEN` | jeton à usage unique pour créer le compte propriétaire (à retirer ensuite) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | `npx web-push generate-vapid-keys` (notifications téléphone) |
| `VAPID_SUBJECT` | optionnel : `mailto:<adresse du propriétaire>` ou URL https (défaut : `APP_URL`) |
| `RUNNER_CPUS` / `RUNNER_MEMORY` | optionnel (défauts 6 CPU / 12 Go) |

5. Déployer. Vérifier : `migrate` termine en succès, `web` et `runner` passent *healthy*.

## 5. Première mise en service [propriétaire]

1. Ouvrir `https://dev.nuera.studio/configuration`, saisir `SETUP_TOKEN`, créer le compte, enrôler la double
   authentification (application TOTP), conserver les 8 codes de secours. Retirer ensuite `SETUP_TOKEN` de Coolify.
2. **GitHub** : Intégrations → « Connecter GitHub » → GitHub crée l'application Nuera Dev (flux manifest) → l'installer
   sur l'organisation `nuera-studio` et/ou le compte personnel, en choisissant les dépôts autorisés.
3. **Claude Code** : Paramètres → Claude Code → « Se reconnecter dans un terminal » : le terminal lance la procédure
   officielle `claude auth login` (compte Claude, formule Max). Nuera Dev ne lit ni n'enregistre aucun identifiant.
4. **MCP** (optionnel) : Figma (connexion OAuth via `claude mcp login figma` dans le terminal proposé), Coolify (jeton
   restreint à l'équipe *Développement*, abilities `read`/`read:sensitive`), Playwright.
5. Ajouter un premier projet (Projets → Ajouter un projet) et ouvrir le Workspace.

## 6. Vérifications après déploiement

- `GET https://dev.nuera.studio/api/health` → `{"status":"ok"}`.
- Le port 4100 du runner n'est **pas** joignable depuis Internet (`curl https://dev.nuera.studio:4100` échoue).
- Liste de contrôle Claude Code (version ≥ 2.1.317, `claude auth status --json`, hooks, tmux, reprise après
  redémarrage) : `docs/research/claude-code.md` §15.
- Redéployer `web` : les sessions tmux du runner continuent ; redéployer `runner` : sessions « Interrompue · reprise
  possible », reprise via `claude --resume`.

## 7. Mises à jour et maintenance

- Mise à jour applicative : push sur `main` → redéploiement Coolify (migrations appliquées par `migrate`).
- CLI Claude Code : mis à jour par son mécanisme officiel (Paramètres → Claude Code → Vérifier), jamais pendant une session.
- Rotation de `APP_ENCRYPTION_KEY` : voir `docs/SECURITY.md`.
- Restauration : arrêter `web`/`runner`, `restore-db.sh`, redémarrer.
