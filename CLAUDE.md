# CLAUDE.md — Nuera Dev

Application personnelle de Nuera Studio : ouvrir les dépôts GitHub clonés sur VPS-3, piloter des sessions du CLI
officiel Claude Code, suivre leur exécution, répondre aux autorisations, consulter fichiers et diffs, puis committer,
pousser et ouvrir des pull requests — depuis un PC ou un téléphone.

## À lire avant de coder

- `docs/ARCHITECTURE.md` — architecture, contrats, sécurité, arbitrages (référence technique).
- `docs/PROGRESS.md` — suivi d'avancement (à tenir à jour à chaque lot terminé).
- `docs/figma/*.md` — spécifications extraites de Figma (autorité visuelle) ; captures, code de référence et assets
  dans `.design-refs/` (non versionné ; à régénérer via le MCP Figma, fichier `nlvRWAtD1x2fKf8gVgcM0g`).
- `docs/research/claude-code.md` (intégration et conformité Claude Code), `integrations.md` (GitHub, Coolify, Figma,
  MCP), `stack.md` (versions et pièges).

## Règles absolues

1. **Claude Code** : uniquement le binaire officiel non modifié, en session **interactive** (PTY / tmux). Jamais de
   `claude -p`, `--output-format stream-json`, Agent SDK `query()`, `claude setup-token`, `CLAUDE_CODE_OAUTH_TOKEN`.
   Ne jamais lire, copier ou transmettre `~/.claude/.credentials.json` ni les champs de compte de `~/.claude.json`.
   Aucun formulaire de jeton Claude. Aucune métrique de coût/quota inventée.
2. **Aucun faux état** : pas de données métier codées en dur, pas de mock permanent, pas de bouton mort. Les fixtures
   vivent uniquement dans les tests (`**/test/**`, `**/*.test.ts`, `e2e/`).
3. **Sécurité** : toute route/action serveur appelle `requireUser()` ; toute mutation vérifie l'Origin ; les secrets
   sont chiffrés (AES-256-GCM) et jamais renvoyés au client ; actions sensibles journalisées dans `audit_log`.
4. **Runner** : seul composant qui touche au disque des projets, à Git, aux PTY et aux processus. `execFile` avec
   tableau d'arguments, jamais de shell ; chemins confinés (`realpath`) ; environnement nettoyé.
5. **Commits** : messages conventionnels sobres (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`), sans
   aucune mention d'IA/agent/outil de génération, sans trailer `Co-authored-by`. Inspecter le diff avant de committer.
6. **Copie UI** : textes français identiques à Figma (accents, apostrophes typographiques `’`, points médians `·`).

## Commandes

```bash
pnpm install                 # dépendances (pnpm 9, Node ≥ 22.12 — testé sous Node 24)
pnpm db:local                # PostgreSQL 17 local (embedded-postgres, port 54329, données dans .data/pg)
pnpm db:migrate              # applique packages/db/drizzle
pnpm db:generate             # génère une migration après modification du schéma
pnpm dev                     # web (http://localhost:3000) + runner (http://127.0.0.1:4100)
pnpm typecheck && pnpm lint && pnpm test
pnpm --filter @nuera/web e2e # parcours Playwright
```

## Structure

```
apps/web        Next.js 16 (App Router) — UI, API, auth (Better Auth + 2FA), intégrations GitHub/Coolify
apps/runner     service d'exécution (Fastify) — Git, worktrees, PTY, sessions Claude (tmux), processus, métriques
packages/db     schéma Drizzle + migrations + client
packages/shared contrats Zod runner⇄web, types d'événements, formatage FR, garde des chemins
deploy/         Dockerfiles, compose Coolify, sauvegarde/restauration
```

## Conventions

- TypeScript strict partout ; validation Zod aux frontières (formulaires, route handlers, runner).
- Composants UI : `apps/web/src/components/ui` (primitives du design system) — réutiliser avant de créer.
  Couleurs/rayons/ombres via les tokens (`tokens.css` → classes Tailwind), jamais de valeurs en dur.
- Code serveur dans `apps/web/src/server/**` avec `import 'server-only'` ; les pages ne touchent pas la DB directement.
- Statuts en `text` typés (unions dans `packages/db/src/schema/types.ts`), pas d'enum PostgreSQL.
- Dates et nombres : `@nuera/shared/format` (fr-FR, Europe/Paris).

## Leçons et pièges confirmés

<!-- Ajouter ici, au fil du développement, les pratiques vérifiées : contexte → cause → solution → fichier. -->
- Poste de dev Windows sans Docker : PostgreSQL via `embedded-postgres`, PTY via `@lydell/node-pty` (binaires
  précompilés), pas de tmux → le runner bascule sur le backend PTY direct (`NUERA_SESSION_BACKEND=pty`).
- TypeScript 6.0.x (et non 7.x) : typescript-eslint exige `<6.1.0`.
