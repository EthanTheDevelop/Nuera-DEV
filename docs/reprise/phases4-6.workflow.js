export const meta = {
  name: 'nuera-phases-4-6',
  description: 'Phases 4–6 of Nuera Dev: the 5 end-to-end flows (Playwright desktop + mobile), the global review with fixes, then the deployment images built and tested locally',
  phases: [
    { title: 'Parcours', detail: '5 parcours transversaux de bout en bout, chacun écrit puis relu' },
    { title: 'Revue', detail: 'revue globale par dimension (sécurité, fidélité Figma, honnêteté, suivis), corrections puis contre-vérification' },
    { title: 'Déploiement', detail: 'images Docker construites et testées localement, compose, DEPLOY.md' },
  ],
}

const MAIN = '/home/user/-Nuera-DEV'

const COMMON = `
PROJECT: "Nuera Dev" — personal full-stack web app (single owner) to open GitHub repos cloned on a VPS ("VPS-3"), run OFFICIAL Claude Code CLI sessions on them (interactive, tmux/PTY), follow them live, answer permission requests, browse files/diffs, then commit/push/open pull requests — from desktop or phone. UI copy is French and must match Figma verbatim, with the STRAIGHT apostrophe ' everywhere, « » with inner spaces, the middle dot ·, the ellipsis character ….

STATE: ${'${STATE}'}

READ FIRST: README.md §1–4 (state and the list of known followups in §4.2), docs/PROGRESS.md, docs/TESTING.md and apps/web/e2e/harness/README.md (local test stack: stack.mjs up/down/status/login/seed/shot…, Playwright projects desktop 1440×1000 and mobile 390×844 driven by E2E_STACK, fixtures stack/runnerApi/seed/waitForSessionStatus/cli, fake GitHub, real Git repos, test-only fake Claude CLI with scenarios), docs/ARCHITECTURE.md, docs/SECURITY.md. Inventories to reuse instead of re-creating anything: apps/web/src/components/README.md, apps/web/src/components/dev/README.md, apps/web/src/components/terminal/README.md, the features' READMEs (apps/web/src/features/*/README.md), apps/runner/README.md. Figma specs = AUTHORITY: docs/figma/*.md, exports ${MAIN}/.design-refs/screens/<code>.png (INDEX.md lists them), raw design code ${MAIN}/.design-refs/code/<code>.tsx. If a file you are asked to produce already exists, continue it instead of rewriting it.

RULES (CLAUDE.md applies in full): no fake state, no hardcoded business data, no dead button (works end to end or disabled with its reason visible); Claude Code compliance (never 'claude -p', stream-json, Agent SDK query(), setup-token, CLAUDE_CODE_OAUTH_TOKEN, never read ~/.claude credentials; no invented cost/quota metric); security (requireUser / apiRoute everywhere, Origin check on mutations, Zod at every boundary, secrets encrypted and never sent to the browser or logs, audit() of sensitive actions, rate limits); the runner is the only component touching disk/git/PTY/processes (execFile with argument arrays, confined paths, clean env); formats via @nuera/shared/format; responsive + a11y (touch targets ≥ 44 px on phone, no horizontal scroll at 390 px); URL state per docs/figma/overview.md §6. DB schema changes ARE allowed in this phase only if indispensable: modify packages/db/src/schema, then add a NEW migration with pnpm db:generate (never delete or regenerate 0000), and say so in files_changed.

WORKING MODE — up to two agents run AT THE SAME TIME in the SAME checkout (${MAIN}), Linux container (4 CPUs, 15 GB RAM, root; Node 22, pnpm 9, git 2.43, tmux, Docker available; Chromium + Playwright preinstalled: never run "playwright install"). A shared PostgreSQL 17 runs on 127.0.0.1:54329 (nuera/nuera, superuser); if it is down, check first whether another agent is starting it (wait 30 s and retry), then start it once with "pnpm db:local" in the background (.data/pg must belong to the postgres user). Create your own databases on it, never touch nuera_dev or another agent's databases. Run long commands with run_in_background and wait for the notification; never re-run an identical slow command just because it is slow. Keep your stack up only while verifying; stop next dev with stack.mjs down (SIGTERM), never kill -9. Tests must not depend on the Internet.
- EDITS: before editing a file, re-read it (the other agent may have just changed it); make surgical edits, never reformat or rewrite working code for taste. Stay inside your brief's scope; anything bigger goes to followups (exact file + change).
- NEVER run git commands that change state (add, commit, stash, checkout, switch, reset, restore, clean, rebase, merge); read-only git is fine. NEVER run pnpm install/add/remove/update (report in dependencies_needed). The orchestrator commits after review.
- Never use ports 3000/4100/4101, the default .next directory or the nuera_dev database. Use only your stack name/ports/databases. Stop everything you started before finishing and check your ports are free.
- VERIFY, BRIEFLY (time matters more than exhaustiveness): tsc on the packages you touched, oxlint on your paths, Vitest of the files you touched, and ONE green run of the Playwright spec(s) you wrote or touched. No repeated runs, no screenshot campaigns unless your brief is about visual fidelity. Report the commands and results in one line each.
`

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    files_changed: { type: 'array', items: { type: 'string' }, description: 'files/folders you created or modified' },
    proposed_commits: {
      type: 'array',
      description: 'how the orchestrator should split your work into commits (conventional French messages, no AI mention)',
      items: {
        type: 'object',
        properties: { message: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } },
        required: ['message', 'paths'],
      },
    },
    delivered: { type: 'array', items: { type: 'string' } },
    verification: { type: 'array', items: { type: 'string' } },
    dependencies_needed: { type: 'array', items: { type: 'string' } },
    followups: { type: 'array', items: { type: 'string' } },
    known_gaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['files_changed', 'proposed_commits', 'delivered', 'verification', 'dependencies_needed', 'followups', 'known_gaps'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    issues_found: { type: 'array', items: { type: 'string' } },
    fixed: { type: 'array', items: { type: 'string' } },
    remaining: { type: 'array', items: { type: 'string' } },
    verification: { type: 'array', items: { type: 'string' } },
    files_changed: { type: 'array', items: { type: 'string' } },
    proposed_commits: {
      type: 'array',
      items: {
        type: 'object',
        properties: { message: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } },
        required: ['message', 'paths'],
      },
    },
  },
  required: ['issues_found', 'fixed', 'remaining', 'verification', 'files_changed', 'proposed_commits'],
}

const FLOW_COMMON = `
YOUR TASK: write ONE end-to-end Playwright spec for one of the 5 mandatory flows of the brief, running on the local test stack against the REAL runner, real Git repositories, the fake GitHub and the test-only fake CLI, on BOTH Playwright projects (desktop 1440×1000 and mobile 390×844 — on mobile the flow is done with the phone UI, not the desktop one). The spec drives the UI like the owner would (clicks, typing, navigation), asserting what is visible at each step AND the real effect (runner state, Git state of the bare repo or worktree, DB rows through the stack helpers, audit entries). No route mocking (page.route) of the app's own API. Stop every session your test creates (runnerApi('stopSession')) — the seeds keep 3 CLIs running and the session limit is 8.
When the flow exposes a BUG or a missing piece in the app (dead control, wrong copy, state not refreshed, missing audit, error not recoverable…), FIX IT in the app code with a minimal change, add or adjust the unit test that covers it, and list it in delivered + files_changed. If a fix is too big for this lot, mark the step test.fixme with a one-line French reason and put the exact change in followups.
You may add NEW helpers to the harness (new files under apps/web/e2e/harness/ or new exports, e.g. a fake MCP HTTP server for flow 5) and document them in apps/web/e2e/harness/README.md; keep existing harness contracts unchanged.
OWNED: apps/web/e2e/<your spec file>, new harness files you add, and the minimal app fixes the flow needs. Run your spec once green (desktop and mobile) on your own stack.
`

const FLOWS = [
  {
    key: 'parcours-1',
    stack: 'stack name "parcours1", web port 3310 (runner 4310, hook 4311, fake GitHub 4312), database nuera_parcours1',
    prompt: `${FLOW_COMMON}
FLOW 1 — file apps/web/e2e/parcours-1-github-projet.spec.ts: « GitHub connecté → choix du dépôt → clonage → projet → Workspace ». Start from a stack where the GitHub App is connected (fake GitHub) but the chosen repository is not yet a project (use a repo of the stack that the projects seed does not register, or start with E2E_SEED=github). Steps: Intégrations shows GitHub connected with its accounts → Projets « Ajouter un projet » (modal on desktop, M03 full page on phone) → pick account + repository (search) → configuration (A1: branch, destination, commands) → clone with live progress (A2) → success A3 → open the project page D04/M04 (branches, commands, CLAUDE.md tabs show real data from the clone) → « Démarrer une session » (NewSessionDialog) → lands on /workspace/<id> with the session started on a real worktree. Also cover the recoverable error A4 (destination already exists) once.`,
  },
  {
    key: 'parcours-2',
    stack: 'stack name "parcours2", web port 3320 (runner 4320, hook 4321, fake GitHub 4322), database nuera_parcours2',
    prompt: `${FLOW_COMMON}
FLOW 2 — file apps/web/e2e/parcours-2-session-en-direct.spec.ts: « Projet → branche / worktree → session → instruction → suivi en direct → autorisation ou erreur → résultat ». From a seeded project: create a new branch + worktree through the UI (project page or NewSessionDialog « nouvelle branche »), start a session, send an instruction from the composer (desktop Composer / phone PhoneComposer), follow it live in Conversation (tool lines appear while it runs, status badge « En cours »), receive a permission request (W3: PermissionRequestCard, also reachable from the Sessions page « Répondre » and the notification bell), answer « Autoriser » once and « Refuser » with a message another time, then see the final result message, the changed files counted in the panel and the session back to « En attente ». Cover the error path once (a scenario where the CLI tool fails, shown honestly), Échap interruption (session returns to waiting), and the Terminal brut view showing the same session live. Check the audit log has the permission decisions.`,
  },
  {
    key: 'parcours-3',
    stack: 'stack name "parcours3", web port 3330 (runner 4330, hook 4331, fake GitHub 4332), database nuera_parcours3',
    prompt: `${FLOW_COMMON}
FLOW 3 — file apps/web/e2e/parcours-3-commit-pr.spec.ts: « Modifications → diff → vérifications (tests) → commit → push → pull request ». From the seeded changes session (feature/export-csv with uncommitted files) or a session you drive with the fake CLI: open the Diff panel (W4 review mode on desktop, Diff tab + S2 on phone), page through the files, stage / unstage a file, run the project's tests from the Tests tab (a passing run and, on the catalogue project, a failing run shown honestly with its failing test), write the commit message (W5 desktop / S3 phone), commit, push (the bare repository on disk must contain the new commit on the branch), open the pull request (fake GitHub receives it; the UI shows the PR link and state). Check: push to the protected default branch is refused with the T4 panel; audit rows for commit, push and PR creation exist.`,
  },
  {
    key: 'parcours-4',
    stack: 'stack name "parcours4", web port 3340 (runner 4340, hook 4341, fake GitHub 4342), database nuera_parcours4',
    prompt: `${FLOW_COMMON}
FLOW 4 — file apps/web/e2e/parcours-4-reprise-telephone.spec.ts: « Navigateur fermé → session conservée → reprise depuis le téléphone ». Use TWO browser contexts in the same test (a desktop one and a phone one with the mobile viewport/UA, both signed in as the owner): on desktop start a session and send a long instruction, then CLOSE the desktop context while Claude works; the session keeps running on the runner (assert through runnerApi). Open the phone context: Accueil M01 shows the session live, Sessions M06 lists it, open it (M05), see the progress that happened while no browser was open (events replayed from the runner, no gap or duplicate), answer a permission from the phone (S1/S2 flows), send a follow-up instruction from PhoneComposer, see the result. Then cover the « interrupted then resumed » case: stop the CLI (runner restart via stack.mjs restart runner, or stopSession) so the session becomes « Interrompue », and resume it from the phone (« Reprendre », claude --resume through the runner) and continue the conversation. Also check W7 (connection lost banner) appears when the stream drops and recovers without a full page reload. This spec can be desktop-only in the Playwright project sense if it creates its own phone context; say so in the test title.`,
  },
  {
    key: 'parcours-5',
    stack: 'stack name "parcours5", web port 3350 (runner 4350, hook 4351, fake GitHub 4352), database nuera_parcours5',
    prompt: `${FLOW_COMMON}
FLOW 5 — file apps/web/e2e/parcours-5-mcp-diagnostic.spec.ts: « Configuration MCP / secret → vraie connexion ou « connexion requise » → diagnostic ». Add to the harness a small fake MCP server (Streamable HTTP, JSON-RPC initialize + tools/list, optional bearer check; no Internet) if none exists. Steps: Intégrations « Ajouter un serveur » (HTTP) pointing to the fake MCP server with a secret header/token (SecretField; the value is never echoed back to the browser — assert the API responses and the page HTML do not contain it) → test → « Connecté » with its tools listed in the drawer (D1) → enable it for a project (D2 / project page Outils MCP) → start a session on that project and assert the session's --mcp-config given to the CLI contains the server WITHOUT the secret (headersHelper 'nuera'), the fake CLI can obtain the headers through the runner helper. Then the failure side: make the fake MCP server refuse the token (or go down) → re-test → « Connexion requise » / « Autorisation expirée » state with the diagnostic text, notification and T4 details; fix the token through « Remplacer » → back to connected. Also cover Coolify token refusal → honest « connexion requise » (fake Coolify endpoint if needed) and the « Désactiver tout » guardrail.`,
  },
]

const FLOW_REVIEW = (lot, built) => `${COMMON}

YOUR STACK / PORTS / DATABASES: ${lot.stack} (same as the builder, who has finished).

YOU ARE THE INDEPENDENT REVIEWER of end-to-end flow "${lot.key}". The builder's brief was:
<<<BRIEF
${lot.prompt}
BRIEF>>>

The builder reported:
${JSON.stringify(built ?? { note: 'builder returned nothing — inspect the files yourself' }, null, 2)}

Review skeptically: (1) does the spec really cover EVERY step of the flow on desktop AND phone, through the UI, asserting real effects (runner, Git, DB, audit) rather than only visible text? Are there test.fixme / skips hiding broken features — try to fix them; (2) are the app fixes the builder made correct, minimal, secure, covered by unit tests, and free of regressions for the other pages (run the other e2e specs that touch the same pages)? (3) flakiness: run the spec 3 times in a row (one with E2E_RESET=1); replace fixed waits with web-first assertions; (4) honesty: no route mocking of the app's own API, no hardcoded business data introduced. Fix what is wrong. Finish with tsc / oxlint / tests green, bring your stack down and free your ports.`

const REVIEW_DIMENSIONS = [
  {
    key: 'securite',
    stack: 'stack name "revue1", web port 3410 (runner 4410, hook 4411, fake GitHub 4412), database nuera_revue1',
    prompt: `GLOBAL SECURITY AUDIT of the whole app, then fixes. Enumerate EVERY route handler (apps/web/src/app/api/**/route.ts), server action ('use server'), page and layout, and every runner route (apps/runner/src/**): check auth (requireUser/requireUserForApi, internalRoute token for /api/internal/**), Origin check on every mutation, Zod validation of params/query/body with size limits, rate limits on sensitive/expensive endpoints (auth, terminals, sessions create, clone, push, PR, MCP test, Coolify), audit() of every sensitive action listed in CLAUDE.md (session create/stop/resume/archive, permission decision, commit, push, PR, branch/worktree removal, CLAUDE.md write, env var change, MCP activation, settings change, login terminal opened, project add/archive) — README §4.2 says some audits were missing (permission decisions, push, worktree removal, CLAUDE.md write): verify and add them; secrets never reaching the client or logs (grep the RSC payloads / API responses on the stack for env var values, tokens, private keys); headers (CSP, frame-ancestors, referrer, HSTS in production, cookies Secure/HttpOnly/SameSite, __Host- prefix where possible) in next.config / proxy.ts; runner exposure (binds 127.0.0.1 or the internal network only, bearer token compared in constant time, no route reachable without it), path confinement (realpath) and branch/ref validation on every runner route taking a path or ref, execFile without shell everywhere (grep spawn/exec/shell:true), environment cleaning of child processes; Claude compliance grep (claude -p, stream-json, query(, setup-token, CLAUDE_CODE_OAUTH_TOKEN, .credentials.json) — must only appear in deny-lists/docs. Write focused unit tests for every fix. Produce docs/SECURITY.md updates (what is enforced where). Report every finding with file:line, fixed or not.`,
  },
  {
    key: 'figma-bureau',
    stack: 'stack name "revue2", web port 3420 (runner 4420, hook 4421, fake GitHub 4422), database nuera_revue2',
    prompt: `GLOBAL FIGMA FIDELITY REVIEW — DESKTOP 1440×1000 (and a check at 1024 and 1280). Bring up your stack with all seeds and take screenshots (stack.mjs shot) of EVERY desktop screen and state: D01–D08, A1–A4, D1, D2, T1–T8, W1–W7, plus empty/first-run states (up --pristine or a second database) and the dark theme. Compare each side by side with .design-refs/screens/<code>.png and the exact values in .design-refs/code/<code>.tsx (spacing, sizes, colours via tokens, typography, radii, shadows, icon sizes, alignment, verbatim copy with straight apostrophes). Fix deviations in the components/pages (tokens only, no hardcoded colours). Also handle these known UI followups from README §4.2: Banner text not wrapping, Dialog centred on the content region when the sidebar is shown (D03), McpServerCard on one line at 1440, Pastille 48 → 20 px icon, ConfirmDialog disabled state (archive while sessions are live). Report each screen: matched / fixed (what) / deviation kept (why). Keep before/after screenshots in your scratchpad subfolder and list their paths.`,
  },
  {
    key: 'figma-mobile',
    stack: 'stack name "revue3", web port 3430 (runner 4430, hook 4431, fake GitHub 4432), database nuera_revue3',
    prompt: `GLOBAL FIGMA FIDELITY REVIEW — PHONE 390×844 (and a check at 360 and 430). Bring up your stack with all seeds and take screenshots (stack.mjs shot --mobile) of EVERY phone screen and state: M01–M08, S1–S5, phone variants of T1–T8, W7, the tab bar, sheets, the phone composer and keyboard bar, empty states, the dark theme. Compare side by side with .design-refs/screens/<code>.png and .design-refs/code/<code>.tsx; fix deviations (tokens only). Check: no horizontal scroll (scrollWidth == viewport) on every page and tab, touch targets ≥ 44 px, safe areas and --shell-bottom for sticky bars, the tab bar never covers content or the composer, sheets scroll correctly, focus does not jump when the virtual keyboard opens. Report each screen: matched / fixed (what) / deviation kept (why), with before/after screenshot paths in your scratchpad subfolder.`,
  },
  {
    key: 'honnetete-copie-a11y',
    stack: 'stack name "revue4", web port 3440 (runner 4440, hook 4441, fake GitHub 4442), database nuera_revue4',
    prompt: `GLOBAL HONESTY + COPY + ACCESSIBILITY REVIEW. (1) Dead buttons: on the stack, click EVERY control of every page and state (desktop and phone), follow it to its real effect; anything that does nothing must work or be disabled with its reason visible. (2) Hardcoded business data: grep the app (apps/web/src) for Figma sample values and invented numbers (« Nuera OS », « 23 % », « Nezar », « feature/crm-core », « OVH Gravelines », « 2,4 Go », « 99,95 % », « 84 Mo »…) outside tests/fixtures/kit galleries and fix each. (3) Copy: every visible French string vs Figma (docs/figma/*.md, .design-refs/code/*.tsx): straight apostrophe ' only (grep for ’), « » with non-breaking inner spaces, ·, …, accents, capitalisation; error and toast messages sober and accurate. (4) Accessibility: axe-core is not installed — write a small Playwright check using the accessibility tree (page.accessibility / getByRole) for each page: landmarks, one h1, labelled controls, dialogs with titles, aria-live regions for live updates, focus trap and restoration in dialogs/sheets, keyboard navigation of the palette, menus and tabs, visible focus ring, colour contrast of text tokens (compute from tokens.css). (5) No polling faster than 15 s: grep setInterval/setTimeout loops and fetch-in-loop patterns. (6) Clean the oxlint warnings (node_modules/.bin/oxlint lists ~100): fix the real ones (exhaustive deps, set-state-in-effect where it causes extra renders, promise/always-return), and disable a rule locally ONLY with a one-line justification when the pattern is intended. Report what you fixed per category.`,
  },
  {
    key: 'suivis-runner',
    stack: 'stack name "revue5", web port 3450 (runner 4450, hook 4451, fake GitHub 4452), database nuera_revue5',
    prompt: `RUNNER + DATA FOLLOWUPS (README §4.2, runner side and their web consumers). Implement, with tests: (a) persist the parsed test report in command_runs.details when a run ends and let the web read per-test details from it after the run (Tests tab, project page); (b) sessions.claude_session_id read/written by the runner (today in NUERA_DATA_DIR/sessions/<id>/launch.json); (c) startup policy for orphan tmux sessions nuera-* (adopt or mark interrupted, never kill a session that is still known); (d) worktree disk size on WorktreeDto (du-like walk with a time/size budget, cached) so D08 « · N Go » and T8 « Libère N Go sur VPS-3. » show real numbers; (e) a runner route that removes a project's primary clone (confined, refuses live sessions, audited by the web) so the T8 option « Supprimer aussi le clone de VPS-3 » works; (f) S5 push notification copy « <titre> attend votre accord » / « <cible> · <projet> · touchez pour répondre » and href /workspace/<id>#demande-<permissionId>; (g) publish session.status (or a dedicated event) after archive/rename so other tabs update live; (h) move the session env deny-list to @nuera/shared and use it from the runner and both web copies (server/sessions/env.ts, server/projects/env.ts); (i) GitService.changes() must not read every untracked file of a huge tree (bounded); (j) protected branches of the project passed to the runner on push. Keep the shared contracts in packages/shared/src/runner/routes.ts in sync, add runner Vitest tests (real Git repos, fake CLI) and web tests. If one item is impossible to do honestly, explain why in remaining.`,
  },
  {
    key: 'suivis-web',
    stack: 'stack name "revue6", web port 3460 (runner 4460, hook 4461, fake GitHub 4462), database nuera_revue6',
    prompt: `WEB FOLLOWUPS (README §4.2, web side). Implement, with tests: (a) useLiveEvents' refresh on stream.reset / runner recovery must not re-render an intercepted route as a full page (Projets « nouveau » modal, Intégrations MCP drawer): defer it while such a route is shown, or let pages register their own refetch; (b) <GlobalSearch /> stays registered while T5 is shown (AppShell renders global providers outside the T5 gate); (c) checkCoolify marks the Coolify MCP server 'expired' when the token is refused so D04/D07/getProjectMcpTools agree; (d) the finished-session « Reprendre » menu item: align the web's resumable rule with the runner's (finished sessions are resumable) so the item appears and works; (e) use mcp_servers.config (non-secret headers, denied tools, preset) where the overview/drawer need it; (f) Primitive Checkbox in components/ui (W5 « Fichier inclus ») replacing ad-hoc checkboxes; formatShortDay moved to @nuera/shared/format; percentages with 2 decimals where Figma shows them (« 99,95 % »); (g) the Paramètres page refreshes the whole page on every session.status event — make it a targeted refetch of the live part; (h) apps/web/src/server/http.ts readJsonBody must handle a client-aborted body quietly; (i) terminal.spec.ts: use stack.paths.projects instead of NUERA_PROJECTS_ROOT; (j) fake GitHub in the harness serves GET /repos/{o}/{r}/contents[/{path}] and the repository size so D03 « CLAUDE.md du dépôt · Détecté », the lockfile hint and the size are exercised. Re-run the e2e specs of the pages you touch on desktop and mobile.`,
  },
]

const DIM_VERIFY = (dim, result) => `${COMMON}

YOUR STACK / PORTS / DATABASES: ${dim.stack} (same as the fixer, who has finished).

YOU ARE THE ADVERSARIAL VERIFIER of the global review dimension "${dim.key}". The fixer's brief was:
<<<BRIEF
${dim.prompt}
BRIEF>>>

The fixer reported:
${JSON.stringify(result ?? { note: 'fixer returned nothing — do the review yourself' }, null, 2)}

Assume the report is optimistic. (1) Re-check each claimed fix in the code and on the stack: does it really work, is it secure, does it regress anything (run the whole web Vitest suite, the runner suite if the runner was touched, and the e2e specs of every page the fixer changed, desktop and mobile)? (2) Look for what the fixer missed in this dimension: sample at least 10 places they did not mention. (3) Fix what is wrong or missing (same rules). Report issues_found (each with file:line), fixed, remaining. Finish green, stack down, ports free.`

const DEPLOY = {
  key: 'deploiement',
  stack: 'stack name "deploy", host ports 3510 (web) only; Docker project name nuera-deploy-test; database inside compose',
  prompt: `PHASE 6 — DEPLOYMENT READY, built and tested locally with Docker (this machine has Docker; NEVER deploy to or touch any real server, never push images to a registry). Files: deploy/docker/web.Dockerfile, deploy/docker/runner.Dockerfile, deploy/docker/runner-entrypoint.sh, deploy/docker-compose.yml, deploy/docker-compose.dev.yml, deploy/scripts/backup-db.sh, restore-db.sh, docs/DEPLOY.md (they exist but were NEVER built). Do: (1) build both images for real (docker build, multi-stage, pnpm deploy/standalone Next output, non-root users, no Docker socket and no root in the web container, minimal layers, .dockerignore); runner image: git ≥ 2.32, tmux ≥ 3.0, Node ≥ 22, LANG fr_FR.UTF-8 locale generated, the official Claude Code CLI installed by the entrypoint into the persistent HOME (do NOT log into it; it must start fine without being logged in and report « déconnecté »); (2) docker compose up with a throwaway .env (generated by scripts/setup-env.mjs into deploy/.env.test, git-ignored): migrate service runs the migrations, web and runner healthchecks go green, runner has NO published port and is reachable only from web on the internal network, volumes /srv/dev, /data, /home/nuera persist across a restart; (3) smoke test against the containers: /api/health, /configuration with SETUP_TOKEN creates the owner (TOTP), sign-in, the shell loads, Paramètres shows the CLI as not connected, a terminal of kind claude-status opens through the runner (no credentials read), a clone of a local bare repo mounted read-only works (no Internet needed); (4) backup-db.sh then restore-db.sh round-trip on the compose database; (5) document precisely in docs/DEPLOY.md: Coolify on VPS-1 deploying to VPS-3, domain dev.nuera.studio, TRUSTED_IP_HEADER=x-real-ip behind Traefik, APP_URL, secrets list, first-run steps (SETUP_TOKEN then remove it, GitHub App manifest creation, claude auth login in the Nuera terminal, Coolify read-only token, VAPID keys), the bubblewrap/seccomp note for the CLI sandbox in Docker, upgrade/rollback, backups, and what was tested locally vs what remains to verify on VPS-3 (tmux backend with the real CLI, hooks, Remote Control). Never claim production was tested. Stop and remove the test containers/volumes at the end (docker compose down -v) and report image sizes and the exact commands run.`,
}

const DEPLOY_REVIEW = (built) => `${COMMON}

YOUR STACK: ${DEPLOY.stack}.

YOU ARE THE INDEPENDENT REVIEWER of the deployment lot. The brief was:
<<<BRIEF
${DEPLOY.prompt}
BRIEF>>>

The builder reported:
${JSON.stringify(built ?? { note: 'builder returned nothing — inspect the files yourself' }, null, 2)}

Rebuild the images from scratch (docker build --no-cache for at least the web image), rerun the compose stack and the smoke test yourself. Check security of the images (USER, no secrets baked into layers — docker history, no .env copied, runner not published, read-only root fs where possible, healthchecks, restart policies, resource limits), that docs/DEPLOY.md matches the files exactly and makes no claim of a production test. Fix what is wrong. docker compose down -v at the end.`

const PART = (args && args.part) || 'flows'
const STATE = (args && args.state) || 'phases 0–3 are integrated, verified and pushed on main.'
const withState = (text) => text.replace('${STATE}', STATE)

if (PART === 'flows') {
  phase('Parcours')
  const results = await parallel(FLOWS.map((lot) => () =>
    agent(withState(`${COMMON}\n\nYOUR STACK / PORTS / DATABASES: ${lot.stack}.\n\n${lot.prompt}`), { label: `build:${lot.key}`, phase: 'Parcours', schema: RESULT_SCHEMA }).then((built) => ({ key: lot.key, built }))))
  return { flows: results.filter(Boolean) }
}

if (PART === 'review') {
  phase('Revue')
  const dims = (args && args.only) ? REVIEW_DIMENSIONS.filter((d) => args.only.includes(d.key)) : REVIEW_DIMENSIONS
  const results = await parallel(dims.map((dim) => () =>
    agent(withState(`${COMMON}\n\nYOUR STACK / PORTS / DATABASES: ${dim.stack}.\n\n${dim.prompt}`), { label: `fix:${dim.key}`, phase: 'Revue', schema: REVIEW_SCHEMA }).then((result) => ({ key: dim.key, result }))))
  return { review: results.filter(Boolean) }
}

if (PART === 'deploy') {
  phase('Déploiement')
  const built = await agent(withState(`${COMMON}\n\nYOUR STACK: ${DEPLOY.stack}.\n\n${DEPLOY.prompt}`), { label: 'build:deploiement', phase: 'Déploiement', schema: RESULT_SCHEMA })
  return { deploy: { built } }
}

return { error: `part inconnu : ${PART}` }
