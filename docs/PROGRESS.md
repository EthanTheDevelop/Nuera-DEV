# Suivi d'avancement — Nuera Dev

> Court et à jour. Détail des choix : `docs/ARCHITECTURE.md` §14. Une ligne par lot ; cocher quand intégré **et** vérifié.

## Jalons

| # | Jalon | État |
|---|---|---|
| 0 | Découverte : Figma (tokens, 8 écrans × 2, 26 états), recherche Claude Code / stack / intégrations | ✅ |
| 1 | Socle : monorepo, dépendances, schéma DB + migrations, Postgres local, CLAUDE.md | ⏳ |
| 2 | Fondations parallèles : UI kit + shell, auth/sécurité, runner (Git/PTY/sessions), intégrations serveur | ⬜ |
| 3 | Domaines : Accueil, Projets, Workspace, Sessions, Intégrations, Paramètres (bureau + mobile) | ⬜ |
| 4 | Parcours transversaux de bout en bout + tests Playwright | ⬜ |
| 5 | Revue (sécurité, fidélité Figma, boutons morts), corrections | ⬜ |
| 6 | Déploiement Coolify/VPS-3 prêt (Dockerfiles, compose, sauvegardes, DEPLOY.md) | ⬜ |

## Décisions récentes

- Sessions Claude : CLI interactif dans tmux (PTY direct en dev Windows), `--session-id` = id Nuera, reprise `--resume`.
- Conversation : hooks officiels + lecture tolérante du journal ; autorisations via hook `PermissionRequest` borné.
- GitHub : GitHub App (flux manifest), jetons d'installation réduits par opération, en-tête Git injecté par processus.
- MCP : `--mcp-config` par session + `--strict-mcp-config`, secrets via `headersHelper`.

## Vérifications réalisées

- (à compléter à chaque lot)

## Reste à faire / blocages externes

- Accès VPS-3/Coolify, création de la GitHub App et connexion Claude Max : à réaliser par le propriétaire (voir `docs/DEPLOY.md`).
