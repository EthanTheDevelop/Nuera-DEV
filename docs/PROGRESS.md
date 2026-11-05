# Suivi d'avancement — Nuera Dev

> Court et à jour. Détail des choix : `docs/ARCHITECTURE.md` §14. Une ligne par lot ; cocher quand intégré **et** vérifié.

## Jalons

| # | Jalon | État |
|---|---|---|
| 0 | Découverte : Figma (tokens, 8 écrans × 2, 26 états), recherche Claude Code / stack / intégrations | ✅ |
| 1 | Socle : monorepo, dépendances, schéma DB + migrations, Postgres local, CLAUDE.md | ✅ |
| 2 | Fondations : UI kit + shell, composants Nuera Dev, auth/sécurité, runner (Git/PTY/sessions), intégrations serveur | ✅ |
| 3 | Domaines : Accueil, Projets, Workspace, Sessions, Intégrations, Paramètres (bureau + mobile) | ⏳ |
| 4 | Parcours transversaux de bout en bout + tests Playwright | ⬜ |
| 5 | Revue (sécurité, fidélité Figma, boutons morts), corrections | ⬜ |
| 6 | Déploiement Coolify/VPS-3 prêt (Dockerfiles, compose, sauvegardes, DEPLOY.md) | ⏳ (fichiers prêts, non déployé) |

## Lots du jalon 2 (intégrés)

| Lot | Contenu | Vérifié |
|---|---|---|
| UI kit | jetons, 67 icônes, logo, primitives (boutons, champs, superpositions, T1–T8), shell bureau/rail/onglets, palette ⌘K, flux temps réel (T5/T6/W7), thème, galerie `/kit` | ✅ |
| Composites | fil de session, demande d'autorisation, saisie, diff, listes et cartes (D01–D08, W1–W7, S1–S4), galerie `/kit/composites` | ✅ |
| Auth | Better Auth 1.7 : propriétaire unique (`/configuration` + `SETUP_TOKEN`), TOTP obligatoire, codes de secours, clés d'accès, expiration d'inactivité, limites de débit, audit | ✅ |
| Runner | Git (clone, branches, worktrees, diff, commit, push protégé), PTY/tmux, sessions Claude interactives (hooks, autorisations bornées, reprise), processus du projet, métriques, disponibilité | ✅ |
| Intégrations | GitHub App (manifest, jetons réduits), Coolify lecture seule, registre MCP par projet, notifications + Web Push, routes internes | ✅ |

## Décisions récentes

- Sessions Claude : CLI interactif dans tmux (PTY direct en dev Windows), `--session-id` = id Nuera, reprise `--resume`.
- Conversation : hooks officiels + lecture tolérante du journal ; autorisations via hook `PermissionRequest` borné.
- GitHub : GitHub App (flux manifest), jetons d'installation réduits par opération, en-tête Git injecté par processus.
- MCP : `--mcp-config` par session + `--strict-mcp-config`, secrets via `headersHelper`.
- Copie : apostrophe droite `'` partout (la page NUERA DEV de Figma n'emploie jamais `’`).
- Lint : oxlint (ESLint inutilisable sur le poste de dev : plusieurs minutes par fichier).

## Vérifications réalisées

- Jalon 2 : typecheck des 4 paquets OK ; oxlint 0 erreur ; Vitest `@nuera/shared` 21, `@nuera/db` 5, `@nuera/web`
  230, `@nuera/runner` 64 (vrais dépôts Git, PTY et faux CLI de test) ; Playwright auth 11/11 (bureau + mobile) ;
  captures comparées aux exports Figma par lot.
- Migration 0000 régénérée (schéma Better Auth 1.7, colonnes de suivi) et appliquée sur `nuera_dev`.

## Reste à faire / blocages externes

- Accès VPS-3/Coolify, création de la GitHub App et connexion Claude Max : à réaliser par le propriétaire (voir `docs/DEPLOY.md`).
- À vérifier sur VPS-3 (Linux) : backend tmux, hooks du CLI réel, `claude auth status --json` (docs/research/claude-code.md §15).
