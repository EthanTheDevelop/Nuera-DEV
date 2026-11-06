# Suivi d'avancement — Nuera Dev

> Court et à jour. Détail des choix : `docs/ARCHITECTURE.md` §14. Une ligne par lot ; cocher quand intégré **et** vérifié.

## Jalons

| # | Jalon | État |
|---|---|---|
| 0 | Découverte : Figma (tokens, 8 écrans × 2, 26 états), recherche Claude Code / stack / intégrations | ✅ |
| 1 | Socle : monorepo, dépendances, schéma DB + migrations, Postgres local, CLAUDE.md | ✅ |
| 2 | Fondations : UI kit + shell, composants Nuera Dev, auth/sécurité, runner (Git/PTY/sessions), intégrations serveur | ✅ |
| 3 | Domaines : Accueil, Projets, Workspace, Sessions, Intégrations, Paramètres (bureau + mobile) + pile de test + terminal | ✅ |
| 4 | Parcours transversaux de bout en bout + tests Playwright (`e2e/parcours-1…5`) | ✅ |
| 5 | Revue (sécurité, fidélité Figma, boutons morts), corrections | ✅ |
| 6 | Déploiement Coolify (Dockerfiles, compose, sauvegardes, DEPLOY.md) | ✅ version propriétaire unique déployée le 5 novembre 2026 sur NUERA-PERSO-01 |
| 7 | Multi-comptes : espaces, serveurs, rôles, 2FA obligatoire, invitations, administration (`docs/MULTICOMPTE.md`) | 🟡 construit, relu et durci (X1, Y1–Y5), Vitest vert par lot ; e2e en cours (W6) ; non committé, non déployé |

## Lots du jalon 2 (intégrés)

| Lot | Contenu | Vérifié |
|---|---|---|
| UI kit | jetons, 67 icônes, logo, primitives (boutons, champs, superpositions, T1–T8), shell bureau/rail/onglets, palette ⌘K, flux temps réel (T5/T6/W7), thème, galerie `/kit` | ✅ |
| Composites | fil de session, demande d'autorisation, saisie, diff, listes et cartes (D01–D08, W1–W7, S1–S4), galerie `/kit/composites` | ✅ |
| Auth | Better Auth 1.7 : propriétaire unique (`/configuration` + `SETUP_TOKEN`), TOTP obligatoire, codes de secours, clés d'accès, expiration d'inactivité, limites de débit, audit | ✅ |
| Runner | Git (clone, branches, worktrees, diff, commit, push protégé), PTY/tmux, sessions Claude interactives (hooks, autorisations bornées, reprise), processus du projet, métriques, disponibilité | ✅ |
| Intégrations | GitHub App (manifest, jetons réduits), Coolify lecture seule, registre MCP par projet, notifications + Web Push, routes internes | ✅ |

## Lots du jalon 3 (intégrés)

| Lot | Contenu | Vérifié |
|---|---|---|
| Pile de test | `e2e/harness` : faux GitHub, vrais dépôts, runner, faux CLI, données, projets Playwright bureau/mobile | ✅ |
| Terminal | xterm.js partagé, `/api/terminals/**` | ✅ |
| Accueil | D01/M01 en direct, recherche globale ⌘K | ✅ |
| Sessions | D06/M06, nouvelle session, arrêt, reprise, historique filtré | ✅ |
| Projets | D02/M02, ajout A1–A4/M03, page projet D04/M04 | ✅ |
| Workspace | D05/M05, W1–W7, S1–S4 | ✅ |
| Intégrations | D07/M07, D1/D2 | ✅ |
| Paramètres | D08/M08 | ✅ |

## Lots du jalon 7 — multi-comptes (copie de travail, chaque lot construit puis relu indépendamment)

| Lot | Contenu | Vérifié |
|---|---|---|
| D0 | Déploiement : `migrate` avec `RUNNER_TOKEN`, point d'entrée du runner (`RUNNER_DATABASE_URL`), `deploy/docker-compose.runner.yml`, DEPLOY.md §12–14 | ✅ relu (aucune image construite : pas de Docker sur le poste) |
| F1 | Schéma (espaces, serveurs, invitations, réglages, sources GitHub), migrations 0001–0004 (RLS), montée de version, CLI `recovery-link`, contrats partagés v2 | ✅ db 72 |
| C1 | Runner par serveur : identité par empreinte du jeton, attente, bail, marqueurs, cloisonnement des requêtes, rôle restreint, battement | ✅ runner 100 (tmux : Linux seulement) |
| C2a | Web : contexte de requête, gardes de portée, runner par serveur, routes internes par jeton, flux namespacés | ✅ |
| C2b | Web : réglages par portée, notifications par destinataire, push par compte, journaux personnel et d'instance, chiffrement lié à la ligne | ✅ |
| W1 | Projets par espace et par serveur, sélecteur de source GitHub, « Premiers pas » | ✅ |
| W2 | Sessions, Workspace, terminaux par serveur, identité Git du compte | ✅ |
| W3 | Plusieurs sources GitHub par espace, Coolify/MCP par espace, garde SSRF, planificateur web | ✅ |
| W4 | Comptes, invitations, récupération, administration (comptes, serveurs, instance, journal) | ✅ |
| W5 | Paramètres par portée, shell (rôle, « Aucun serveur attribué », T5), push et garde d'identité multi-onglets | ✅ |
| W6 | Playwright : pile à deux comptes et deux runners, nouveaux parcours | ✅ 186 réussis, 1 échec Windows connu |
| X4 | Documentation (README, CLAUDE.md, docs/*) | ✅ |
| X1 | Runner et rotation : battement hors planificateur, relecture fatale, sonde d'identifiant de session, `ENVIRONMENT_STARTING`, promotion du jeton au premier usage | ✅ |
| Y1 | Push : renouvellement limité au compte connecté, services push seulement (`NUERA_PUSH_HOSTS`), sans redirection, abonnement lié à son accès web | ✅ web 27 (push) |
| Y2 | Migration `0005_runner_scope` (FK composites, verrous consultatifs), bail restreint par fonction, socket tmux par serveur | ✅ db 76, runner (tmux : Linux seulement) |
| Y3 | Administration des serveurs : adresse protégée, une adresse par serveur, `CONNECTION LIMIT` et délais des rôles, fermeture des connexions, « restreint » vérifié par PostgreSQL | ✅ web 23 (admin) |
| Y4 | Terminal de connexion MCP réservé au propriétaire sur un serveur actif ; route `integrations/check` supprimée | ✅ |
| Y5 | Flux global maintenu pendant une panne du runner ; retour à la garde de notification après déconnexion | ✅ web 117 |
| Y6 | Documentation des lots X1 et Y1–Y5 (MULTICOMPTE §14, SECURITY, DEPLOY §12.6, CLAUDE.md) | ✅ |

Vérification commune (6 novembre 2026, avant les lots Y) : `tsc` 0 erreur sur les 4 paquets ; Vitest avec
`NUERA_REQUIRE_PG=1` : shared 40, db 72, runner 100 (+1 ignoré), web 787. Vérification finale (6 novembre 2026,
après les lots Y et les raccords) : `tsc` 0 erreur (4 paquets), oxlint 0 erreur, Vitest shared 40, db 76, runner 106
(+1 ignoré : tmux, Linux seulement), web 845, `next build` OK, Playwright (pile neuve, 2 comptes, 2 runners) 186
réussis, 1 échec connu propre à Windows (Échap sous PTY, mobile). Committé et poussé sur `main` le 6 novembre 2026 ;
actions du propriétaire : `docs/DEPLOY.md` §12 à §14. Écarts de chaque lot : `docs/MULTICOMPTE.md` §14.

## Décisions récentes

- Multi-comptes : un serveur = un espace = une personne = une connexion Claude ; identifiant étranger = 404 d'un
  inconnu ; 2FA obligatoire pour tous (`NUERA_REQUIRE_2FA` supprimée) ; runners non par défaut sur un rôle
  PostgreSQL restreint avec RLS ; horloge des vérifications d'intégrations dans le web.
- Durcissement (lots Y) : verrous consultatifs réservés et FK composites (`0005`), un socket tmux par serveur,
  adresse d'un serveur d'un autre compte réservée au propriétaire de l'instance, abonnements push liés à leur accès
  web, flux global maintenu pendant une panne du runner.

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

- Jalon 3 : typecheck des 4 paquets OK ; oxlint 0 erreur ; Vitest shared 21, db 5, web 412, runner 64 ; `next build`
  OK ; Playwright par lot sur sa propre pile (accueil 12, sessions 19, projets 14, workspace 21, intégrations 15,
  paramètres 24, terminal 13, smoke + auth 20) ; captures 1440/390 comparées aux exports Figma.

## Aperçu (6 novembre 2026)

Site du serveur de développement d'un worktree dans le Workspace (onglet du panneau, vue agrandie `?vue=apercu`,
onglet téléphone), servi par une origine séparée `PREVIEW_HOST` (même conteneur web, `src/proxy.ts`), passage de main
signé à usage unique `POST /api/previews`, cookie `nuera_apercu` propre à l'hôte d'aperçu, relais runner
`/v1/runs/:id/preview/*` limité au port détecté d'un `dev` vivant. Tests : runner `test/preview.test.ts`, web
`server/preview/preview.test.ts`, `lib/preview.test.ts`, `proxy.test.ts`, e2e `apercu.spec.ts` (bureau + téléphone).
Sécurité : `docs/SECURITY.md` §8 bis ; déploiement : `docs/DEPLOY.md` (domaine d'aperçu par environnement).

Correctif (vrai `next dev`, cadre blanc sur iPhone) : l'hôte d'aperçu n'est plus relayé par un route handler mais par
une réécriture externe de Next vers le runner (`server/preview/gate.ts`) : le Next de Nuera Dev ne traite plus les
requêtes RSC du site prévisualisé (boucle de redirections `?_rsc=`, `x-nextjs-rewritten-path` faux), le WebSocket de
rechargement à chaud traverse la chaîne (sans lui `next dev` 16 ne s'hydrate pas et recharge la page en boucle), le
runner écrit les pages d'erreur et le script de position ; la barre d'outils signale un cadre resté sans page 15 s.
Tests : e2e « un vrai next dev » (`apercu.spec.ts`), runner « direct mode » et WebSocket, `gate` (web).

## Reprise automatique après la limite d'utilisation (lot Z1, 6 novembre 2026)

Quand le CLI officiel s'arrête sur la limite de l'abonnement (`StopFailure` `rate_limit`, avis « 5-hour limit
reached ∙ resets 3pm » du journal ou de l'écran, `resets_at` de la status line — rien d'autre, aucune estimation),
le runner l'enregistre (`sessions.usage_limit`, migration `0006`) et, si l'option est active, tape l'instruction de
reprise 2 min après la levée (ou `claude --resume` si le CLI a disparu) ; 5 tentatives au plus, levée inconnue : un
essai toutes les 30 min pendant 6 h ; persistant au redémarrage ; annulé par une instruction, un arrêt, un archivage
ou l'option coupée. Défaut de l'espace désactivé + « Instruction de reprise » (Paramètres › Claude Code), choix par
session (`sessions.auto_resume`). Web : bandeau du Workspace, badge, menu « … », feuille téléphone, Sessions, Accueil,
route `POST /api/sessions/[id]/auto-resume`, journal `session.auto_resume_*`. Tests : runner `usage-limit.test.ts`,
`restricted.test.ts` ; db migrations ; web `settings.test.ts`, `sessions.test.ts`, `internal.test.ts`, isolation,
`usage-limit.test.ts` ; e2e `reprise.spec.ts` (pile `reprise`, web 3640, bureau + téléphone) et
`parcours-2-session-en-direct.spec.ts`. Détails : `docs/MULTICOMPTE.md` §14, lot Z1.

## Configuration Claude commune (lot K1, 6 novembre 2026)

Module d'instance pour que Claude Code se comporte de la même façon partout : **règles** Markdown (ordonnées,
activables, « Imposé » → `--append-system-prompt-file`, « Par défaut » → `rules/nuera-commun.md` du dossier Claude,
avant le CLAUDE.md du projet), **skills** (import .zip validé, éditeur, scripts sur autorisation, écrits par chaque
runner dans `skills/` sous marqueur, « commun » dans la palette), **MCP communs** (audience tous / administrateurs,
secrets servis par `headersHelper: 'nuera'` seulement aux comptes visés), **Coolify (administrateurs)** (lecture
permise, écritures demandées, suppressions refusées sauf choix du propriétaire, mode sans autorisation bloqué),
**permissions et réglages** (allow/ask/deny, variables non secrètes, modèle ; « Imposé » / « Par défaut » par élément,
désactivation par l'espace), **versions** (différences, retour arrière), **propositions** des membres, transparence
(Workspace, Paramètres › Claude Code). Administration › Claude (Règles · Skills · MCP · Permissions · Historique).
Migration `0007_instance_claude_config` (tables du web seulement). Tests : web `server/claude-config/*.test.ts`, runner
`common-config.test.ts`, db `migrations.test.ts`/`rls.test.ts`, e2e `configuration-commune.spec.ts` (pile `config`,
web 3660, bureau + téléphone). Détails : `docs/MULTICOMPTE.md` §14, lot K1 ; `docs/SECURITY.md` §8 ter.

## Reprise

État détaillé, reste à faire et instructions de reprise : [README.md](../README.md) §1–5. Brief d'origine :
[docs/reprise/BRIEF-ORIGINAL.md](reprise/BRIEF-ORIGINAL.md). Script de la phase 3 : [docs/reprise/phase3-domaines.workflow.js](reprise/phase3-domaines.workflow.js).

## Reste à faire / blocages externes

- Multi-comptes : corriger `internal.test.ts`, terminer et faire passer les e2e (W6), committer lot par lot, puis
  appliquer la mise à jour (`docs/DEPLOY.md` §12, contrôles du §12.6) ; suivis et risques résiduels : README §4.0,
  `docs/SECURITY.md` §11.
- Propriétaire : création de la GitHub App, connexion Claude Max, puis restriction de la base du serveur par défaut
  (`docs/DEPLOY.md` §14) et, pour chaque autre personne, un serveur supplémentaire (§13).
- Aperçu : ajouter le domaine d'aperçu au service web et `PREVIEW_HOST` dans chaque environnement Coolify
  (`docs/DEPLOY.md`) ; pas de rechargement à chaud (aucun WebSocket à travers un route handler).
- À vérifier sur le serveur réel (Linux) : backend tmux (suite `tmux.test.ts`, adoption entre serveurs, session tmux
  lancée pour une autre ligne), `0005` appliquée en superutilisateur, hooks du CLI
  réel, `claude auth status --json` (docs/research/claude-code.md §15), images multi-comptes (DEPLOY §11).
