# Nuera Dev — Integrations research (GitHub, Coolify, Figma, MCP)

Research date: **2026-11-04**. Scope: the external services Nuera Dev talks to (single-owner app on VPS-3, served at `dev.nuera.studio`), what it must store, how it decides « Connecté / À reconnecter / Erreur », and the exact requests it sends. Companion documents: `docs/figma/*.md` (what the screens show) and `docs/research/claude-code.md` (how Claude Code sessions are launched, hook bridge, login). This file does not scaffold anything.

**Evidence tags used everywhere below**

| Tag | Meaning |
|---|---|
| `[V]` | Verified on 2026-11-04 in official documentation or upstream source code. The URL is given next to the claim or in §10. |
| `[O]` | Observed on this Windows dev machine on 2026-11-04 (Claude Code 2.1.280, git 2.43.0, npm registry queries). |
| `[I]` | Inference, design proposal or unverified detail. Must be confirmed by the spike named in §8 before anything relies on it. |

Contents: 0 Decisions · 1 What the Figma requires · 2 GitHub · 3 Coolify · 4 Figma · 5 MCP in Claude Code · 6 GitHub MCP server · 7 Cross-cutting design (secrets, status, diagnostic, data model) · 8 Spikes · 9 Copy inconsistencies to arbitrate · 10 Sources.

---

## 0. Decisions in one page

1. **GitHub = a GitHub App registered through the App Manifest flow** [V: manifest flow], owned by the organization `nuera-studio`, **public** because it must be installed on two accounts (`nuera-studio` and `ethanthedevelop`) and a private app "can only be installed on the account that owns the app" [V]. Installed with « Only select repositories ». Installation tokens (1 h) are minted on demand, **down-scoped per operation and per repository** [V: `repositories` + `permissions` body], held in memory only. **Fallback:** fine-grained PAT, configured by env/CLI only and never offered in the UI (the Figma copy says « Aucun jeton n'est saisi à la main »). **OAuth App: rejected.**
2. **Git transport:** the token is injected **per git process** through `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` setting `http.https://github.com/.extraheader` (the same header GitHub's `actions/checkout` builds) [V], with credential helpers reset, repo hooks disabled and an explicit remote URL. Never in a URL, in argv, in `.git/config` or in a credential store.
3. **GitHub REST:** send `X-GitHub-Api-Version: 2026-03-10` (new version; `2022-11-28` stays supported until 2028-03-10 and is the default when the header is absent) [V]. Do not rely on `merge_commit_sha` (removed in 2026-03-10) [V]. Accept installation tokens of about **520 characters** (stateless `ghs_…` format, rollout complete on 2026-10-02) [V].
4. **Coolify:** target **v4.6.0** (released 2026-11-02) [V]. One token « Nuera Dev · Développement », **scoped to the development environments** (scoped tokens are new in 4.6) or created in a dedicated « Développement » team, with abilities `read` + `read:sensitive` (+ `deploy` only if Claude may start preview deployments). Never `write`, `delete` or `root`. The backend uses it with a GET-only client. Claude uses it through **Coolify's built-in MCP server at `https://<coolify>/mcp`** (Streamable HTTP, Bearer token) [V].
5. **Figma:** **remote MCP server `https://mcp.figma.com/mcp`, OAuth only.** The remote server does not accept personal access tokens [V], and only clients in Figma's MCP catalog can connect [V], so Nuera Dev cannot hold its own Figma MCP credential. **Nuera Dev stores no Figma secret.** The OAuth grant lives in Claude Code on VPS-3. Reconnecting means a web terminal running `claude mcp login figma --no-browser` [V]. The desktop server (`127.0.0.1:3845`) needs the Figma desktop app, so it cannot run on headless VPS-3 [V]. A Figma PAT (90 days max [V]) is optional and only for REST extras.
6. **MCP wiring:** every Claude session is started with a generated `--mcp-config <file> --strict-mcp-config` and `ENABLE_CLAUDEAI_MCP_SERVERS=false` [V], so that « Un serveur MCP n'est visible que des projets où il est activé » actually holds. Secrets reach HTTP MCP servers through a **`headersHelper`** command that asks the backend over a Unix socket. Claude Code re-runs the helper at each connection and after a 401/403 [V]. No secret lands in a file or in the session environment.
7. **GitHub MCP:** remote server `https://api.githubcopilot.com/mcp/` with `X-MCP-Readonly: true` and `X-MCP-Toolsets` [V], authenticated by a **read-only installation token scoped to the project's repository** and minted by the helper [I]. That the remote server accepts `ghs_` tokens is only confirmed in a GitHub issue comment, so spike S3 must check it.
8. **One status model for all integrations:** `connecte | expire_bientot | a_reconnecter | erreur | desactive | jamais_verifie`. Checks run every 15 minutes, on demand, and when an event arrives (hooks, git failures). **Health checks never mutate anything:** REST GETs, MCP `server/discover` or `initialize` plus `tools/list`, and `claude mcp get <name>`.

---

## 1. What the Figma frames require from integrations

| UI (frame, node) | Data needed | Where solved |
|---|---|---|
| D07 GitHub tile `216:2120` | the accounts where the app is installed (« installée sur l'organisation nuera-studio et sur le compte ethanthedevelop »), `DÉPÔTS ACCESSIBLES` « 12 dépôts · sélectionnés à l'installation », `DROITS` « Contenu · pull requests · lecture et écriture ; issues en lecture », `DERNIÈRE VÉRIFICATION` « il y a 6 min · synchronisation sans erreur », actions `Gérer l'accès`, `Vérifier la connexion`, `Voir les 12 dépôts`, line « Expiration : jeton d'installation renouvelé automatiquement par GitHub. » | §2.6, §2.12, §2.13 |
| A1 repo picker (D03 flow) | repos grouped by owner (« Tous · 12 », « nuera-studio · 11 », « ethanthedevelop · 1 »), « Privé · TypeScript · mis à jour il y a 2 j », « Déjà cloné », footer « 12 dépôts accessibles · gérer l'accès sur GitHub » | §2.6 |
| D03 note | « Accès GitHub : lecture et écriture du contenu, pull requests. Accordé à l'application GitHub de Nuera Dev, jamais par jeton collé à la main. » | §2.2 |
| A2 clone log | `$ git clone https://github.com/nuera-studio/roux-conseil.git`, so the URL carries no token | §2.7 |
| W5 commit and PR, T3 toasts | push, then PR creation after confirmation; « Pull request #57 ouverte vers main » | §2.8, §7.5 |
| D07 MCP grid | per server: status badge (`Connecté`, `Autorisation expirée`, `Désactivé`), project count, button `Configurer` / `Reconnecter` / `Activer` | §5.7, §7.2 |
| D1 drawer (Figma) `234:5035` | ÉTAT: « Connexion · compte nuera-studio », « Dernier appel · il y a 3 min · Nuera OS », « Vérification · toutes les 15 min · OK », `Tester la connexion`. ACTIVÉ DANS: one toggle per project. PERMISSIONS ACCORDÉES: « Lire les fichiers et les composants », « Lire les variables et les styles », « Modifier les fichiers Figma · non accordé », note « Les droits viennent de l'autorisation donnée dans Figma, révocable depuis Figma. ». CONFIGURATION: « .mcp.json de chaque projet activé », « transport : HTTP distant », « authentification : autorisation Figma (OAuth) ». Button `Désactiver partout`. | §4.5, §5.7, §9 |
| D2 drawer (Coolify) `234:5235` | banner « Jeton expiré ce matin à 09:12 » + « Les sessions de Nuera OS n'ont plus accès aux environnements de développement. ». RECONNECTER: token field, with text « Créez un nouveau jeton dans Coolify, limité à l'équipe Développement, puis collez-le ici. Il est chiffré sur VPS-3 et n'est plus jamais affiché. ». PÉRIMÈTRE: « Environnements de développement · Déploiements de prévisualisation, journaux, variables » (on), « Environnements de production · Non disponible : ces actions restent dans Coolify, avec votre compte. » (locked). Guardrail « Après reconnexion, chaque projet garde son propre réglage dans Outils MCP. » | §3.6 |
| D07 diagnostic banner `216:2247` | « Coolify ne répond plus depuis 09:12 » / « Le jeton du serveur MCP a expiré. … » + `Voir le journal` + `Reconnecter` | §7.2, §7.3, §9 |
| T7 `236:5401` | BEFORE: « Autorisation GitHub bientôt expirée · Renouvelez l'accès avant le 12 novembre. · Renouveler ». AFTER: « L'accès GitHub a été retiré · Synchronisation, push et pull requests suspendus. Le travail local continue. · Réautoriser sur GitHub ». Annotation: « Même logique pour GitHub, Figma ou Coolify : prévenir avant, dire ce qui s'arrête après, et renvoyer vers le service qui délivre l'accès. » | §2.13, §7.2, §9 |
| D07 guardrails | « Production hors de portée », « Un accès, un projet », « Diagnostic automatique · Chaque connexion est vérifiée toutes les 15 minutes. Une expiration s'affiche ici et sur l'Accueil. » | §3.6, §5.7, §7.2 |
| D04 « Outils MCP du projet » | per project: « Figma · maquettes Nuera OS · lecture » (on), « GitHub · issues et pull requests du dépôt » (on), « Coolify · environnement de développement · à reconnecter » (off, warn) | §5.7 |
| Principles P2 / P4 | no Claude-token form anywhere; no Coolify production action reachable by Claude. A Coolify token field in D2 is allowed: P2 only forbids a Claude token form. | §3.6, §5.7 |

---

## 2. GitHub

### 2.1 Requirements

Nuera Dev is used by one owner. It must list **only the repositories the owner authorized**, clone/fetch/pull/push over HTTPS, read branches, create pull requests, and track them (state, checks, statuses, reviews). Privileges must be as low as possible, and nothing may reach GitHub without an explicit confirmation in the UI (D05/W5 principle).

### 2.2 The three options compared

| Criterion | (a) GitHub App (manifest flow) | (b) Fine-grained PAT | (c) OAuth App |
|---|---|---|---|
| Repo selection | Per installation: « All repositories » or « Only select repositories » [V] | « Only select repositories » per token [V] | None. "An authorized OAuth app has access to all of the user's or organization owner's accessible resources." [V]. The `repo` scope "Grants full access to public and private repositories" [V] |
| Org + personal account | One app, one installation per account. The app must be public to be installed on a second account [V] | "Each token is limited to access resources owned by a single user or organization" [V], so **2 tokens** | One token covers everything, which is too broad |
| Permission granularity | Fine-grained. Each token can be narrowed to ≤ 500 repos and a subset of the app's permissions [V] | Fine-grained, fixed when the token is created | Coarse scopes ("OAuth apps can't use granular permissions") [V] |
| Checks API (`check-runs`) | Yes, `checks: read` [V] | **No.** "Calling the Checks API" is listed as unsupported, and no check-runs endpoint appears in the fine-grained endpoint list [V] | Yes, via the `repo` scope |
| Lifetime | Installation token: 1 h, re-minted from the app's private key [V]. The owner has nothing to renew | Chosen at creation. Default 30 days. "Infinite lifetimes are allowed but may be blocked by a maximum lifetime policy" [V]. A PAT unused for a year is deleted [V] | Long-lived by default [V] |
| Identity on GitHub | A bot account, e.g. `@jenkins[bot]` [V], so ours shows as `<slug>[bot]` | The user | The user |
| Org policies | "GitHub Apps aren't subject to organization application policies" [V] | An org may require approval or block fine-grained PATs. A pending token can only read public resources [V] | Subject to OAuth app access restrictions [V] |
| Primary rate limit | 5,000/h per installation, growing with repos and users, capped at 12,500 [V] | 5,000/h for the user [V] | 5,000/h for the user [V] |
| Push/PR triggers Actions | Yes. An installation token can trigger workflows; only `GITHUB_TOKEN` can't [V] | Yes [V] | Yes |
| Matches the Figma copy | Yes: « Connecté par l'application GitHub de Nuera Dev … Aucun jeton n'est saisi à la main » | No: a pasted token | No |
| GitHub guidance | "In general, GitHub Apps are preferred over OAuth apps" [V]. For long-lived integrations, "you should use a GitHub App" [V] | | |

**Recommendation.** Use **(a)** as the only UI-visible method.

- It is the only option that combines per-repository selection across **two owners**, the Checks API, tokens that renew themselves, and a credential that never passes through the owner's hands.
- Each token is re-scoped per operation (§2.5). A leaked push token for `nuera-os` therefore cannot touch any other repository, and it expires within the hour.

**Fallback (b)** is for local development and for emergencies only.

- It is read from the server environment (`NUERA_GITHUB_PAT_<OWNER>`), one token per owner.
- It is not shown in the UI, so the copy stays true.
- Its limitations are listed in §2.10.

**(c) is rejected:** it can't select repositories, its scopes are broad, and its tokens are long-lived.

**Ownership alternative.** If `ethanthedevelop/nuera-studio` is moved into the `nuera-studio` organization, the app can stay **private** (installable only on the org) [V]. That is the cleanest security posture. With the repository on the personal account, the app must be public. Being public only means that anyone *can* install it: an installation by a stranger would give **us** access to **their** repositories, never the reverse. The backend ignores installations whose `account.id` is not in its allowlist and may delete them [I].

### 2.3 Registering the app with the manifest flow

**Sequence.** All URLs and fields below are [V] (manifest docs) unless tagged.

1. The owner clicks « Connecter GitHub » on `/integrations`. This button only appears when no app is stored.
2. The backend creates `state` (32 random bytes, stored server-side with a 1-hour TTL, since "You must complete all three steps in the GitHub App Manifest flow within one hour" [V]). It renders a page that auto-submits this form:

```html
<form id="m" method="post"
      action="https://github.com/organizations/nuera-studio/settings/apps/new?state=STATE">
  <input type="hidden" name="manifest" value='{ …manifest JSON below… }'>
</form>
<script>document.getElementById('m').submit()</script>
```

   For a personal-account owner, the action is `https://github.com/settings/apps/new?state=STATE` [V].
3. On GitHub the owner confirms the app name. GitHub then redirects to `redirect_url?code=CODE&state=STATE` [V].
4. The backend checks `state` and calls `POST https://api.github.com/app-manifests/{code}/conversions` (Octokit `apps.createFromManifest`). The documented example sends **no Authorization header** [V]. Response `201` contains `id, slug, node_id, client_id, client_secret, webhook_secret, pem, owner, name, html_url, permissions, events` [V]. Errors are `404` and `422` [V].
5. The backend encrypts `pem`, `client_secret` and `webhook_secret` (§7.1), stores the app metadata, and discards the plaintext.
6. The backend redirects to `https://github.com/apps/{slug}/installations/new?state=STATE2` [V]. The owner installs on `nuera-studio` with « Only select repositories », then repeats for `ethanthedevelop`.
7. GitHub redirects to `setup_url?installation_id=…` [V]. A `setup_action` parameter probably comes too, but it is not on that page [I]. The docs warn that "Bad actors can hit this URL with a spoofed `installation_id`" [V]. The backend therefore verifies it with the app JWT: `GET /app/installations/{id}` (`apps.getInstallation`), then checks that `account.id` is in the allowlist. This is our mitigation [I]; it holds because the call is authenticated as the app.

**Manifest JSON (proposal [I]; field names [V]):**

```json
{
  "name": "Nuera Dev",
  "url": "https://dev.nuera.studio",
  "description": "Nuera Dev (VPS-3) : clonage, branches, push et pull requests des dépôts autorisés.",
  "public": true,
  "redirect_url": "https://dev.nuera.studio/api/integrations/github/manifest/callback",
  "setup_url": "https://dev.nuera.studio/integrations/github/installation",
  "setup_on_update": true,
  "request_oauth_on_install": false,
  "hook_attributes": { "url": "https://dev.nuera.studio/api/integrations/github/webhook", "active": false },
  "default_permissions": {
    "metadata": "read",
    "contents": "write",
    "pull_requests": "write",
    "checks": "read",
    "statuses": "read",
    "issues": "read",
    "actions": "read"
  },
  "default_events": []
}
```

Notes:

- **Required fields.** Only `url` and `hook_attributes.url` are marked required [V]. `hook_attributes.active` "defaults to true" [V]. With `active: false` there is no webhook to secure, and Nuera Dev polls instead (§2.9). The UI can also deactivate the webhook ("deselect Active") [V].
- **Name.** It must be "unique across GitHub", at most 34 characters, and different from an existing account name [V]. Keep a fallback name ready, such as « Nuera Dev VPS-3 ».
- **Permission keys.** All keys above are valid App-permission keys. `workflows` only takes `write` [V].
- **`workflows` is left out on purpose.** Without it, a push that creates or modifies `.github/workflows/*` is rejected with "refusing to allow a GitHub App to create or update workflow … without `workflows` permission". This wording comes from community reports, not official docs [I]. Map it to a dedicated T4-style error offering « Ajouter le droit Workflows à l'application ».
- **`actions: read` is optional.** It gives workflow runs, which also serve as a fallback for CI status (§2.9).
- **Changing permissions later.** Each installation must accept the new permissions on GitHub [I]. Detect it: compare `installation.permissions` with the required set (§2.13).
- **Removing foreign installations.** `DELETE /app/installations/{id}` (`apps.deleteInstallation`) returns **202** under API 2026-03-10, because deletion moved to the background [V].

**localhost vs `dev.nuera.studio`.**

- `redirect_url` and `setup_url` are browser redirects, so a separate « Nuera Dev Local » app can point at `http://localhost:3000/…` [I].
- An app has one `setup_url` and up to 10 callback URLs [V]. The callback URLs only matter for user tokens, and when the app doesn't act for users "this field will be ignored" [V].
- Webhooks would need a public URL. With `active: false`, none is needed.
- Installation tokens don't depend on any URL. A local backend can therefore reuse the production app's private key from its environment [I]. Register a second app only to test the manifest flow itself.
- If user tokens are ever added: for loopback redirect URIs, GitHub ignores the port and recommends `127.0.0.1` or `::1` over `localhost` [V].

### 2.4 Authenticating as the app and minting tokens

**JWT** [V]:

- Algorithm RS256.
- `iat` = now − 60 s (to absorb clock drift).
- `exp` ≤ now + 10 min.
- `iss` = the **client ID** (recommended) or the app ID.

VPS-3 must run NTP [I].

**Installation token.**

`POST /app/installations/{installation_id}/access_tokens` with `Authorization: Bearer <JWT>`. Octokit: `apps.createInstallationAccessToken`. The body is optional:

```json
{ "repositories": ["nuera-os"], "permissions": { "contents": "write" } }
```

Response `201` (fields [V], values illustrative):

```json
{
  "token": "ghs_…(≈520 chars)…",
  "expires_at": "2026-11-04T21:13:00Z",
  "permissions": { "contents": "write", "metadata": "read" },
  "repository_selection": "selected",
  "repositories": [ { "id": 123, "name": "nuera-os", "full_name": "nuera-studio/nuera-os", "owner": { "login": "nuera-studio" }, "private": true } ]
}
```

Facts about these tokens:

- **Scope.** Without `repositories` / `repository_ids`, the token covers every repository the installation can reach. Without `permissions`, it gets all the app's permissions. You can list up to **500** repositories. A token can never exceed what the installation was granted [V].
- **Errors.** `401`, `403`, `404`, `422`. An expired token answers `401` [V].
- **Format.** Since the rollout that started 2026-04-27 and finished 2026-10-02, tokens are stateless `ghs_APPID_JWT`: about **520 characters**, two dots inside. Treat them as opaque. Check DB columns, regexes, log redaction and proxies [V].
- **Do not use the `X-GitHub-Stateless-S2S-Token` header.** GitHub stops honouring it on **2026-11-30** [V].
- **Revocation.** `DELETE /installation/token` returns `204` (`apps.revokeInstallationAccessToken`) [V]. Revoke push tokens right after the push [I]. Whether revocation works on stateless tokens is not stated.

**Octokit.** Versions on npm on 2026-11-04 [O]: `octokit` 5.0.5, `@octokit/app` 16.1.4, `@octokit/auth-app` 8.3.1, `@octokit/plugin-rest-endpoint-methods` 18.0.0.

- `new App({ appId, privateKey })` then `app.getInstallationOctokit(installationId)`. The SDK "will take care of regenerating an installation access token for you" [V].
- For per-repo, per-permission git tokens, use `@octokit/auth-app` directly:

  ```ts
  auth({ type: 'installation', installationId, repositoryNames: ['nuera-os'], permissions: { contents: 'write' } })
  // → { token, expiresAt, permissions, repositoryNames, … }
  ```

  It caches up to 15,000 tokens and invalidates them after 59 minutes [V].
- **Key format.** GitHub's keys are PKCS#1. The README mentions conversion to PKCS#8 for WebCrypto (browser section) [V]. If signing fails on the server, convert once with `openssl pkcs8 -topk8 -nocrypt` [I].

**API version.** Send `X-GitHub-Api-Version: 2026-03-10` on every REST call. Supported versions are `2026-03-10` and `2022-11-28`. The latter ends on 2028-03-10 and is used when the header is absent [V]. Breaking changes that touch this project [V]:

- `merge_commit_sha` is removed from pull request payloads.
- The singular `assignee` is removed (use `assignees`).
- `GET /rate_limit` loses the top-level `rate`; use `resources.core`.
- `DELETE /app/installations/{id}` returns `202`.

Octokit release notes don't mention 2026-03-10, so spike S11 must check type drift [V/I].

### 2.5 Permission matrix and per-operation down-scoping

| Operation | Endpoint or git command | GitHub App permission [V] | Token Nuera Dev requests [I] |
|---|---|---|---|
| list authorized repos | `GET /installation/repositories` | any installation token | default token (no body) |
| repo info | `GET /repos/{o}/{r}` | Metadata: read | `{metadata: read}` |
| branches | `GET /repos/{o}/{r}/branches`, `…/branches/{branch}` | Contents: read | `{contents: read}`, one repo |
| clone / fetch / pull | git smart HTTP | Contents ("Your app must have the "Contents" repository permission") [V] | `{contents: read}`, one repo |
| push | `git push` | Contents: write, plus Workflows: write if workflow files change [I] | `{contents: write}`, one repo |
| compare | `GET /repos/{o}/{r}/compare/{basehead}` | Contents: read | `{contents: read}` |
| create PR | `POST /repos/{o}/{r}/pulls` | Pull requests: write | `{pull_requests: write}` |
| get PR | `GET /repos/{o}/{r}/pulls/{n}` | Pull requests: read (the docs flag additional permissions) | `{pull_requests: read, contents: read}` |
| reviews | `GET /repos/{o}/{r}/pulls/{n}/reviews` | Pull requests: read | same |
| check runs / suites | `GET …/commits/{ref}/check-runs`, `…/check-suites` | Checks: read | `{checks: read}` |
| commit statuses | `GET …/commits/{ref}/status`, `…/statuses` | Commit statuses: read | `{statuses: read}` |
| issues (MCP) | `GET /repos/{o}/{r}/issues` | Issues: read | `{issues: read}` |
| workflow runs | `GET /repos/{o}/{r}/actions/runs` | Actions: read | `{actions: read}` |
| branch via API | `POST /repos/{o}/{r}/git/refs` | Contents: write | not needed: pushing a new branch creates it |

Which installation covers a repository: `GET /repos/{owner}/{repo}/installation` (`apps.getRepoInstallation`, JWT) [V].

### 2.6 Listing only the authorized repositories

1. With the JWT, call `GET /app/installations?per_page=100` (`apps.listInstallations`) [V]. Keep entries whose `account.id` is allowlisted. Read `id`, `account.login`, `account.type`, `repository_selection`, `permissions`, `suspended_at`, `suspended_by` and `html_url` [V].
2. For each installation, with its default token, call `GET /installation/repositories?per_page=100&page=n` (`apps.listReposAccessibleToInstallation`). It returns `{ total_count, repository_selection, repositories[] }` [V]. `per_page` max is 100 [V].
3. Merge the results for A1, grouped by `owner.login`. Repository fields used [I: standard repository object]: `id`, `full_name`, `name`, `owner.login`, `private`, `language`, `pushed_at`, `updated_at`, `default_branch`, `archived`, `html_url`, `clone_url`.
4. Mark « Déjà cloné » by matching the stored `projects.github_repo_id` against `id`. Use `id`, not the name, because repos can be renamed.
5. `Gérer l'accès` opens `installation.html_url` (an API field) [V].
6. Polling cost: send `If-None-Match` with the stored ETag. "Making a conditional request does not count against your primary rate limit if a 304 response is returned and the request was made while correctly authorized" [V].

### 2.7 Git over HTTPS without writing the token anywhere

**What not to do, and why.**

- **Token in the remote URL.** GitHub's documented example is `https://x-access-token:TOKEN@github.com/owner/repo.git` [V]. It ends up persisted in `.git/config`, logs and the process list.
- **Token in argv** (e.g. `git -c http.extraheader=…`). Process command lines are readable by every local user, because `hidepid=0` is the default ("Everybody may access all /proc/pid directories") [V].
- **`credential.helper store`.** That writes a plaintext file. Reset helpers instead: an empty `credential.helper` "resets the helper list to empty" [V].

**Recommended: an env-only runtime config.** From git-config: "If GIT_CONFIG_COUNT is set to a positive number, all environment pairs GIT_CONFIG_KEY_<n> and GIT_CONFIG_VALUE_<n> up to that number will be added to the process's runtime configuration … These environment variables will override values in configuration files, but will be overridden by any explicit options passed via git -c." [V]

Why `http.extraHeader`:

- "If more than one such entry exists, all of them are added as extra headers … an empty value will reset the extra headers to the empty list" [V].
- The `http.<url>.*` form only matches when scheme, host, port and path prefix match [V].
- A header bound to `https://github.com/` is therefore **not sent if the remote URL was changed** to another host. `GIT_ASKPASS` would answer any host that asks.
- This is exactly what GitHub's `actions/checkout` builds: ``AUTHORIZATION: basic ${base64('x-access-token:' + token)}`` under ``http.${origin}/.extraheader`` [V].

```ts
// Backend: run one network git command with a short-lived, repo-scoped token.
import { spawn } from 'node:child_process';

function gitWithToken(worktree: string, token: string, args: string[]) {
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  const cfg: Array<[string, string]> = [
    ['credential.helper', ''],                                   // reset every helper: nothing is ever stored
    ['http.https://github.com/.extraheader', ''],                // drop any inherited extraheader
    ['http.https://github.com/.extraheader', `AUTHORIZATION: basic ${basic}`],
    ['core.hooksPath', '/dev/null'],                             // repo hooks never run with a token in env [I]
    ['core.fsmonitor', 'false'],                                 // a repo-configured fsmonitor is code execution [I]
    ['http.proxy', ''], ['http.sslVerify', 'true'],              // a repo config can't route traffic through a proxy [I]
    ['protocol.allow', 'never'], ['protocol.https.allow', 'always'], // only https transport (submodules too) [I]
    ['safe.directory', worktree],                                // needed if the backend user ≠ worktree owner [V: protected config only]
  ];
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin', HOME: '/var/lib/nuera-dev/git-home', LANG: 'C.UTF-8',
    GIT_TERMINAL_PROMPT: '0',            // never prompt [V]
    GIT_ASKPASS: '/bin/false',           // overrides any repo core.askPass; on 401 git fails fast [I]
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', // ignore system/global config [V]
    GIT_CONFIG_COUNT: String(cfg.length),
  };
  cfg.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  return spawn('git', ['-C', worktree, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
}

// push to an explicit URL, never to the `origin` the worktree's config could redirect:
// gitWithToken(wt, token, ['push', `https://github.com/${owner}/${repo}.git`, `HEAD:refs/heads/${branch}`])
// clone: gitWithToken(parentDir, token, ['clone', `https://github.com/${owner}/${repo}.git`, dest])
```

Notes:

- **Git versions.** `GIT_CONFIG_COUNT` needs git ≥ 2.31 and `GIT_CONFIG_GLOBAL` needs ≥ 2.32 [I]. Check the version on VPS-3 (spike S2).
- **Commits stay separate.** W5 commits need no token. Run `git commit` without the token env, with `user.name`/`user.email` passed explicitly, so the project's own pre-commit hooks can still run.
- **Traces are redacted.** If tracing is enabled, git redacts `Authorization:` headers by default (`GIT_TRACE_REDACT`) [V]. Never set `GIT_TRACE_REDACT=0`.
- **`safe.directory`.** It "is only respected in protected configuration" [V]. Spike S2 must confirm that env-supplied config counts as command-line scope [I].

**Alternative: `GIT_ASKPASS`.** Git "will call this program with a suitable prompt as command-line argument and read the password from its STDOUT" [V]. The script must check the host itself:

```sh
#!/bin/sh
# /opt/nuera-dev/libexec/git-askpass — answers only github.com prompts; token comes from the env
case "$1" in
  "Username for 'https://github.com'"*)                 echo "x-access-token" ;;
  "Password for 'https://x-access-token@github.com'"*)  printf '%s\n' "$NUERA_GH_TOKEN" ;;
  *) exit 1 ;;
esac
```

The prompt strings are git's usual format [I]. Spike S2 must verify them on VPS-3's git.

Run it with the same env hardening as above: the `credential.helper` reset (so git has no helper to hand the credential to for storage), hooks off and the explicit URL. Set `GIT_ASKPASS=/opt/nuera-dev/libexec/git-askpass` and `NUERA_GH_TOKEN=<token>` instead of the two `extraheader` entries.

**Where the token is visible.** Only in the environment of `git` and its child `git-remote-https`, for the duration of the command. `/proc/<pid>/environ` "is governed by a ptrace access mode PTRACE_MODE_READ_FSCREDS check" [V], which means the same uid or root. Consequences [I]:

- Run network git commands as the **backend's** Unix user, not as the `claude` user. This is the hardened layout of `claude-code.md` §13.3.
- If both share one uid, a concurrently running Claude command could read the token while a push is in flight. The token is repo-scoped, lasts 1 hour and is revoked after the push, which bounds the damage.

**Claude-writable worktrees are hostile input.** Claude can edit `.git/hooks/*` and `.git/config` (hooks, `core.askPass`, `credential.helper`, `http.proxy`, `http.sslVerify`, remote URLs). Every git command the backend runs there with a token must therefore override those keys through env config, which takes precedence over files [V], and push to an explicit URL [I].

**Read-only Git inside Claude sessions (optional) [I].** Claude sessions get **no** write credential. If `git fetch` must work inside a session, configure a credential helper in the session environment that asks the backend for a `{contents: read}` token for that single repository. Git does not tell the helper whether it is fetching or pushing, so the same read-only token would be offered for a push. GitHub would refuse that push (403). This is how « rien ne part sur GitHub sans confirmation » becomes technically enforced.

### 2.8 REST endpoints, Octokit methods, and shapes

All method names below are verified against `@octokit/plugin-rest-endpoint-methods` `src/generated/endpoints.ts` [V]. Call them as `octokit.rest.<namespace>.<method>`.

| Purpose | Request | Octokit | Token (§2.5) |
|---|---|---|---|
| App identity | `GET /app` (JWT) | `apps.getAuthenticated` | JWT |
| Installations | `GET /app/installations` (JWT) | `apps.listInstallations` | JWT |
| One installation | `GET /app/installations/{installation_id}` (JWT) | `apps.getInstallation` | JWT |
| Installation for a repo | `GET /repos/{owner}/{repo}/installation` (JWT) | `apps.getRepoInstallation` | JWT |
| Mint token | `POST /app/installations/{installation_id}/access_tokens` | `apps.createInstallationAccessToken` | JWT |
| Revoke token | `DELETE /installation/token` | `apps.revokeInstallationAccessToken` | the token itself |
| Manifest exchange | `POST /app-manifests/{code}/conversions` | `apps.createFromManifest` | none |
| List repos | `GET /installation/repositories` | `apps.listReposAccessibleToInstallation` | installation |
| Get repo | `GET /repos/{owner}/{repo}` | `repos.get` | metadata:read |
| List branches | `GET /repos/{owner}/{repo}/branches` | `repos.listBranches` | contents:read |
| Get branch | `GET /repos/{owner}/{repo}/branches/{branch}` | `repos.getBranch` | contents:read |
| Compare | `GET /repos/{owner}/{repo}/compare/{basehead}` | `repos.compareCommitsWithBasehead` (legacy `repos.compareCommits`) | contents:read |
| Create PR | `POST /repos/{owner}/{repo}/pulls` | `pulls.create` | pull_requests:write |
| Get PR | `GET /repos/{owner}/{repo}/pulls/{pull_number}` | `pulls.get` | pull_requests:read |
| List PRs | `GET /repos/{owner}/{repo}/pulls` | `pulls.list` | pull_requests:read |
| Reviews | `GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews` | `pulls.listReviews` | pull_requests:read |
| Check runs | `GET /repos/{owner}/{repo}/commits/{ref}/check-runs` | `checks.listForRef` | checks:read |
| Check suites | `GET /repos/{owner}/{repo}/commits/{ref}/check-suites` | `checks.listSuitesForRef` | checks:read |
| Combined status | `GET /repos/{owner}/{repo}/commits/{ref}/status` | `repos.getCombinedStatusForRef` | statuses:read |
| Statuses | `GET /repos/{owner}/{repo}/commits/{ref}/statuses` | `repos.listCommitStatusesForRef` | statuses:read |
| Workflow runs | `GET /repos/{owner}/{repo}/actions/runs?head_sha=` | `actions.listWorkflowRunsForRepo` | actions:read |
| PAT fallback: me | `GET /user` | `users.getAuthenticated` | PAT |
| PAT fallback: repos | `GET /user/repos` | `repos.listForAuthenticatedUser` | PAT |
| Rate limit | `GET /rate_limit` | `rateLimit.get` | any |

**Shapes.** Only the fields Nuera Dev uses are shown.

`POST /repos/nuera-studio/nuera-os/pulls`. `head` and `base` are required, and `title` is required unless `issue` is given [V]:

```json
{ "title": "crm : colonnes glissables du pipeline", "head": "feature/crm-core", "base": "main",
  "body": "…", "draft": false, "maintainer_can_modify": true }
```

Response `201`, also the shape of `GET …/pulls/{n}` [V: listed fields]:

```json
{ "number": 57, "html_url": "https://github.com/nuera-studio/nuera-os/pull/57", "state": "open", "draft": false,
  "head": { "ref": "feature/crm-core", "sha": "a3f9c12…" }, "base": { "ref": "main" },
  "mergeable": null, "mergeable_state": "unknown", "merged": false, "merged_at": null,
  "requested_reviewers": [], "user": { "login": "nuera-dev[bot]" } }
```

- `mergeable: null` means GitHub "has started a background job to compute the mergeability". Re-poll later [V].
- The values of `mergeable_state` are not documented on that page [V]. Treat them as an opaque string; `clean`, `dirty`, `blocked`, `behind`, `unstable` and `draft` are what's usually seen [I].
- The `user.login` value is illustrative [I].

`GET …/commits/{ref}/check-runs?filter=latest&per_page=100` [V]:

```json
{ "total_count": 2, "check_runs": [
  { "id": 1, "name": "build", "status": "completed", "conclusion": "success",
    "started_at": "…", "completed_at": "…", "html_url": "…", "details_url": "…", "app": { "slug": "github-actions" } } ] }
```

- `status` is one of `queued`, `in_progress`, `completed`, `waiting`, `requested`, `pending`.
- `conclusion` is one of `success`, `failure`, `neutral`, `cancelled`, `skipped`, `timed_out`, `action_required`, `null`.
- Beyond 1,000 check suites on a ref, only the 1,000 most recent are used [V].

`GET …/commits/{ref}/status` [V]:

```json
{ "state": "pending", "sha": "a3f9c12…", "total_count": 0, "statuses": [
  { "context": "coolify/preview", "state": "success", "description": "…", "target_url": "…", "updated_at": "…" } ] }
```

The combined state is "pending if there are no statuses or a context is pending" [V]. With `total_count = 0` the state is `pending`, so treat it as « aucun statut », not as pending [I].

`GET …/pulls/{n}/reviews` returns `[{ "id", "user": {"login"}, "state", "submitted_at", "commit_id" }]`. The states are `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`, `PENDING` [I: GraphQL `PullRequestReviewState`, verify].

`GET …/compare/main...feature/crm-core` [V]:

```json
{ "status": "ahead", "ahead_by": 3, "behind_by": 0, "total_commits": 3,
  "merge_base_commit": { "sha": "…" }, "commits": [ … ], "files": [ … ], "html_url": "…" }
```

- `status` is one of `diverged`, `ahead`, `behind`, `identical`.
- Without pagination, at most 250 commits are returned.
- `files` holds up to 300 files and appears on the first page only [V].

`GET …/branches?per_page=100` returns `[{ "name": "main", "commit": { "sha": "…" }, "protected": true }]` [I: standard fields].

### 2.9 Tracking a pull request (status, checks, reviews)

**When to poll [I].**

- While a PR has `state=open`: every 2 minutes while a page that shows it is open, otherwise every 15 minutes.
- Always use ETags (304 is free) [V].
- Webhooks are optional and would need `active: true`, a public endpoint and HMAC verification with `webhook_secret`. GitHub recommends webhooks over polling [V].

**What each poll does [I].**

1. `pulls.get` gives `state`, `draft`, `merged`/`merged_at`, `head.sha`, `mergeable`, `mergeable_state`.
2. `checks.listForRef(head.sha, filter=latest)` and `repos.getCombinedStatusForRef(head.sha)`.
3. `pulls.listReviews`: keep the latest review per reviewer and ignore `COMMENTED` when deciding.

**Badge values derived from those calls [I].**

- **CI:**
  - `echec` if any check run concludes `failure`, `timed_out`, `action_required` or `cancelled`, or the combined state is `failure`.
  - `en_cours` if any check run is not `completed`, or the combined state is `pending` with `total_count > 0`.
  - `reussi` if at least one check or status exists and all are green (`success`, `neutral`, `skipped`).
  - `aucun` otherwise.
- **Reviews:**
  - `changements_demandes` if any reviewer's latest review is `CHANGES_REQUESTED`.
  - `approuvee` if at least one approval exists and no changes are requested.
  - `en_attente` if `requested_reviewers` is not empty.
  - `aucune` otherwise.
- **Optional:** GraphQL `reviewDecision` and `statusCheckRollup` give the same information, aware of branch protection, in one request [I].

### 2.10 Fine-grained PAT fallback (env only)

**Creating the tokens.**

- One token per resource owner [V], so `nuera-studio` and `ethanthedevelop` need one each.
- Repository access: « Only select repositories ».
- Permissions: Contents RW, Pull requests RW, Metadata R, Commit statuses R, Issues R, Actions R.
- There is no Checks permission for PATs: the Checks API is unsupported [V].
- Organization approval may be required. While pending, the token can only read public resources [V].

**Expiry.**

- The default is 30 days. Non-expiring tokens are allowed unless a policy forbids them [V].
- GitHub sends a response header `GitHub-Authentication-Token-Expiration` "indicating the token's expiration date" (2021 changelog) [V].
- The value looks like `2021-10-07 19:07:53 UTC` (seen in a 2021 example) and is absent when the token has no expiry [I]. Browsers can't read it (CORS), but server-side code can [I].

**Validating a token.**

- `GET /user` → `200`. Read `login`, `id`, `type` and the expiry header.
- Prefix `github_pat_` means fine-grained; `ghp_` means classic, which should be rejected [V: credential types reference].
- The API cannot read back a fine-grained token's permissions [I]. Probe instead:
  - `GET /repos/{o}/{r}` checks metadata;
  - `GET …/branches?per_page=1` checks contents:read;
  - `GET …/pulls?per_page=1` checks PR read.
- On failure, read `X-Accepted-GitHub-Permissions` (the permission sets the endpoint needs) [V]. The body says "Resource not accessible by personal access token" [V].
- For private resources, GitHub returns `404` instead of `403` [V].
- Write access cannot be probed without side effects. `git push --dry-run` contacts receive-pack and may reveal it (spike S5) [I].

**Listing and checks.**

- Listing repos: `GET /user/repos?per_page=100` is available to fine-grained PATs [V]. Whether the results are limited to the selected repositories is **not documented** (spike S5) [I].
- PR checks with a PAT: use commit statuses plus `GET …/actions/runs?head_sha=…`. Both are available to fine-grained PATs [V].

### 2.11 Why not an OAuth App, and when user tokens would matter

OAuth Apps get all of the user's accessible resources, coarse scopes and long-lived tokens [V]. Rejected.

If PRs must be authored **as the human** instead of `nuera-dev[bot]`, the GitHub App can also issue user access tokens [V]:

- the user token (`ghu_`) expires after 8 hours;
- the refresh token (`ghr_`) expires after 6 months;
- refresh with `POST https://github.com/login/oauth/access_token` and `grant_type=refresh_token`.

That would be the only GitHub case where T7's « Renouvelez l'accès avant le 12 novembre » means something (the refresh-token expiry). This is not recommended for v1 [I].

### 2.12 What Nuera Dev stores (GitHub)

| Item | Where | Encrypted |
|---|---|---|
| `appId`, `clientId`, `slug`, `name`, `htmlUrl`, `owner.login`, `public`, `permissionsRequested`, `createdAt` | `integrations_github_app` | no |
| `privateKeyPem` | same row | **yes** (§7.1) |
| `clientSecret`, `webhookSecret` | same row | **yes**. The client secret stays unused unless user tokens are added |
| allowlisted accounts `{ accountId, login, type }` | config | no |
| installations `{ installationId, accountId, login, type, repositorySelection, permissions, suspendedAt, suspendedBy, htmlUrl, lastSyncAt }` | `github_installations` | no |
| repo cache `{ repoId, fullName, private, language, defaultBranch, pushedAt, installationId, etag }` | `github_repos` | no |
| projects `{ githubRepoId, fullName, installationId }` | `projects` | no |
| tracked PRs `{ number, headRef, headSha, state, ci, reviews, etag(s), lastPolledAt }` | `pull_requests` | no |
| **never stored:** JWTs, installation tokens (memory only, ≤ 1 h), base64 Basic headers | — | — |

### 2.13 GitHub status and diagnostic (D07 tile, `Vérifier la connexion`)

| Step | Request | Outcome → status [I] |
|---|---|---|
| 1 | JWT → `GET /app` | `200` → continue. `401` → `a_reconnecter`: « La clé privée de l'application a été révoquée ou remplacée » (action: app settings `htmlUrl`, generate a new key, then « Importer la clé »). Network error or 5xx → `erreur` |
| 2 | `GET /app/installations` | an allowlisted installation with `suspended_at = null` → continue. None → `a_reconnecter` « Application non installée » (action: `https://github.com/apps/{slug}/installations/new`). Suspended → `a_reconnecter` « Installation suspendue par {suspended_by.login} » (action: `installation.html_url`) |
| 3 | `POST …/access_tokens` per installation | `201` → OK. `403`/`404` → `a_reconnecter`. The docs don't say which code means suspended and which means deleted [V], so treat both as « accès retiré » |
| 4 | compare `installation.permissions` with the required set | missing → `a_reconnecter` « Droits à accepter sur GitHub » |
| 5 | `GET /installation/repositories` (ETag) | counts per installation → « 12 dépôts ». Each project whose repo has disappeared → project-level « Dépôt retiré de l'installation » (the T7 « après » case, for that project only) |
| 6 | headers `x-ratelimit-remaining` / `x-ratelimit-reset` [V] | below 10% → warning in the diagnostic. `403`/`429` with `retry-after` → `erreur` (transient) |
| 7 (optional, manual check only) | `git ls-remote https://github.com/{o}/{r}.git HEAD` with a contents:read token (§2.7) | proves the git transport. Failure → `erreur` with the git stderr (redacted) |

**What the tile shows.**

- `DROITS`: rendered from `installation.permissions`, for example « Contenu · pull requests · lecture et écriture ; issues, checks et statuts en lecture ».
- `DERNIÈRE VÉRIFICATION`: the last check, using `lastOkAt` and `outcome`.
- **Expiry line:** for the App mode there is nothing to expire (§9.1). For the PAT fallback, `expire_bientot` starts 7 days before the date in `GitHub-Authentication-Token-Expiration`. That is the T7 « avant » banner.

---

## 3. Coolify v4

### 3.1 Platform facts

**Versions.** The latest release is **v4.6.0**, published 2026-11-02 (GitHub releases API) [V]. Previous releases are 4.5.3 (2026-10-28), 4.5.2, 4.5.1 and 4.5.0 (2026-10-23) [V]. The `v4.x` branch is ahead of the release: for example `cancel_previous` on `/deploy` is in the branch spec but absent from the v4.6.0 spec [O]. Read `GET /api/v1/version` first and adapt to it.

**Base URL and liveness.**

- Base URL: `https://<coolify-domain>/api/v1` [V].
- Liveness: `GET /api/health` and `GET /api/v1/health`. No Bearer token is needed; the response is the text `OK` [V: docs + `OtherController::healthcheck`].

**Authentication.**

- `Authorization: Bearer <id>|<secret>`. The token "must be sent exactly as displayed when created" [V].
- The `id` part (before `|`) is not secret and can serve as a display fingerprint, e.g. « jeton n°67 » [I].

**Enabling the API.** On self-hosted instances "an administrator must also enable API access" [V].

**Allowed IPs.**

- If set, the caller must match. Otherwise the API answers `403` with `{"success":false,"message":"You are not allowed to access the API."}` [V: docs + `ApiIpAllowed`].
- The same list applies to `/mcp` [V].
- **VPS-3's IP must be allowlisted** if Coolify runs on another host.

**Tokens.**

- Created under « Keys & Tokens → API Tokens » while the right team is active. Shown only once [V].
- Expiry options: 7, 30, 60 or 90 days, 1 year, or Never [V].
- "Coolify checks hourly for tokens that expire within 7 days" and sends the team's « API token expiring » notifications. Since 4.6 the warning comes 7 days ahead instead of 1 day [V].
- Since 4.6, tokens can be paused and resumed; "A paused token cannot authenticate to the API or the MCP server" [V].
- A token belongs to the user and the active team that created it. It becomes invalid if that user leaves the team [V].
- **The API exposes no endpoint that returns a token's expiry date** [V: none documented].

**Abilities.**

| Source | Abilities listed |
|---|---|
| Docs [V] | `read`, `read:sensitive`, `write`, `deploy`, `root` |
| v4.6.0 routes [V: `routes/api.php`] | the same, plus `delete` (a separate ability since 4.6: "tokens with only `write` can no longer delete") and `write:sensitive` (instance email settings) |

- Sensitive values (logs, env values, compose…) are visible only when the token has `read:sensitive` or `root` **and** its user is a team admin or owner [V: `ApiSensitiveData` middleware].
- Members can only create `read` tokens [V].

**Scoped tokens (4.6).**

- A token can be « whole team or selected projects, environments or resources » [V: release notes, PR #12329].
- A scoped token can only reach the routes `applications`, `services`, `databases`, `projects`, `deploy`, `deployments`, `resources` and `version`.
- Anything else answers `403 {"message":"This API token is limited to selected projects, environments, or resources, so it cannot use this endpoint."}` [V: `ApiAbility::SCOPED_ACCESS_ROUTES`].
- **So a scoped token cannot call `GET /team` or `GET /servers`.** Over MCP, team-level tools are hidden and server lists come back empty [V].

**Mutations are POST since recent versions.** `GET /deploy` and `GET /applications/{uuid}/start|stop|restart` now answer `405 {"message":"This endpoint has changed to a POST request."}` [V: `routes/api.php`, `OtherController::post_required`]. Older blog posts that show `GET /api/v1/deploy?uuid=` are obsolete.

### 3.2 Read endpoints for the dashboard

| Purpose | Request | Ability [V: routes] | Scoped token OK [V] | Response, fields used |
|---|---|---|---|---|
| Liveness | `GET /api/health` | none | n/a | text `OK` |
| Version + token check | `GET /api/v1/version` | `read` | yes | text. Source returns `config('constants.coolify.version')`; spec example `v4.0.0` [V]. Treat it as an opaque semver-ish string [I] |
| Team of the token | `GET /api/v1/team` (alias `/teams/current`) | `read` | **no** (403) | `Team { id, name, description, personal_team, … }` |
| Applications | `GET /api/v1/applications[?tag=]` | `read` | yes. Only in-scope apps are returned [I] | `Application[]`, see below |
| One application | `GET /api/v1/applications/{uuid}` | `read` | yes | `Application` |
| Deployments of an app | `GET /api/v1/deployments/applications/{uuid}?skip=0&take=10` | `read` | yes | **`{ "count": n, "deployments": ApplicationDeploymentQueue[] }`**. The spec wrongly says `Application[]`; the controller returns `Application::deployments()` [V: source] |
| One deployment | `GET /api/v1/deployments/{uuid}` | `read` | yes | `ApplicationDeploymentQueue`. `logs` is hidden unless the token can read sensitive data [V] |
| Running deployments | `GET /api/v1/deployments` | `read` | yes | deployments with status `queued` or `in_progress` only [V] |
| Container logs | `GET /api/v1/applications/{uuid}/logs?lines=100&show_timestamps=true` | **`read:sensitive`** | yes | `{ "logs": "…" }`. `lines` goes up to 10000 or `all` [V] |
| Preview deployments | `GET /api/v1/applications/{uuid}/previews` | `read` | yes | `ApplicationPreview[]` |
| Env var names | `GET /api/v1/applications/{uuid}/envs` | `read` (values need `read:sensitive`) | yes | `EnvironmentVariable[]` |
| Resources | `GET /api/v1/resources` | `read` | yes | `[{ uuid, name, description, type, status, environment_id, created_at, updated_at }]`. `type` is `application`, `service` or `standalone-<engine>`; `status` looks like `running:healthy` or `exited:unhealthy` [V] |
| Projects / environments | `GET /api/v1/projects`, `/projects/{uuid}/environments`, `/projects/{uuid}/{env_name_or_uuid}` | `read` | yes | `Project { id, uuid, name, description }`, `Environment { id, name, project_id, description, … }` |
| Servers | `GET /api/v1/servers`, `/servers/{uuid}`, `/servers/{uuid}/resources` | `read` | **no** | `Server { uuid, name, ip, proxy_type, unreachable_count, settings { is_reachable, is_usable, … } }`; resources `[{ id, uuid, name, type, status, … }]` |

**`Application` fields Nuera Dev uses** (from 91 in the spec) [V]:

- `uuid`, `name`, `description`
- `fqdn` (the domains, comma-separated [I])
- `git_repository`, `git_branch`, `git_commit_sha`, `git_full_url`
- `build_pack` (`nixpacks|railpack|static|dockerfile|dockercompose`)
- `status`, `environment_id`, `destination_id`, `updated_at`
- `health_check_enabled`, `health_check_path`

Values like `http_basic_auth_password` and webhook secrets are redacted for non-sensitive tokens [I: `api.sensitive` middleware]. The UI must never display them.

**`ApplicationDeploymentQueue`** [V: spec + `ApplicationDeploymentStatus` enum + model]:

- Fields: `id`, `application_id`, `deployment_uuid`, `pull_request_id` (0 for a normal deployment [I]), `commit`, `commit_message`, `status`, `is_webhook`, `is_api`, `rollback`, `restart_only`, `force_rebuild`, `server_id`, `server_name`, `application_name`, `deployment_url`, `created_at`, `updated_at`, `logs`.
- `status` ∈ `queued`, `in_progress`, `finished`, `failed`, `cancelled-by-user`.
- `logs` is a JSON string encoding entries `{ command, output, type, timestamp, hidden, batch }`. The `command` and `output` are passed through `redactLogText` [V: `addLogEntry`].
- Show only entries with `hidden: false` [I].

### 3.3 Mutating endpoints: gate them behind a confirmation

These are never called by the health check. The UI calls them only after a T8-style confirmation that names the action. The Coolify guardrail (P4) also forbids offering any of them on production resources.

| Action | Request [V] | Ability [V] | Response [V] |
|---|---|---|---|
| Deploy (by uuid(s) or tag, PR preview) | `POST /api/v1/deploy?uuid=<u1,u2>&force=false&pr=<n>`. A JSON body is also accepted | `deploy` | `{ "deployments": [ { "message", "resource_uuid", "deployment_uuid" } ] }`. `429` + `Retry-After: 60` when the queue is full. `404 {"message":"No resources found."}` |
| Start / stop / restart an app | `POST /api/v1/applications/{uuid}/start\|stop\|restart` | `deploy` | restart → `{ "message": "Restart request queued.", "deployment_uuid": "…" }` |
| Cancel a deployment | `POST /api/v1/deployments/{uuid}/cancel` | `deploy` | `400`-style message when not cancellable ("Current status: finished") |
| Rollback | `POST /api/v1/applications/{uuid}/rollback` | `deploy` | |
| Create a preview deployment | `POST /api/v1/applications/{uuid}/previews` | `deploy` | |
| Services / databases lifecycle | `POST /api/v1/services/{uuid}/start\|stop\|restart`, same for databases | `deploy` | |
| Update an app or its env vars | `PATCH /api/v1/applications/{uuid}`, `POST/PATCH …/envs`, `PATCH …/envs/bulk` | `write` | |
| Any delete | `DELETE …` | `delete` (4.6) | |
| Disable the API / enable or disable MCP | `POST /api/v1/disable`, `/api/v1/mcp/enable`, `/api/v1/mcp/disable` | `write` + instance admin | `{"message":"MCP server enabled."}` |

### 3.4 Error catalogue → Nuera status

| HTTP | Body [V: middleware/controllers] | Meaning | Status [I] |
|---|---|---|---|
| network error / 5xx / timeout on `/api/health` | — | instance down | `erreur` « Coolify ne répond plus depuis HH:MM » |
| 401 | `{"message":"Unauthenticated."}` | unknown, expired, revoked or paused token | `a_reconnecter` « Coolify refuse le jeton » |
| 400 | `{"message":"Invalid token.","docs":"https://coolify.io/docs/api-reference/authorization"}` | the token's user is no longer in the token's team | `a_reconnecter` |
| 403 | `{"message":"Missing required permissions: read:sensitive"}` (or any ability) | missing ability | `a_reconnecter` (perimeter too small) or a warning if the endpoint is optional |
| 403 | `{"message":"This API token is limited to selected projects, environments, or resources, so it cannot use this endpoint."}` | scoped token on a team-level route | expected for scoped tokens: record `scope = 'scoped'` |
| 403 | `{"success":false,"message":"API is disabled."}` | the API is switched off in Coolify | `erreur` « API désactivée dans Coolify » |
| 403 | `{"success":false,"message":"You are not allowed to access the API."}` | IP not allowlisted | `erreur` « Adresse de VPS-3 non autorisée » |
| 405 | `{"message":"This endpoint has changed to a POST request."}` | client bug (GET on a mutation) | `erreur` (ours) |
| 404 on `POST /mcp` | (`abort(404)`) | MCP server disabled on the instance | `erreur` « Serveur MCP désactivé dans Coolify » |
| 403 on `POST /mcp` | `{"message":"MCP server is disabled for this team."}` | MCP disabled for the team | `erreur` « MCP désactivé pour l'équipe » |
| 429 | `Retry-After` | deploy queue limit | transient warning (only on confirmed actions) |

### 3.5 The Coolify MCP server

**Built into Coolify.**

- Route `Mcp::web('/mcp', CoolifyServer::class)` with middleware `mcp.enabled`, `api.ip.allowed`, `auth:sanctum`, `api.token.team`, `mcp.team.enabled` [V: `routes/ai.php`, Laravel MCP].
- Endpoint `https://<your-domain>/mcp`, Streamable HTTP, `Authorization: Bearer <token>` [V: docs].

**Enabling it.**

- Instance level: an instance admin sets « Settings > Advanced > API and MCP > MCP server » to Enabled, or calls `POST /api/v1/mcp/enable` with a root-team `write`/`root` token. "Until you do this, `/mcp` returns `404`." [V]
- Team level: MCP is enabled by default (« Team > General »). Team admins and owners can disable it, and a disabled team answers 403 [V].

**Tools.**

- Server `Coolify` version `0.3.0`, with `maxPaginationLength = 100` [V: `CoolifyServer.php`].
- Tools "hide themselves when the token cannot use them (shouldRegister)". "MCP lists only the tools that the token's permissions allow" [V].
- By ability:
  - read: `list_*` / `get_*`, `get_current_team`, `get_infrastructure_overview`, `search_resources`, `list_unhealthy_resources`, `coolify_help`;
  - `deploy`: `deploy`, `control` (start/stop/restart; stop needs `confirm=true`), `cancel_deployment`, `rollback_application`;
  - `write` (or `delete` for deletes): `manage_*` and `create_*`;
  - `read:sensitive` + admin: `get_env_values`.
- Server instructions [V]: "Destructive actions need confirm=true: ask the user first". "Private keys, S3 secrets, tokens, passwords, and webhook URLs are never returned". "Full deploy logs are never returned; optional log summaries are best-effort redacted only."
- Verification recommended by Coolify: ask the client to call `get_current_team` or `get_infrastructure_overview` and "Confirm the result contains only the expected team's resources" [V].
- Coolify's guide for Claude Code: `claude mcp add --transport http coolify https://app.coolify.io/mcp --header "Authorization: Bearer …"` [V]. Nuera Dev replaces the static header with a `headersHelper` (§5.7).

**Community alternatives.** These are not recommended now that a built-in server exists:

- `@masonator/coolify-mcp` 3.9.0 (2026-10-02, stdio, env `COOLIFY_BASE_URL` + `COOLIFY_ACCESS_TOKEN`, also a `coolify-mcp-http` binary) [O: npm + README];
- `coolify-mcp-server` 4.1.1 (wrediam, 2026-05-31) [O].

This is the server the Figma card « MCP Coolify à reconnecter » refers to.

### 3.6 Recommended Coolify design

**The token, as the D2 drawer asks for it.**

- **Coolify ≥ 4.6:**
  - Create **one** token named « Nuera Dev · Développement ».
  - Access: **selected environments**, meaning every `development` or `preview` environment of the projects Nuera Dev works on.
  - Abilities: `read` + `read:sensitive` (« journaux, variables » in PÉRIMÈTRE), plus `deploy` only if the « Déploiements de prévisualisation » toggle is wanted.
  - Expiry: 90 days.
  - Production stays out of reach **by construction**: the token cannot see production resources. That is P4 enforced on the Coolify side [V: scoped tokens] [I: design].
- **Coolify < 4.6, or no environment split:** create the token inside a dedicated team « Développement » that holds only dev resources. This matches the current D2 copy « limité à l'équipe Développement » [V: team-bound tokens].
- **Do not** give `write`, `delete` or `root`. Coolify itself says « Avoid `root` for normal MCP clients » [V].
- **Optional second token:** a whole-team `read` token if the owner wants Nuera Dev to show production status or server health. It is never exposed to Claude [I].

**Validation when the token is pasted** (D2 « Reconnecter »). All calls are read-only.

1. `GET /api/health` → `OK`. Otherwise show « Coolify injoignable », and don't store the token.
2. `GET /api/v1/version` with the token → `200` means valid with `read`. Store `coolifyVersion`. Map 401/403/400 as in §3.4.
3. `GET /api/v1/team`:
   - `200` → **whole-team token**. Show the team name and warn if it isn't the « Développement » team.
   - `403` with the scoped message → **scoped token**, which is the recommended case.
4. `GET /api/v1/resources`, plus `GET /api/v1/projects` and `/projects/{uuid}/environments` → the list of visible environments, shown in PÉRIMÈTRE. **Block** saving if an environment named like `production`/`prod` is visible, unless the owner explicitly overrides [I].
5. `POST https://<coolify>/mcp` with an MCP probe (§5.6) → `tools/list`. Abilities are inferred from the tool names (`deploy`/`control` present → `deploy`; any `manage_*`/`create_*` → **refuse**, because the token has `write`). That gives PERMISSIONS ACCORDÉES without any mutating probe [V: tools filtered by ability] [I: inference rule].
6. The API cannot return the token's expiry (§3.1). The form needs an « Expire le » select mirroring Coolify's choices (7/30/60/90 days, 1 year, never). This is a design gap, §9.4. Store `declaredExpiresAt`.
7. Encrypt the token (§7.1), store it, and never send it back to the browser.

**What Nuera Dev stores.** `baseUrl`, `tokenCiphertext`, `tokenIdPrefix` (the part before `|`), `declaredExpiresAt`, `createdAt`, `scope: 'scoped'|'team'`, `teamName?`, `visibleEnvironments[]`, `abilities[]` (inferred), `coolifyVersion`, `mcpEnabled`, the per-project app mapping (§3.7), and the status fields (§7.2).

**Status** (every 15 min, on demand, and on hook failures for `mcp__coolify__*`):

- **Order of checks:** health, then version, then MCP probe.
- **Before the declared expiry:**
  - 7 days ahead: `expire_bientot`, i.e. the T7 « avant » banner.
  - Past the declared date: assume `a_reconnecter` even before the 401 arrives.
- `failingSince` gives « depuis 09:12 ».

**Diagnostic (`Voir le journal`).** Each step with HTTP status and duration: `GET /api/health → 200 OK (84 ms)`, then `GET /api/v1/version → 401 Unauthenticated.`, and so on. It also shows the Coolify version, the MCP era (modern or legacy) and the number of tools. The token is never shown, only « jeton n°67 ».

### 3.7 Mapping Coolify applications to Nuera projects [I]

- **Repository match.** Normalize `git_repository`. It can be `owner/repo` for GitHub-App sources or a full URL for public ones. Lowercase it, strip `https://github.com/` and `.git`, then compare with `projects.fullName`.
- **Branch match.** A project can map to several apps: one per environment, or one per branch through `git_branch`. Show the app whose `git_branch` equals the session branch first.
- **Deployment status.** `GET /deployments/applications/{uuid}?take=5` gives the latest deployments. `deployment_url` gives the link, `status` the badge.

---

## 4. Figma

### 4.1 Official MCP server options

| | Remote | Desktop (local) |
|---|---|---|
| URL | `https://mcp.figma.com/mcp` [V] | `http://127.0.0.1:3845/mcp` [V] |
| Auth | Figma account sign-in (OAuth) [V]. **PATs are not supported** by the remote server (Figma support, via forum) [V] | the running desktop app |
| Requirements | a client in Figma's MCP catalog. "Other developers must join a waitlist to add new clients" [V] | the Figma desktop app, Dev Mode, « Enable desktop MCP server », a Dev or Full seat on a paid plan [V] |
| Capabilities | everything, including writing to the canvas. Figma "strongly recommends the remote server" [V] | no canvas writing, no « send UI to Figma » [V] |
| VPS-3 (headless Linux) | **usable** (Claude Code is a catalog client) | **impossible** |

### 4.2 Connecting Claude Code

- Add the server: `claude mcp add --transport http figma https://mcp.figma.com/mcp`. With `--scope user` it applies to all projects [V].
- Sign in interactively: `/mcp` → `figma` → Authenticate → « Allow access » in the browser [V].
- Sign in from a shell: `claude mcp login figma`. On SSH or headless machines add `--no-browser`: the CLI "prints the authorization URL instead … paste the full redirect URL from your browser's address bar back at the prompt" [V: docs and local `--help`] [O].
- Plugin alternative: `claude plugin install figma@claude-plugins-official` bundles the server config and Figma skills [V]. On VPS-3, prefer the plain server entry [I]: the plugin's server would follow plugin scoping rules (`mcp__plugin_<plugin>_<server>__*` tool names) [V], which makes per-project gating harder.
- Observed on this machine [O]: `claude mcp list` prints `figma: https://mcp.figma.com/mcp (HTTP) - ✔ Connected`. `claude mcp get figma` prints:

```
figma:
  Scope: User config (available in all your projects)
  Status: ✔ Connected
  Type: http
  URL: https://mcp.figma.com/mcp

To remove this server, run: claude mcp remove figma -s user
```

### 4.3 Rate limits and `whoami`

**Limits** [V: « Rate limits & access »]. They apply to tools that *read* data, per minute on top of the daily or monthly cap.

| Seat | Starter | Professional | Organization | Enterprise |
|---|---|---|---|---|
| View / Collab | 20 per month | 20 per month | 20 per month | 20 per month |
| Full / Dev | — | 200 per day, 10 per minute | 200 per day, 15 per minute | 600 per day, 20 per minute |

- Exempt tools: `add_code_connect_map`, `create_new_file`, `generate_figma_design`, `whoami` [V]. Figma staff say limits depend on the plan that owns the file [I: forum].
- **`whoami`** is exempt from limits, so it is a free identity probe. Its result shape, observed through this session's Figma MCP [O] (values omitted):

```json
{ "whoami": { "user_id": "…", "handle": "…", "email": "…", "code_layers_enabled": true,
    "plans": [ { "name": "Nuera Studio", "seat": "Full", "tier": "pro", "key": "team::…", "role": "guest",
                 "specs_enabled": true, "code_layers_enabled": true } ] },
  "instructions": "For more details on rate limits and access, refer to https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/" }
```

- Observed [O]: the connected Figma account has a **Full seat on the « Nuera Studio » team (tier `pro`)**, which means 200 calls per day and 10 per minute for files owned by that team. Its other teams are `starter` with View seats (20 calls per month). **The Nuera Design file must belong to the « Nuera Studio » team** or reads will hit the 20-per-month cap [I].

### 4.4 Figma REST API token (optional)

- Header for a PAT: `X-Figma-Token: <PAT>` [V]. OAuth app tokens use `Authorization: Bearer` [I: standard; not on the page read].
- `GET https://api.figma.com/v1/me` needs scope `current_user:read`. It returns a `User { id, handle, img_url, email }`; `email` is "only present on the `/v1/me` endpoint" [V].
- Since 2025-04-28, PATs have a **maximum expiry of 90 days** and non-expiring PATs can't be created [V: changelog]. Plan access tokens last up to 365 days but are admin-managed [V].
- Granular scopes: `file_content:read`, `file_metadata:read`, `file_variables:read` (Enterprise only), `file_comments:read`. `files:read` is deprecated [V].
- When it's useful [I]: only if Nuera Dev itself shows Figma data outside Claude, such as file names or thumbnails in D04. It is **not needed** for the MCP integration. If added, it follows the D2 pattern: field, encryption, a declared or known expiry of 90 days at most, and T7 warnings.

### 4.5 Recommended Figma design

- **Stored secrets:** none. Stored data: `serverUrl`, `claudeServerName = "figma"`, per-project enablement, the last `claude mcp get` result, the last call per project (from hooks), and the account summary from an optional `whoami`: handle and plan names. Store the email only if the owner wants it.
- **One-time setup on VPS-3:** as the `claude` user, `claude mcp add --scope user --transport http figma https://mcp.figma.com/mcp`. That makes `claude mcp get` and `claude mcp login` work; sessions themselves use `--mcp-config`, see §5.7. Whether OAuth tokens are shared between the user-scope entry and an identical `--mcp-config` entry is spike **S8** [I].
- **Connect / Reconnect** (D1/D2 pattern): open the web terminal (PTY) running `claude mcp login figma --no-browser` as the `claude` user [V: command]. The owner opens the printed URL, clicks « Allow access », copies the failed `localhost` redirect URL from the address bar and pastes it into the terminal [V]. This mirrors T6 « Se reconnecter dans un terminal ». No form, no token.
- **ÉTAT** (D1):
  - « Connexion »: the plan name and handle from the last `whoami`. Example: « Nuera Studio · DevEthan » (see §9.6).
  - « Dernier appel »: from the hook bridge of `claude-code.md` §13.6. Each `PostToolUse` or `PostToolUseFailure` with `tool_name` matching `^mcp__figma__` records `{ at, projectId (from cwd), tool, ok }` [V: hook payload fields `tool_name`, `cwd`, `error`, `duration_ms`].
  - « Vérification »: every 15 minutes, `claude mcp get figma` → parse the `Status:` line (§5.6).
- **`Tester la connexion`:**
  1. An unauthenticated probe `POST https://mcp.figma.com/mcp`. Expected: `401` with `WWW-Authenticate: Bearer resource_metadata=…` [I: Figma follows the MCP auth spec, spike S12]. That proves reachability.
  2. Then `claude mcp get figma`.
  3. Optionally, `whoami` through a short non-interactive Claude run, which spends a little subscription usage but no Figma quota [I]: `claude -p "…call whoami…" --mcp-config figma.json --strict-mcp-config --allowedTools mcp__figma__whoami`. The flags exist [V]. `claude-code.md` §1.5 discusses whether `-p` with a saved login is acceptable, so keep this **manual only** or drop it.
- **PERMISSIONS ACCORDÉES:** Figma's OAuth consent for MCP doesn't let the user pick read versus write [I]. Write ability depends on seat and plan [V]. Make the list **Nuera Dev's own per-project policy**, enforced by Claude Code permission rules: deny `mcp__figma__use_figma`, `mcp__figma__generate_figma_design`, `mcp__figma__create_new_file`, `mcp__figma__upload_assets`, `mcp__figma__send_code_to_figma`, `mcp__figma__add_code_connect_map`, `mcp__figma__send_code_connect_mappings`, and the other write tools seen in the tool list [O]. Deny rules win over allow rules [V]. « Modifier les fichiers Figma · non accordé » then means « bloqué par Nuera Dev » (copy issue §9.7).
- **Status mapping:**
  - `✔ Connected` → `connecte`.
  - `! Needs authentication` → `a_reconnecter`.
  - `✘ Failed to connect` → `erreur` (show the appended detail).
  - A `PostToolUseFailure` whose `error` looks like 401/unauthorized → provisional `a_reconnecter` until the next `claude mcp get` confirms it [I].
  - Expiry can't be seen ahead of time: the token sits in Claude Code's store, and its storage format is undocumented. **So Figma has no T7 « avant » state**, only « après » (§9.2).

---

## 5. MCP servers in Claude Code

### 5.1 Configuration formats

`.mcp.json`, `--mcp-config` files and `claude mcp add-json` all use the same shape [V]:

```json
{
  "mcpServers": {
    "remote-http": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "X-MCP-Readonly": "true" },
      "headersHelper": "/opt/nuera-dev/bin/nuera-mcp-headers",
      "timeout": 30000
    },
    "legacy-sse": { "type": "sse", "url": "https://example.com/sse", "headers": { "Authorization": "Bearer ${SSE_TOKEN}" } },
    "ws-server":  { "type": "ws", "url": "wss://mcp.example.com/socket" },
    "local-stdio": { "type": "stdio", "command": "npx", "args": ["-y", "@playwright/mcp@latest"], "env": { "CACHE_DIR": "/tmp" } }
  }
}
```

- **Transports.** `http`, `sse` and `stdio` are documented. `ws` is also accepted (`claude mcp --help` describes `add-json` as "Add an MCP server (stdio, SSE, HTTP, or WebSocket)" [O]; example in the docs [V]).
- **Pre-registered OAuth clients.** Use `"oauth": { "clientId": "…", "callbackPort": 8080 }` together with `--client-secret` [V].
- **Per-server fields.** `timeout` is in milliseconds, and `alwaysLoad` controls tool search [V].
- **CLI forms** [V] [O]:
  - `claude mcp add --transport http <name> <url> [-H "Header: v"]`
  - `claude mcp add --transport sse <name> <url>`
  - `claude mcp add [-e KEY=v] <name> -- <command> [args…]`
  - With `--env`, put another option between it and the server name, so the name isn't parsed as a `KEY=value` pair [V].

### 5.2 Scopes, files, precedence, approvals

| Scope | Stored in | Loaded |
|---|---|---|
| local (default) | `~/.claude.json` (per project path) | that project only |
| project | `.mcp.json` at the repo root (version-controlled) | that project, **after approval** in interactive sessions |
| user | `~/.claude.json` | all projects |

- **Precedence:** local > project > user > plugin servers > claude.ai connectors. "fields are not merged across scopes" [V]. Managed servers (`managedMcpServers`, `managed-mcp.json`) rank above all of them [V].
- **Project approvals:** project servers need approval in interactive sessions. `claude mcp reset-project-choices` resets the choices. `enableAllProjectMcpServers` / `enabledMcpjsonServers` committed in an untrusted folder are ignored. `disabledMcpjsonServers` in any settings file still rejects a server. `claude -p` loads project servers without asking [V].
- **`--mcp-config <files or JSON strings…>`:** "Load MCP servers from JSON files or strings (space-separated)". With `-p`, Claude Code waits up to `MCP_TIMEOUT` (default 30 s) for pending servers [V].
- **`--strict-mcp-config`:** "Only use MCP servers from `--mcp-config`, ignoring all other MCP configurations" [V].
- **claude.ai connectors** (relevant with a Max subscription):
  - Turn them off with `"disableClaudeAiConnectors": true` in any settings scope, or `ENABLE_CLAUDEAI_MCP_SERVERS=false` in the environment.
  - "Servers passed explicitly via `--mcp-config` are unaffected" [V].
  - Nuera Dev sets both, defense in depth with `--strict-mcp-config` [I].

### 5.3 Variable expansion and credential stripping

- **Expansion.** `${VAR}` and `${VAR:-default}` work in `command`, `args`, `env`, `url` and `headers` [V].
  - An unset variable without a default stays as literal text.
  - An empty value counts as set.
  - In remote `url`/`headers`, credential variables such as `ANTHROPIC_API_KEY` are read as empty [V].
- **Credential stripping.** For a `headersHelper` declared in a project `.mcp.json` or a plugin, Claude Code removes every env var whose name looks like a credential (`TOKEN`, `SECRET`, `PASSWORD`, `KEY`, `AUTH`), except Git's `GIT_CONFIG_KEY_<n>`. Helpers declared at **user or local scope, or via `--mcp-config`** keep the environment [V].

### 5.4 `headersHelper` (dynamic headers)

All points below are [V]:

- **Output.** The command "must write a JSON object of string key-value pairs to stdout". It runs in a shell and is abandoned after **10 seconds**.
- **When it runs.** "fresh on each connection, at session start and on reconnect". If a tool call returns **401 or 403**, Claude Code "automatically re-runs the helper … reconnects with the fresh headers, and retries the call once". **This is what makes 1-hour GitHub tokens workable.**
- **Merging.** Dynamic headers override static `headers` that have the same name.
- **Environment.** The helper receives `CLAUDE_CODE_MCP_SERVER_NAME`, `CLAUDE_CODE_MCP_SERVER_URL` (and `CLAUDE_PLUGIN_ROOT` for plugins).
- **Working directory.** For `--mcp-config` servers it is the session's primary working directory. For project or local scope it is the declaring project directory. For user scope it is `~/.claude`.
- **Trust.** For **project `.mcp.json` and local-scope** servers, the helper only runs after the folder's trust dialog has been accepted. Until then the server connects with its static headers. "Trust without a dialog": `projects["<path>"].hasTrustDialogAccepted = true` in `~/.claude.json`. The docs state no trust requirement for `--mcp-config` servers [V], so assuming none is spike **S4** [I].
- **Headers during OAuth.** Since v2.1.299, configured headers other than `Authorization` are also sent on OAuth sign-in, refresh and revocation requests to the server's origin.

### 5.5 OAuth MCP servers: how authentication and expiry work

- **Sign-in.** A server returns `401 Unauthorized` with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource", scope="…"`. The client then discovers the authorization server through RFC 9728 metadata, registers, and runs PKCE. In the 2026-07-28 spec, Client ID Metadata Documents are preferred and dynamic registration is deprecated. The `resource` parameter (RFC 8707) and `iss` validation (RFC 9207) are required. "Invalid or expired tokens **MUST** receive a HTTP 401 response"; insufficient scope gives `403` with `error="insufficient_scope"` [V: MCP authorization spec].
- **In Claude Code.** A server is marked as needing authentication on 401/403. "Authentication tokens are stored securely and refreshed automatically" [V].
  - Revoke locally with « Clear authentication » in `/mcp` or `claude mcp logout <name>`.
  - `claude mcp remove` deletes the stored tokens but doesn't revoke them at the issuer [V].
  - `--callback-port` pins the localhost redirect port for pre-registered clients [V].
- **Storage on Linux.** `~/.claude/.credentials.json`, mode `0600` (under `CLAUDE_CONFIG_DIR` if set) [V]. MCP tokens sit under an `mcpOAuth` object keyed `serverName|…` [I: user bug reports, undocumented]. **Nuera Dev must not read or refresh these tokens.** A second refresher would rotate refresh tokens behind Claude Code's back, and the format may change [I].
- **How expiry shows up:**
  - `claude mcp list` / `get` show `! Needs authentication`, and so does the `/mcp` panel [V].
  - Tool calls fail, which the hooks see as `PostToolUseFailure.error`.
  - Bug reports describe missing auto-refresh and status checks that corrupted tokens [I: claudeissues, versions 2.1.104–2.1.274]. Pin a recent version, keep `claude mcp get` to about every 15 minutes, and re-check after upgrades (spike S9).

### 5.6 Health-checking MCP servers from the backend, safely

**Principles [I].**

- Never call tools that mutate. Only `server/discover`, `initialize` and `tools/list`, plus tool calls known to be read-only and cheap: Coolify `get_current_team`, Figma `whoami` (through Claude only).
- 10-second timeout, at most one retry, and every 15 minutes with jitter.
- Use the **same credential the session would get** (the helper's output) so the check reflects reality.

| Server type | Probe |
|---|---|
| HTTP + static/helper credential (Coolify, GitHub MCP) | direct HTTP probe from the backend (below), then `tools/list` |
| HTTP + OAuth owned by Claude Code (Figma) | unauthenticated POST (expect 401 + `WWW-Authenticate`) for reachability, plus `claude mcp get figma` for the auth state |
| stdio (Playwright) | `claude mcp get <name>`, which spawns the process briefly, or no probe (« vérifié au démarrage de la session ») |

**HTTP probe, dual-era.**

- Spec 2026-07-28 removed `initialize` and `Mcp-Session-Id`. Every POST must carry `MCP-Protocol-Version`, `Mcp-Method` (and `Mcp-Name` for `tools/call`, `resources/read` and `prompts/get`), and `Accept: application/json, text/event-stream` [V].
- A dual-era client "attempt[s] a modern request first". On `400` it inspects the body: a recognized modern JSON-RPC error means a modern server; anything else means fall back to `initialize` [V].

Step 1, modern (2026-07-28) [V: discover page]:

```http
POST /mcp HTTP/1.1
Host: coolify.nuera.studio
Authorization: Bearer <token from helper>
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2026-07-28
Mcp-Method: server/discover

{"jsonrpc":"2.0","id":"discover-1","method":"server/discover","params":{"_meta":{
  "io.modelcontextprotocol/protocolVersion":"2026-07-28",
  "io.modelcontextprotocol/clientInfo":{"name":"nuera-dev-healthcheck","version":"1.0.0"},
  "io.modelcontextprotocol/clientCapabilities":{}}}}
```

The result looks like `{"resultType":"complete","supportedVersions":["2026-07-28"],"capabilities":{"tools":{}},"_meta":{"io.modelcontextprotocol/serverInfo":{"name":"…","version":"…"}},"instructions":"…","ttlMs":3600000,"cacheScope":"public"}`. Then call `tools/list` the same way, with `Mcp-Method: tools/list`.

- An unsupported version returns `400` with code `-32022` and `data.supported` [V].
- An unknown method returns `404` with code `-32601` [V].
- A header mismatch returns `400` with code `-32020` [V].

Step 2, legacy fallback (2025-11-25). The body comes from the lifecycle page [V]:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},
 "clientInfo":{"name":"nuera-dev-healthcheck","version":"1.0.0"}}}
```

1. The server answers `{ protocolVersion, capabilities, serverInfo { name, version }, instructions? }` and may set an `Mcp-Session-Id` header [V].
2. Send `{"jsonrpc":"2.0","method":"notifications/initialized"}`, which should get `202`.
3. Send `tools/list` with `MCP-Protocol-Version: 2025-11-25` (and the session id if one was given).
4. End with `DELETE` and the session id; `405` is acceptable [V].

**Use the SDK instead of hand-rolling it [I].**

- `@modelcontextprotocol/client` 2.4.0 [O] implements 2026-07-28.
- `new Client({…}, { versionNegotiation: { mode: 'auto' } })` "probes with `server/discover` and falls back to `initialize` against a 2025-only server". `getProtocolEra()` returns `modern` or `legacy` [V: SDK v2 docs].
- The default mode is `legacy`, so set `auto` explicitly.
- v1 (`@modelcontextprotocol/sdk` 1.32.2 [O]) gets fixes for at least 6 months after 2026-07-27 [V].
- How to pass custom headers to the v2 transport isn't on the page read (spike S10).

**Results → status [I].**

| Probe result | Status |
|---|---|
| `200` + tools listed | `connecte`. Record `toolCount` and tool names; for Coolify, infer abilities (§3.6) |
| `401` (credential sent) | `a_reconnecter` |
| `403` + server-specific body | per server (§3.4) |
| `404` on the endpoint without a JSON-RPC body | `erreur` (MCP disabled or wrong URL) |
| network error, 5xx, timeout | `erreur` |

**Parsing `claude mcp get <name>`.** It is human text, not a stable API. Run it as the `claude` user, with `stdin=/dev/null` and a 30-second timeout.

Observed format (§4.2) [O]: `"<name>:"`, then indented `Scope:`, `Status:`, `Type:`, `URL:` lines.

Parse only `^\s*Status:\s*(.+)$` and map the documented strings [V]:

| `Status:` value | Nuera status |
|---|---|
| `✔ Connected` | `connecte` |
| `! Needs authentication` | `a_reconnecter` |
| `✘ Failed to connect…` | `erreur` |
| `⏸ Pending approval…` | config error: should not happen with `--mcp-config` |
| `✘ Rejected…` | config error |
| `⊘ Disabled for this project…` | `desactive` |
| `✘ Blocked by enterprise managed policy` | `erreur` |
| `not configured` | `jamais_verifie` (setup missing) |

- Anything else → `erreur` « état inconnu », with the raw output.
- **Redact the output before storing or showing it**, since `get` may print headers or env (§7.3) [I].

### 5.7 Recommended per-session MCP wiring for Nuera Dev [I]

**1. Generate one config file per session** outside the repository, e.g. `/var/lib/nuera-dev/sessions/<nueraId>/mcp.json`. It contains only the servers enabled for that project (D04 « Outils MCP du projet » and D1 « ACTIVÉ DANS »):

```json
{
  "mcpServers": {
    "figma":   { "type": "http", "url": "https://mcp.figma.com/mcp" },
    "github":  { "type": "http", "url": "https://api.githubcopilot.com/mcp/",
                 "headers": { "X-MCP-Readonly": "true", "X-MCP-Toolsets": "repos,issues,pull_requests" },
                 "headersHelper": "/opt/nuera-dev/bin/nuera-mcp-headers" },
    "coolify": { "type": "http", "url": "https://coolify.nuera.studio/mcp",
                 "headersHelper": "/opt/nuera-dev/bin/nuera-mcp-headers" }
  }
}
```

**2. Launch the session with it.** This plugs into the create command of `claude-code.md` §13.5. Repeat the flags on `--resume`.

```sh
ENABLE_CLAUDEAI_MCP_SERVERS=false NUERA_SESSION_ID=<nueraId> \
claude --bg … --mcp-config /var/lib/nuera-dev/sessions/<nueraId>/mcp.json --strict-mcp-config \
       --settings /var/lib/nuera-dev/sessions/<nueraId>/settings.json …
```

**3. The helper `nuera-mcp-headers`** is a tiny static binary with no secrets.

- It reads `CLAUDE_CODE_MCP_SERVER_NAME` [V] and `NUERA_SESSION_ID`, then connects to `/run/nuera-dev/mcp.sock` (mode 0660, group `nuera-mcp`).
- The backend checks the peer uid (`SO_PEERCRED`), that the session exists and is running, that the server is enabled for the session's project, and that it is not disabled everywhere.
- It answers with headers, for example:
  - `{"Authorization":"Bearer ghs_…"}`: a fresh token for the session's repository, `{metadata:read, contents:read, issues:read, pull_requests:read}`;
  - `{"Authorization":"Bearer 67|…"}`: the decrypted Coolify token.
- When refused, the helper exits non-zero and prints `{}`. Claude Code then connects without credentials and the server answers 401, which shows the server as needing auth [I].
- Residual risk: Claude can run the helper itself through Bash and read the token. The scoping limits the damage: read-only, one repository, 1 hour for GitHub, and dev environments only for Coolify [I].

**4. Per-session `settings.json`** (merged over user settings by `--settings` [V]):

- `"disableClaudeAiConnectors": true`.
- `permissions.deny` for the write tools that project policy refuses (Figma write tools §4.5; Coolify `mcp__coolify__deploy`, `mcp__coolify__control`, `mcp__coolify__rollback_application`, `mcp__coolify__cancel_deployment` unless « Déploiements de prévisualisation » is on).
- Rule syntax is `mcp__<server>__<tool>` or `mcp__<server>__*`. Deny wins [V].

**5. Why not `.mcp.json` in each repository**, as the D1 copy says (§9.5):

- It dirties the worktree, and W5 might commit it.
- It needs a per-project approval in interactive sessions [V], and its helper needs workspace trust [V].
- With `--strict-mcp-config`, the repo's own `.mcp.json` is ignored. Nuera Dev can still read it and show « déclarés par le dépôt, non activés ».
- If the team insists on `.mcp.json`, write it and add it to `.git/info/exclude` so it stays out of commits [I].

**6. Hook bridge.** Use `claude-code.md` §13.6 as is. The backend derives per-server « Dernier appel », and failures from `PostToolUse` / `PostToolUseFailure` whose `tool_name` matches `^mcp__(figma|github|coolify)__` [V: payload].

**7. Guardrail copy check.**

- « Un accès, un projet » holds because of `--strict-mcp-config`, no claude.ai connectors and no user-scope servers in sessions.
- « Production hors de portée » holds because of the Coolify token scope and the deny rules.

---

## 6. GitHub MCP server

### 6.1 Remote server

- **URL:** `https://api.githubcopilot.com/mcp/` [V].
- **Path variants:** `/readonly` (default toolsets, read-only), `/insiders`, `/x/{toolset}` (one toolset), `/x/{toolset}/readonly` [V].
- **Headers** [V]:
  - `X-MCP-Toolsets` (e.g. `repos,issues`);
  - `X-MCP-Tools` (an explicit tool list);
  - `X-MCP-Readonly` ("Enables only "read" tools");
  - `X-MCP-Lockdown` (hides public-issue content from users without push access; best effort, not a security boundary);
  - `X-MCP-Insiders`.
- **Toolsets:** the defaults are `context`, `repos`, `issues`, `pull_requests`, `users`. Others include `actions`, `labels`, `git`, `projects`… [V]. With an installation token, leave out `context` and `users` (no human identity) [I].
- **Auth:** OAuth by default, or a PAT as `Authorization: Bearer` [V].
  - **GitHub App installation tokens are not documented** for the remote server. A GitHub issue (#696) first reported a 400 "Authorization header is badly formatted", and a later comment says `ghs_` tokens now work [I] → spike **S3**.
  - "The GitHub MCP server is available to all GitHub users regardless of plan type". Copilot Business/Enterprise orgs need the « MCP servers in Copilot » policy; the docs don't say whether that applies to non-Copilot clients [V].
- **Claude Code setup in GitHub's guide** [V]: `claude mcp add-json github '{"type":"http","url":"https://api.githubcopilot.com/mcp","headers":{"Authorization":"Bearer YOUR_GITHUB_PAT"}}'`. On Windows `add-json` may say `Invalid input`; use `claude mcp add --transport http …` instead.

### 6.2 Local server (Docker or binary)

- **Run it:** `claude mcp add github -e GITHUB_PERSONAL_ACCESS_TOKEN=… -- docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server` [V].
- **Options:**
  - `GITHUB_TOOLSETS` (takes precedence over the flag);
  - `--read-only` / `GITHUB_READ_ONLY=1`;
  - `--lockdown-mode` / `GITHUB_LOCKDOWN_MODE=1` [V].
- **OAuth on the local server:** `GITHUB_OAUTH_CALLBACK_PORT` plus `-p 127.0.0.1:8085:8085`. The token is kept in memory only, and a PAT takes precedence [V].
- **GitHub App mode** (stdio only, "not available for the `http` command"): `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY_PATH` (or `GITHUB_APP_PRIVATE_KEY`). The server "refreshes the token before it expires", and "The private key can mint tokens for every repository and permission granted to the installation" [V].
  - **Rejected for Nuera Dev [I]:** the private key would sit inside Claude's session, readable by Bash under the same uid.

### 6.3 Recommended config for Nuera Dev [I]

**Primary.**

- The remote server with `X-MCP-Readonly: true` and `X-MCP-Toolsets: repos,issues,pull_requests`, as in §5.7.
- `Authorization` comes from `nuera-mcp-headers`, which mints an **installation token restricted to the project's repository** with `{metadata: read, contents: read, issues: read, pull_requests: read}`.
- The token expires after 1 hour. The automatic re-run of the helper on 401 [V] renews it transparently.
- Claude can read issues and PRs, « dans le périmètre de l'application » (D07 copy). It cannot comment, open PRs or push. PRs go through W5.

**If S3 shows that `ghs_` tokens are refused.** Use a dedicated read-only fine-grained PAT per owner (Contents R, Issues R, Pull requests R, Metadata R) for the MCP only. It is stored encrypted, its expiry is read from the expiry header, and T7 warnings apply. This contradicts « Aucun jeton n'est saisi à la main », so let the owner decide.

**Health check.** Mint the same token, run the §5.6 probe against `https://api.githubcopilot.com/mcp/` with the same headers, then `tools/list`. A healthy result contains `get_file_contents`, `issue_read` and `pull_request_read` (names from the docs' examples [V]).

---

## 7. Cross-cutting design

### 7.1 Secrets storage and encryption [I unless tagged]

**What counts as a secret.** The GitHub App `privateKeyPem`, `clientSecret` and `webhookSecret`; Coolify tokens; an optional Figma PAT; PAT fallbacks, which live in env only and are not stored. Nothing else is secret.

**Encryption.**

- AES-256-GCM (Node `crypto`), with a random 12-byte IV per encryption and a 16-byte tag.
- AAD = `nuera-dev:v1:<table>:<rowId>:<field>`, so a ciphertext can't be swapped into another field.
- Stored as `{ v: 1, kid, iv, tag, ct }`, base64.

**Master key.**

- 32 random bytes, never in the DB and never in the repository.
- Under systemd: `LoadCredential=nuera-secrets-key:/etc/nuera-dev/secrets.key` (or `LoadCredentialEncrypted=`). The service reads `$CREDENTIALS_DIRECTORY/nuera-secrets-key`. Access is "restricted to the service's user" and, "Unlike environment variables the credential data is not propagated down the process tree" [V: systemd credentials].
- In a container deployed by Coolify: use a mounted secret file, not an env var.

**Rotation.** Each record keeps its `kid`, and a background job re-encrypts records to the current key.

**Isolation.**

- The backend runs as Unix user `nuera` and Claude sessions as `claude` (hardened layout of `claude-code.md` §13.3).
- The `claude` user can't read the DB, the key or the backend's `/proc/<pid>/environ` [V: ptrace check].
- If both run as one uid, the protection is only « best effort ». Say so in Paramètres › Sécurité.

**Never to the browser.** The API returns `hasSecret`, `fingerprint` (e.g. « jeton n°67 », « clé ajoutée le 4 nov. ») and `expiresAt`, never the value. This is the D07 rule « Aucun secret n'est affiché ici » and D2's « n'est plus jamais affiché ».

**Never logged.** The redactor runs on every log line, diagnostic step and stored CLI output:
- exact-match replacement of every decrypted secret currently in memory, including its base64 and `x-access-token:` forms;
- the patterns below.

```ts
const REDACT = [
  /gh[opsur]_[A-Za-z0-9._-]{20,}/g,                       // incl. stateless ghs_ with dots, ~520 chars [V: format]
  /github_pat_[A-Za-z0-9_]{20,}/g,                        // fine-grained PAT [V: prefix]
  /\b\d+\|[A-Za-z0-9]{20,}\b/g,                           // Coolify/Sanctum "<id>|<secret>" [V: format, I: charset]
  /(authorization:\s*)(basic|bearer|token)\s+[^\s"',]+/gi,
  /x-access-token:[^@\s"']+/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
];
```

### 7.2 One status model, computed the same way everywhere

```ts
type IntegrationStatus =
  | 'connecte'        // last check OK
  | 'expire_bientot'  // OK, but a known expiry is < 7 days away → T7 "avant" banner; badge stays "Connecté"
  | 'a_reconnecter'   // the provider rejects the credential / grant / install → owner action at the provider ("Autorisation expirée")
  | 'erreur'          // provider unreachable, 5xx, timeout, rate limited, misconfiguration
  | 'desactive'       // enabled in no project (Playwright "Désactivé")
  | 'jamais_verifie';
```

**Mapping to the Figma badges.**

| Status | Badge |
|---|---|
| `connecte`, `expire_bientot` | Succès « Connecté » |
| `a_reconnecter` | Danger « Autorisation expirée » (D07). D01 says « Expiré » |
| `desactive` | Neutre « Désactivé » |
| `erreur` | needs a badge that isn't drawn. Proposal: Danger « Injoignable » or « Erreur » (§9.3) |

**Rules [I].**

- **Hysteresis.**
  - A definitive authentication answer goes to `a_reconnecter` after **one** confirming retry 30 seconds later. Definitive answers: GitHub 401 on `GET /app`, Coolify `401 Unauthenticated.`, `! Needs authentication`.
  - `erreur` needs **two** consecutive failed checks, so the UI doesn't flap.
  - One success clears either state.
- **`failingSince`** is the time of the first failure in the current streak. It shows as « depuis 09:12 » (Europe/Paris).
- **Cadence.**
  - Every 15 minutes per integration, with ±60 s jitter (« vérifiée toutes les 15 minutes »).
  - « Vérifier la connexion » / « Tester la connexion » run immediately, at most once per 10 s.
  - Events trigger a check: a hook `PostToolUseFailure` on `mcp__<server>__*`, a git push or fetch exiting with 401/403, a Coolify call answering 401 during normal use.
- **Expiry (T7).**
  - « avant » applies when an expiry is **known**: the PAT expiry header, Coolify `declaredExpiresAt`, a Figma PAT if added.
  - « après » applies when `a_reconnecter` follows a past expiry or a revocation. It says what stops (« Synchronisation, push et pull requests suspendus. Le travail local continue. ») and links to the issuer:
    - GitHub: `installation.html_url` or the install URL;
    - Coolify: « Keys & Tokens » at `<baseUrl>/security/api-tokens` [I: path];
    - Figma: the web terminal.
- **Surfacing.** Any move into `a_reconnecter` or `erreur` creates one notification (bell and D01 « Intégrations » tile) and one D07 banner per failing server, as in the design.

### 7.3 What the diagnostic (« Voir le journal ») shows

```ts
interface IntegrationCheck {
  id: string; integrationId: 'github' | 'coolify' | 'figma' | `mcp:${string}`;
  startedAt: string; durationMs: number;
  trigger: 'schedule' | 'manual' | 'hook' | 'git_failure' | 'startup';
  steps: Array<{
    name: string;                 // "GET /api/v1/version", "POST /mcp server/discover", "claude mcp get figma"
    ok: boolean; ms: number;
    httpStatus?: number;
    providerMessage?: string;     // sanitized body message, e.g. "Unauthenticated."
    headers?: Record<string, string>; // allow-listed only: x-github-request-id, x-ratelimit-remaining, x-ratelimit-reset,
                                      // retry-after, www-authenticate (resource_metadata/scope only), mcp era
    raw?: string;                 // redacted CLI output / stderr (git, claude mcp get)
  }>;
  result: { status: IntegrationStatus; reason?: string;
            action?: { label: string; kind: 'external' | 'terminal' | 'form'; url?: string } };
}
```

Keep the last 50 checks per integration. The journal page shows, from newest to oldest: time, trigger, the steps with HTTP codes, the derived status and reason, and the suggested action. A « Copier le diagnostic » button exports the already-redacted JSON.

### 7.4 Data model sketch [I]

```ts
interface McpServerRecord {
  id: 'figma' | 'github' | 'coolify' | 'playwright' | string; // also the Claude Code server name → tool prefix mcp__<id>__
  transport: 'http' | 'sse' | 'stdio' | 'ws';
  url?: string; command?: string; args?: string[];
  auth: { kind: 'claude_oauth' }                                   // Figma: grant lives in Claude Code
      | { kind: 'helper_github_installation'; permissions: Record<string, 'read' | 'write'> }
      | { kind: 'helper_secret'; secretRef: string; declaredExpiresAt?: string } // Coolify
      | { kind: 'none' };
  staticHeaders?: Record<string, string>;   // non-secret only (X-MCP-Readonly, X-MCP-Toolsets)
  toolPolicy: { deny: string[] };           // rendered into per-session permissions.deny
  enabledProjectIds: string[];
  status: IntegrationStatus; failingSince?: string; lastOkAt?: string; lastCheckId?: string;
  lastCall?: { at: string; projectId: string; tool: string; ok: boolean };
}
interface ProjectIntegrationBinding { projectId: string; githubRepoId: number; installationId: number;
  coolifyAppUuids: string[]; mcpServerIds: string[] }
```

### 7.5 Sensitive actions: confirmations and tokens

| Action | Confirmation (T8 pattern) | Credential used |
|---|---|---|
| Clone (A2) | the D03 step itself | `{contents: read}`, one repo, dropped after the clone |
| Sync / pull (D04 « Synchroniser ») | none (read-only) | `{contents: read}` |
| Push + PR (W5 « Préparer le commit ») | the W5 modal: files, message, branch, PR title | push `{contents: write}`, then `{pull_requests: write}`, both revoked after use |
| Coolify deploy / restart / stop (if ever exposed in the UI) | explicit modal naming the resource and environment. Production is refused by construction | the Coolify token (only if it has `deploy`) |
| Enable an MCP server for a project | the toggle, plus a summary of what Claude will be able to read or do | — |

---

## 8. Spikes to run before building (each one confirms an `[I]`)

| # | What to verify | How |
|---|---|---|
| S1 | Public app installable on the org and on `ethanthedevelop`. Setup redirect parameters (`installation_id`, `setup_action`). Flow for accepting changed permissions. `installation.html_url` format | register « Nuera Dev (test) » via the manifest, install twice, change one permission |
| S2 | Git on VPS-3 (≥ 2.32?). `GIT_CONFIG_*` extraheader push. Nothing persisted (`git config --show-origin -l`, no `~/.git-credentials`). Hooks disabled. `safe.directory` through env. Askpass prompt strings. Exact error text for a missing `workflows` permission | throwaway repo + a push touching `.github/workflows/x.yml` |
| S3 | Remote GitHub MCP accepts repo-scoped stateless `ghs_` tokens with `X-MCP-Readonly`. Tool names | probe §5.6 + one `issue_read` |
| S4 | `--mcp-config` + `--strict-mcp-config` exclude user-scope servers, plugin servers and claude.ai connectors. `headersHelper` runs for `--mcp-config` servers without trust. The helper receives `NUERA_SESSION_ID` | test session with a dummy helper logging its env |
| S5 | Fine-grained PAT: is `/user/repos` limited to the selected repos? Format of `GitHub-Authentication-Token-Expiration`. Does `git push --dry-run` detect missing write? | two PATs with different selections |
| S6 | Coolify 4.6 scoped token (dev env, `read` + `read:sensitive` + `deploy`): only in-scope apps returned; `/team` → scoped 403; MCP `tools/list` per ability; bodies for expired, paused and revoked tokens | Coolify test team |
| S7 | Protocol era of Coolify's Laravel MCP (modern or legacy) | SDK `getProtocolEra()` |
| S8 | Figma OAuth: does a login on the user-scope `figma` entry also serve a session using an identical `--mcp-config` entry? Full `claude mcp login figma --no-browser` run in the web terminal | VPS-3 |
| S9 | `claude mcp get` output on Linux (same as Windows?). Effect of 15-minute checks on OAuth tokens on the pinned version | 24 h soak |
| S10 | `@modelcontextprotocol/client` 2.4 with `mode: 'auto'` against Figma (401 handling), GitHub and Coolify. How to pass headers | small script |
| S11 | Octokit 18.x types with `X-GitHub-Api-Version: 2026-03-10` (missing `merge_commit_sha`) | typecheck |
| S12 | Unauthenticated `POST https://mcp.figma.com/mcp` → 401 + `WWW-Authenticate` with `resource_metadata` | curl |

---

## 9. Copy and design inconsistencies to arbitrate

1. **D07 « Expiration : jeton d'installation renouvelé automatiquement par GitHub. »** GitHub doesn't renew anything: Nuera Dev mints a new 1-hour token from the app's private key [V]. Proposal: « Jeton d'une heure, renouvelé automatiquement par Nuera Dev ; aucune date d'expiration. »
2. **T7's GitHub example (« bientôt expirée … avant le 12 novembre ») can't happen with the GitHub App**, which has no expiry. It applies to the PAT fallback or to user tokens (6-month refresh [V]). Keep T7 « avant » for Coolify (declared expiry) and a possible Figma PAT. For GitHub keep only « après »: uninstalled, suspended, repo removed, key revoked. Figma OAuth has no visible expiry, so only « après » applies there too.
3. **D07 banner « Coolify ne répond plus depuis 09:12 » + « Le jeton … a expiré »** mixes « unreachable » and « credential rejected ». Proposal:
   - `erreur` → « Coolify ne répond plus depuis 09:12 »;
   - `a_reconnecter` → « Coolify refuse le jeton depuis 09:12 ».
   An `erreur` badge also needs a design (« Injoignable »).
4. **D2 « limité à l'équipe Développement »** is fine for Coolify < 4.6. On 4.6, « limité aux environnements de développement » is more precise and safer. Because the API doesn't expose a token's expiry, **the D2 form needs an « Expire le » choice**; otherwise the T7 « avant » warning can't be computed.
5. **D1 « CONFIGURATION · .mcp.json de chaque projet activé »**. The recommended implementation generates a per-session config outside the repo (§5.7), which keeps worktrees clean and enforces isolation. Proposal: « Configuration générée par Nuera Dev pour chaque session (hors du dépôt) ».
6. **D1 « Connexion · compte nuera-studio »**. `nuera-studio` is the GitHub org name. Figma's identity is a user handle/email plus plans: `whoami` shows a « Nuera Studio » team, tier pro, Full seat [O]. Decide which to display, for example « Nuera Studio · <handle> ».
7. **D1 « PERMISSIONS ACCORDÉES … Les droits viennent de l'autorisation donnée dans Figma, révocable depuis Figma. »** Figma's MCP OAuth consent doesn't let the user choose read versus write [I]. « Modifier les fichiers Figma · non accordé » can only be enforced as a Nuera Dev rule (Claude Code deny rules, §4.5). Suggested copy: « Lecture autorisée par Figma ; modification bloquée par Nuera Dev pour ce projet. »
8. **D07 GitHub `DROITS` caption « … issues en lecture »** omits checks and statuses (read). They are needed for PR tracking. Suggest « issues, checks et statuts en lecture ».
9. **D03 « jamais par jeton collé à la main »** stays true only if the PAT fallback remains env-only (§2.2) and the GitHub-MCP fallback of §6.3 isn't adopted.

---

## 10. Sources (consulted 2026-11-04)

GitHub:

- App manifest flow: https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
- Create app from manifest, installation tokens, installations, `GET /app` (REST): https://docs.github.com/en/rest/apps/apps
- Installation repositories, token revocation: https://docs.github.com/en/rest/apps/installations
- Generating an installation access token: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
- JWT: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
- Authenticating as an installation (git `x-access-token`, Octokit `App`): https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
- Public vs private apps: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private
- Registering an app (name rules, webhook Active, callback, setup URL): https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app
- Setup URL: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url
- Callback URL: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url
- Loopback redirects: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
- Install link: https://docs.github.com/en/apps/sharing-github-apps/sharing-your-github-app
- Permissions per endpoint: https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
- Endpoints available to fine-grained PATs: https://docs.github.com/en/rest/authentication/endpoints-available-for-fine-grained-personal-access-tokens
- Managing PATs: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
- Token expiration header (2021): https://github.blog/changelog/2021-07-26-expiration-options-for-personal-access-tokens/
- Credential types and prefixes: https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/github-credential-types
- GitHub Apps vs OAuth apps: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps
- OAuth scopes: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
- Refreshing user tokens: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
- API versions: https://docs.github.com/en/rest/about-the-rest-api/api-versions
- Breaking changes: https://docs.github.com/en/rest/about-the-rest-api/breaking-changes
- Stateless installation tokens: https://github.blog/changelog/2026-10-02-stateless-github-app-installation-tokens-rolled-out/
- Rate limits: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- Best practices (conditional requests): https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
- Troubleshooting (`X-Accepted-GitHub-Permissions`): https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api
- Check runs: https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference
- Combined status: https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference
- Pull requests: https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request
- Compare: https://docs.github.com/en/rest/commits/commits#compare-two-commits
- `/user/repos`: https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user
- Triggering workflows with app tokens: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow
- Octokit endpoint map: https://github.com/octokit/plugin-rest-endpoint-methods.js/blob/main/src/generated/endpoints.ts
- Octokit releases: https://github.com/octokit/plugin-rest-endpoint-methods.js/releases
- `@octokit/auth-app`: https://github.com/octokit/auth-app.js
- `actions/checkout` extraheader: https://github.com/actions/checkout/blob/main/src/git-auth-helper.ts
- Workflows-permission push error (community): https://github.com/orgs/community/discussions/151442

Git and Linux:

- git-config (ENVIRONMENT, `http.extraHeader`, `http.<url>.*`, `safe.directory`, `credential.helper`): https://git-scm.com/docs/git-config
- git environment variables: https://git-scm.com/docs/git
- gitcredentials: https://git-scm.com/docs/gitcredentials
- git-credential: https://git-scm.com/docs/git-credential
- `/proc/pid/environ`: https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html
- `hidepid`: https://man7.org/linux/man-pages/man5/proc.5.html
- systemd credentials: https://systemd.io/CREDENTIALS/

Coolify:

- API overview: https://coolify.io/docs/api/overview
- Authorization: https://coolify.io/docs/api-reference/authorization
- Permissions: https://coolify.io/docs/api/permissions
- API tokens: https://coolify.io/docs/core/security/credentials/api-tokens
- MCP: https://coolify.io/docs/integrations/mcp, https://coolify.io/docs/mcp/setup, https://coolify.io/docs/mcp/how-mcp-works, https://coolify.io/docs/mcp/clients/claude-code
- Release v4.6.0: https://github.com/coollabsio/coolify/releases/tag/v4.6.0
- Scoped grants PR: https://github.com/coollabsio/coolify/pull/12329
- Source at tag v4.6.0:
  - https://github.com/coollabsio/coolify/blob/v4.6.0/openapi.json
  - https://github.com/coollabsio/coolify/blob/v4.6.0/routes/api.php
  - https://github.com/coollabsio/coolify/blob/v4.6.0/routes/ai.php
  - https://github.com/coollabsio/coolify/blob/v4.6.0/app/Mcp/Servers/CoolifyServer.php
  - https://github.com/coollabsio/coolify/blob/v4.6.0/app/Http/Middleware/ApiAbility.php (and `EnsureMcpEnabled.php`, `EnsureTeamMcpEnabled.php`, `ApiAllowed.php`, `ApiIpAllowed.php`, `ApiSensitiveData.php`)
  - https://github.com/coollabsio/coolify/blob/v4.6.0/app/Http/Controllers/Api/OtherController.php
  - https://github.com/coollabsio/coolify/blob/v4.6.0/app/Http/Controllers/Api/DeployController.php
  - https://github.com/coollabsio/coolify/blob/v4.6.0/app/Models/Application.php
  - https://github.com/coollabsio/coolify/blob/v4.6.0/app/Models/ApplicationDeploymentQueue.php
  - https://github.com/coollabsio/coolify/blob/v4.6.0/app/Enums/ApplicationDeploymentStatus.php
  - https://github.com/coollabsio/coolify/blob/v4.6.0/bootstrap/helpers/api.php
- Community MCP: https://github.com/StuMason/coolify-mcp (npm `@masonator/coolify-mcp`), https://github.com/wrediam/coolify-mcp-server

Figma:

- Remote server: https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/
- Desktop server: https://developers.figma.com/docs/figma-mcp-server/local-server-installation/
- Rate limits and access: https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/
- REST authentication: https://developers.figma.com/docs/rest-api/authentication/
- Personal access tokens: https://developers.figma.com/docs/rest-api/personal-access-tokens/
- Scopes: https://developers.figma.com/docs/rest-api/scopes/
- Users endpoints: https://developers.figma.com/docs/rest-api/users-endpoints/
- Users types: https://developers.figma.com/docs/rest-api/users-types/
- REST changelog (PAT 90-day cap): https://developers.figma.com/docs/rest-api/changelog/
- PATs not supported by the remote MCP (forum): https://forum.figma.com/suggest-a-feature-11/support-for-pat-personal-access-token-based-auth-in-figma-remote-mcp-47465

Claude Code and MCP:

- MCP in Claude Code (scopes, `.mcp.json`, expansion, `headersHelper`, OAuth, `claude mcp login`, statuses, connectors, tool search): https://code.claude.com/docs/en/mcp
- CLI reference (`--mcp-config`, `--strict-mcp-config`, `--settings`, `claude auth status`, `claude mcp login`): https://code.claude.com/docs/en/cli-reference
- Permissions (MCP rule syntax, deny > ask > allow): https://code.claude.com/docs/en/permissions
- Hooks (MCP matchers, `PostToolUse` / `PostToolUseFailure` payloads, HTTP hooks): https://code.claude.com/docs/en/hooks
- Authentication (credential storage on Linux): https://code.claude.com/docs/en/authentication
- MCP OAuth bug reports (`mcpOAuth`, refresh, status-check corruption): https://claudeissues.com/issue/47296-bug-http-mcp-server-behind-basic-auth-stale-mcpoauth-entry-in-credentials-json-f , https://claudeissues.com/issue/89671-http-mcp-oauth-valid-token-silently-corrupted-by-status-check-wrong-redirecturi , https://claudeissues.com/issue/28262-mcp-oauth-tokens-not-auto-refreshing-despite-valid-refresh-tokens
- MCP spec 2026-07-28:
  - Streamable HTTP: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
  - Versioning: https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
  - Discover: https://modelcontextprotocol.io/specification/2026-07-28/server/discover
  - Authorization: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
  - Changelog: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/changelog.mdx
- MCP spec 2025-11-25 lifecycle: https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- SDK v2 version negotiation: https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.md

GitHub MCP server:

- README: https://github.com/github/github-mcp-server
- Remote server headers and paths: https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md
- Claude install guide: https://github.com/github/github-mcp-server/blob/main/docs/installation-guides/install-claude.md
- GitHub App auth (local): https://github.com/github/github-mcp-server/blob/main/docs/github-app-auth.md
- Installation-token issue: https://github.com/github/github-mcp-server/issues/696
- Setup and policies: https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/set-up-the-github-mcp-server
