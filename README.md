# Nuera Dev

Espace de développement personnel de Nuera Studio : retrouver, depuis n'importe quel appareil, les projets clonés sur
**VPS-3** et les sessions **Claude Code** qui y travaillent — puis vérifier, committer, pousser et ouvrir les pull
requests sans changer d'outil.

- **Projets** : application GitHub (accès limité aux dépôts choisis), clonage sur VPS-3, branches et worktrees,
  synchronisation, commandes du projet, `CLAUDE.md`, variables d'environnement chiffrées, serveurs MCP par projet.
- **Workspace** : une vraie session du CLI officiel Claude Code (tmux sur VPS-3), lisible en *Conversation* ou en
  *Terminal brut*, autorisations traitées depuis le navigateur, fichiers, diff, commit, push et pull request.
- **Sessions** : sessions parallèles isolées dans leurs worktrees, reprise après interruption (`claude --resume`),
  historique filtrable.
- **Intégrations** : GitHub, Figma (MCP), Coolify (développement uniquement), diagnostics automatiques.
- **Paramètres** : double authentification obligatoire, accès web révocables, journal de sécurité, santé du serveur.

> Nuera Dev utilise le binaire officiel Claude Code, non modifié, connecté par son propriétaire via la procédure
> d'Anthropic. Il ne lit, ne stocke et ne relaie aucun identifiant Claude et n'appelle aucune API de chat.

## Démarrage local

Prérequis : Node.js ≥ 22.12 (testé sous 24), pnpm 9, Git. Docker n'est pas nécessaire.

```bash
pnpm install
pnpm setup:env          # crée .env avec des secrets aléatoires (affiche le jeton de configuration initiale)
pnpm db:local           # PostgreSQL 17 local (laisser tourner dans un terminal)
pnpm db:migrate         # applique les migrations
pnpm dev                # web http://localhost:3000 + runner http://127.0.0.1:4100
```

Puis ouvrir `http://localhost:3000/configuration`, saisir le jeton de configuration, créer le compte propriétaire et
activer la double authentification.

Sous Windows (sans tmux), le runner utilise des PTY directs : les sessions survivent à la fermeture du navigateur mais
pas à un redémarrage du runner (elles sont alors reprises via `claude --resume`). En production (Linux), tmux conserve
les sessions indépendamment du runner.

## Commandes

| Commande | Rôle |
|---|---|
| `pnpm dev` | web + runner en développement |
| `pnpm typecheck` / `pnpm lint` / `pnpm test` | vérifications |
| `pnpm e2e` | parcours Playwright (bureau et téléphone) |
| `pnpm db:generate` / `pnpm db:migrate` | migrations Drizzle |
| `pnpm build` | builds de production |

## Architecture

Monorepo pnpm : `apps/web` (Next.js 16, Better Auth, Tailwind v4), `apps/runner` (Fastify, Git, PTY, tmux, Claude Code),
`packages/db` (Drizzle + PostgreSQL), `packages/shared` (contrats Zod, formatage fr-FR). Détails :
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Sécurité : [docs/SECURITY.md](docs/SECURITY.md). Déploiement Coolify /
VPS-3 : [docs/DEPLOY.md](docs/DEPLOY.md). Avancement : [docs/PROGRESS.md](docs/PROGRESS.md).
