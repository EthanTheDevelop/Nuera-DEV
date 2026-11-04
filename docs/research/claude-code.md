# Claude Code ⇄ Nuera Dev — integration research

> **Question.** How can Nuera Dev (a self-hosted, personal web app running on the owner's Linux VPS, "VPS-3") drive the **official, unmodified Claude Code CLI** with the owner's **Claude Max subscription** (not a pay-per-use API key), without ever touching the subscription's OAuth tokens and without unofficial proxies?
>
> **Research date:** 2026-11-04. **Docs read:** `code.claude.com/docs/en/*` (raw `.md` pages fetched with `curl`; the changelog's newest entry is **v2.1.318, November 4, 2026**). `docs.anthropic.com/en/docs/claude-code/*` and `docs.claude.com/en/docs/claude-code/*` answer **301 → `code.claude.com/docs/en/*`** (checked with `curl -I`). **Local CLI** used for read-only checks: **v2.1.280** (Windows, native install, *not logged in*). The docs are ~38 releases ahead of the local CLI, so version gates matter (see [§12](#12-version-gates-docs-v21318-vs-local-v21280)).

**Evidence legend** (used everywhere below)

| Tag | Meaning |
| :- | :- |
| **[DOC]** | Quoted from official Anthropic documentation or terms (URL given). Quotes are verbatim. |
| **[LOCAL]** | Observed on the local CLI v2.1.280 with read-only commands (`--help`, `auth status`, `agents --json`, `daemon status`, `doctor`). No session was started, no login/logout, no `setup-token`. |
| **[INF]** | Inference / engineering judgment. Not stated by Anthropic. |
| **[VERIFY]** | Not documented or not testable here; must be tested on the VPS (logged in, current version) before relying on it. |

---

## 0. TL;DR

1. **Allowed core** [DOC]: run the unmodified `claude` binary on the owner's own server, signed in to the owner's own Claude account through Anthropic's own login flow, and use it *interactively*. Anthropic explicitly says its credential rules don't prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code" ([legal](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)).
2. **The officially recommended pattern for exactly this use case is Remote Control** [DOC]: "To run Claude Code on your own always-on machine and drive it from other devices, use Remote Control, which is also available on Pro, Max, and Ultra plans" ([self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments)).
3. **Background sessions** (`claude --bg`, `claude agents --json`, `claude attach|logs|stop|rm|respawn`) are the right substrate for sessions that outlive the browser and Nuera's own process: they are hosted by Claude Code's own supervisor; they survive terminal close and supervisor restarts, **not** machine shutdown (but are resumable from the saved conversation) [DOC].
4. **Live I/O** [INF]: a server-side PTY running `claude attach <id>` bridged over WebSocket to xterm.js. **State** [DOC]: poll `claude agents --json --all` — documented as "the supported way to read session state from outside Claude Code". **Signals** [DOC]: hooks (command/http) + a status-line script posting to a localhost Nuera endpoint.
5. **Conversation view**: the official TUI (rendered in the browser) is the authoritative, interactive view. Around it, Nuera may show a *read-only journal* built from documented hook payloads (`prompt`, `tool_input`, `last_assistant_message`, `MessageDisplay.delta`…) and past history via the Agent SDK's local-file helpers `listSessions()`/`getSessionMessages()` ("Use them to build … transcript viewers") [DOC]. The JSONL transcript format itself is internal and unstable [DOC].
6. **Do not** build the chat on `claude -p` / `--input-format stream-json` / Agent SDK `query()` with the Max login (grey zone at best: "Developers building products or services … including those using the Agent SDK, should use API key authentication") [DOC]. **Do not** use `claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN`. **Never** read `~/.claude/.credentials.json`.
7. **"Connexion requise"**: `claude auth status --json` (exit code 1 when not logged in; `authMethod`; `loginExpiresAt` from v2.1.318), `StopFailure` hook `error: "authentication_failed"`, `claude agents --json` `state: "blocked"`. Login happens **only** through the CLI's own flow (`claude auth login`), run over SSH or in an unrecorded web-terminal PTY.
8. **Usage**: show only what Claude Code exposes — status-line JSON `rate_limits.five_hour|seven_day.used_percentage` + `resets_at` (Pro/Max/Ultra only, after the first API response), context-window %, model. The `$` cost is a client-side API-price estimate "not relevant for billing purposes" for subscribers [DOC].
9. **Host**: dedicated non-root user, native installer (or Anthropic's signed apt repo), keep current (target ≥ v2.1.317, ideally ≥ v2.1.318), `stable` channel once it serves that version. Do **not** set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`/`DISABLE_GROWTHBOOK` (they disable Remote Control), do not set `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`.
10. **Must be tested on the VPS** [VERIFY]: `--bg` + `--session-id`, `--bg` + `--remote-control`, status line in unattended background sessions, concurrent `claude attach` to one session, `MessageDisplay` hook overhead, exact `claude auth status --json` keys when logged in.

---

## 1. Legal & compliance — what Anthropic says

### 1.1 Credential use (the key text)

Source: [Legal and compliance → Authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use) [DOC]

> "**OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."

> "**Developers** building products or services that interact with Claude's capabilities, including those using the [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview.md), should use API key authentication through [Claude Console](https://platform.claude.com/) or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow."

> "This does not restrict how customers provision and manage their own API keys … Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under *Can customers offer Claude Code in their products?* above."

> "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."

Same page, *Acceptable use* [DOC]:

> "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK."

Same page, licence [DOC]: Claude Code use is subject to the "[Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms) - for Free, Pro, Max, and Ultra users".

### 1.2 Hosting Claude Code inside a product

Source: [Legal and compliance → Can customers offer Claude Code in their products?](https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products) [DOC]

> "Unless we've mutually agreed otherwise, preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our Commercial Terms of Service and complying with the conditions below:
> * **The Claude Code binary must not be modified.** Claude Code must be installed and run as published by Anthropic, and customers may not remove, disable, or restrict any authentication method built into it (including methods that permit signing in with a Claude account or the user's own API key).
> * **Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf.** Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential …"

> "You can accurately say, in plain text, that your product has Claude Code preinstalled or that it runs Claude Code. But you can't use the Claude Code or Anthropic names or logos as part of your own product, feature, or company name, in your own logo, or in a way that suggests Anthropic built, endorses, or is partnered with your product."

[INF] Nuera Dev is a *personal* tool used only by the subscriber. These conditions bind products offered to others, but they are also the clearest statement of what Anthropic considers acceptable hosting: **unmodified binary + each user's own credentials + no intermediation**. Nuera Dev should satisfy them anyway, so that it stays compliant if it is ever shared.

### 1.3 Consumer Terms clauses that matter

Source: [Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms) — "Effective Oct 8, 2025" (fetched 2026-11-04) [DOC]

* Prohibited use: "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise."
* Accounts: "You may not share your Account login information, Anthropic API key, or Account credentials with anyone else or make your Account available to anyone else. You are responsible for all activity occurring under your Account …"
* Prohibited use: "… or resell the Services."

[INF] Using Claude Code (an Anthropic product) with the subscription is explicitly permitted. A human using the TUI through a web terminal is human access. What would drift towards "automated or non-human means" is Nuera Dev *itself* generating prompts or driving sessions without the owner (cron loops, webhooks that start work, a bot that answers prompts). Keep every prompt and every permission decision human-initiated, or use Claude Code's own scheduling features (`/loop`, routines, channels) rather than Nuera-side automation.

### 1.4 Agent SDK note

Source: [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) [DOC]

> "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead."

> "Use of the Claude Agent SDK is governed by Anthropic's Commercial Terms of Service …"

And `claude -p` **is** the Agent SDK's CLI form: "This page covers using the Agent SDK via the CLI (`claude -p`)" ([headless](https://code.claude.com/docs/en/headless)); the CLI reference describes `claude -p "query"` as "Query via SDK, then exit" ([cli-reference](https://code.claude.com/docs/en/cli-reference)) [DOC].

### 1.5 Is running the official CLI on one's own server, under one's own subscription, allowed?

| Mode | Evidence | Verdict |
| :- | :- | :- |
| Interactive `claude` on a remote machine | [DOC] Remote Control limitations: "If you run `claude` from a terminal on a remote machine, start it inside `tmux` or `screen` to keep the session running after you disconnect from SSH." ([remote-control](https://code.claude.com/docs/en/remote-control#limitations)). [DOC] Legal: "including where a platform hosts Claude Code". [DOC] Self-hosted page: "your own always-on machine … use Remote Control … Pro, Max, and Ultra". | **Allowed** (explicitly contemplated). |
| Background sessions (`--bg`) | [DOC] documented feature that uses "your subscription usage the same as interactive sessions" ([agent-view](https://code.claude.com/docs/en/agent-view#limitations)). | **Allowed.** |
| `claude -p` / `--output-format json\|stream-json` with a saved claude.ai login | [DOC] The errors page tells users: "If your `-p` command or Agent SDK program uses a saved login, run `claude` in the same environment, complete `/login`, then run the command or program again." ([errors](https://code.claude.com/docs/en/errors#oauth-token-revoked-or-expired)). [DOC] v2.1.318 added "`claude -p` JSON results (`credential_expires_at`)" and a "stderr warning to `claude -p` text output, starting 10 days before a stored claude.ai sign-in ends" ([changelog](https://code.claude.com/docs/en/changelog)). | **Technically supported for the subscriber's own scripted use.** **Not** a basis for building a product/chat UI (see §1.1, §1.4). [INF] Treat as out of scope for Nuera Dev v1. |
| Wrapping the CLI in a PTY driven from a web terminal | Not addressed by any page I found. Closest: the tmux/screen guidance above, and xterm.js-based terminals being a known terminal class in the changelog (e.g. "Fixed hyperlinks opening two browser tabs when clicked inside tmux running in an xterm.js-based terminal (VS Code, Hyper, Tabby)"). | **[INF] Allowed** when: unmodified binary, the owner's own login done through the CLI's own flow, a human types the input, and Nuera never touches credentials. A web terminal is functionally an SSH client. |

### 1.6 `claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN` — intended use

Source: [Authentication → Generate a long-lived token](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token) [DOC]

> "For CI pipelines, scripts, or other environments where interactive browser login isn't available, generate a one-year OAuth token with `claude setup-token` … It does not save the token anywhere; copy it and set it as the `CLAUDE_CODE_OAUTH_TOKEN` environment variable wherever you want to authenticate"

> "This token authenticates with your Claude subscription and requires a Pro, Max, Ultra, Team, or Enterprise plan. It can only make model requests, so it can't establish Remote Control sessions or fetch claude.ai connectors. MCP servers you configure locally still work."

[Env vars](https://code.claude.com/docs/en/env-vars): `CLAUDE_CODE_OAUTH_TOKEN` — "OAuth access token for claude.ai authentication. Alternative to `/login` for SDK and automated environments. … Generate one with `claude setup-token`." [DOC]

[Remote Control troubleshooting](https://code.claude.com/docs/en/remote-control#remote-control-requires-a-full-scope-login-token): "You're authenticated with a long-lived token from `claude setup-token` or the `CLAUDE_CODE_OAUTH_TOKEN` environment variable. These tokens can only make model requests, so they can't establish Remote Control sessions." [DOC]

**Verdict for Nuera Dev:** **do not use.** It would mean Nuera storing a subscription credential (against the owner's hard constraint and the spirit of "may not collect, store, or intermediate"), and it breaks Remote Control and claude.ai connectors anyway.

---

## 2. Background sessions (agent view)

Main source: [Manage multiple agents with agent view](https://code.claude.com/docs/en/agent-view). Status: "Agent view is in research preview. The interface and keyboard shortcuts may change as the feature evolves." [DOC]

### 2.1 How they work

* [DOC] "Each background session is a full Claude Code conversation that keeps running without a terminal attached, so you can open it, reply, and leave whenever you want."
* [DOC] "Background sessions don't need any terminal open to keep working. A separate supervisor process runs them, so you can close agent view, close your shell, or start a new interactive session and your dispatched work keeps going."
* [DOC] "Each session is its own Claude Code process under the supervisor"; "The supervisor runs each background session's terminal in its own host process."
* [DOC] "The supervisor and its sessions authenticate with the same stored credentials as your interactive sessions."
* [DOC] "A background session also runs with the `PATH` of the shell you dispatched it from" and reads its settings "from the directory it runs in".
* [LOCAL] `claude daemon --help` (v2.1.280): "run [json-path]   Run the supervisor in the foreground (default when piped)" … "Service install is disabled in this version — the daemon runs on demand and exits when the last client disconnects." → don't wrap the supervisor in your own systemd unit; let Claude Code start it on demand.

### 2.2 Commands

From [agent-view → Manage sessions from the shell](https://code.claude.com/docs/en/agent-view#manage-sessions-from-the-shell) and [cli-reference](https://code.claude.com/docs/en/cli-reference) [DOC], cross-checked with local `--help` [LOCAL]:

| Command | Behaviour |
| :- | :- |
| `claude --bg "<prompt>"` (`--background`) | Starts a session straight in the background. "The prompt is the positional argument, not a `-p` value. Claude Code rejects `--bg` combined with `-p` or `--print`". Prints e.g. `backgrounded · 7c5dcf5d · flaky-test-fix` plus management hints; may first print `Starting background service…`. Checks workspace trust: "Where no dialog can appear, such as in a script, the command exits with a `Workspace not trusted` error instead." |
| `claude --resume <session-uuid> --bg "<prompt>"` | "On Claude Code v2.1.257 or later, Claude Code either continues that session under the same ID, or starts a copy under a new ID and prints a `note:` line explaining why". With `--continue`, bare `--resume`, or a name/path → always a copy; `--fork-session` → copy on purpose. |
| `claude --bg --name "<n>" …` | Display name in agent view. |
| `claude --bg --exec '<cmd>'` | Shell job in a PTY instead of a Claude session; output kept in memory, cleaned ~5 min after exit. |
| `claude agents` | Opens agent view (full-screen TUI; "Opening agent view requires an interactive terminal"). `--cwd <path>` scopes it. Accepts `--permission-mode`, `--model`, `--effort`, `--agent`, `--settings`, `--add-dir`, `--plugin-dir`, `--mcp-config`, `--strict-mcp-config`, `--restricted` as dispatch defaults. |
| `claude agents --json [--all] [--cwd <path>]` | [LOCAL] "Print active sessions (interactive and background) as a JSON array and exit (for scripting; does not require a TTY)". |
| `claude attach <id>` | "Attach to a session in this terminal". [LOCAL] "← returns to agent view, Ctrl+Z drops back to your shell. The session keeps running either way." Name instead of id requires v2.1.290+. |
| `claude logs <id>` | "Print the session's recent output" ([LOCAL] "recent terminal output"). |
| `claude stop <id>` / `claude kill <id>` | "Stop a session." [LOCAL] "Its conversation is kept; resume it later with `claude attach <id>`." |
| `claude rm <id>` | Removes the session from the list "along with a worktree Claude created for it when that's safe to delete … The conversation transcript stays on your local machine and remains available through `claude --resume`". Refusals print the exact `--discard-unpushed <commit>@<worktree-id>` / `--force-remove-worktree <worktree-id>` value to pass. |
| `claude respawn <id>` / `--all` | "Restart a session, running or stopped, for example to pick up an updated Claude Code binary. A session that has a saved conversation resumes it". Caution: when the transcript was swept, "`claude respawn <id>` runs its original prompt again". |
| `claude daemon status\|logs\|stop --any [--keep-workers]` | Supervisor diagnostics / restart. [LOCAL] `daemon status` prints `not running` or socket/roster information. |

Inside a session: `/background` (`/bg`) moves the current conversation to the background; `/fork` copies it into a new background session; `/stop` stops the attached session ([commands](https://code.claude.com/docs/en/commands)) [DOC].

### 2.3 `claude agents --json` schema and values

Source: [agent-view → List sessions as JSON](https://code.claude.com/docs/en/agent-view#list-sessions-as-json) [DOC]

| Field | Present | Description |
| :- | :- | :- |
| `cwd`, `kind`, `startedAt` | Always | working directory; `interactive` or `background`; start time in Unix ms |
| `id` | Background sessions | short ID for `attach`/`logs`/`stop` (also the directory name under `~/.claude/jobs/`) |
| `state` | Background sessions | `working`, `blocked`, `done`, `failed`, `stopped` |
| `pid`, `status` | While the process is alive | PID and `busy`, `waiting`, or `idle` |
| `waitingFor` | When `status` is `waiting` | `permission prompt`, `input needed`, `sandbox request`, `worker request`, `dialog open` |
| `sessionId`, `name` | When set | full session UUID (usable with `claude --resume`); display name |

State semantics [DOC]: "`blocked` | The session is waiting on you: a question it asked, a permission or sandbox decision, an error only you can clear such as an expired login, or its first prompt if you started it without one." — "A session that finished its turn and is waiting for your next instruction reads `done`, not `blocked`." — "`claude agents --json` is the supported way to read session state from outside Claude Code … Poll `claude agents --json --all` … and read each entry's `state`, `status`, and `waitingFor`." — "The files under `~/.claude/jobs/<id>/` are not a stable interface."

[LOCAL] On v2.1.280 an interactive (non-bg) session appears as `{pid, cwd, kind:"interactive", startedAt, sessionId, name, status:"busy"}`, and listing worked while `claude daemon status` said `not running` (so polling `--json` does not appear to start the supervisor).

### 2.4 Where state lives

Source: [agent-view → Where state is stored](https://code.claude.com/docs/en/agent-view#where-state-is-stored) [DOC]

| Path | Contents |
| :- | :- |
| `~/.claude/daemon.log` | Supervisor log |
| `~/.claude/daemon/roster.json` | Running background sessions, used to reconnect after a restart |
| `~/.claude/jobs/<id>/state.json` | Per-session state — "Read it through `claude agents --json` instead of parsing the file" |
| `~/.claude/jobs/<id>/tmp/` | Per-session scratch dir (`$CLAUDE_JOB_DIR/tmp`), removed when the session is deleted |

"If you set `CLAUDE_CONFIG_DIR`, the supervisor uses that directory instead of `~/.claude` and runs as a separate instance with its own sessions." [DOC] → every Nuera-spawned `claude` invocation must use the **same** `CLAUDE_CONFIG_DIR` (or none), or it will talk to a different supervisor/login.

### 2.5 Survival matrix

| Event | What happens | Source |
| :- | :- | :- |
| Browser / attach client / terminal closes | Session keeps running ("Detaching never stops a background session: `←`, `Ctrl+Z`, `/exit`, and double `Ctrl+C` or double `Ctrl+D` all leave it running.") | [DOC] agent-view |
| Nuera backend restarts | Sessions keep running (supervisor is a separate process). | [INF] from the supervisor model |
| Idle ≥ ~1 h, unattached | "the supervisor stops the process to free resources … the next time you attach or reply, the session resumes where it left off. Pin a session with `Ctrl+T` to keep its process running." | [DOC] |
| Process crashes | "the supervisor restarts the process" | [DOC] |
| Auto-update | "the supervisor restarts itself onto the new version and moves idle sessions over in the background. Sessions that are working, waiting on you, or attached aren't interrupted." | [DOC] |
| Supervisor killed | "on macOS and Linux, your sessions stop unless a new supervisor connects within about a minute. To start one, run `claude agents` in your shell." | [DOC] |
| Machine sleep | "Sessions are also preserved when your machine sleeps." | [DOC] |
| Shutdown / reboot | "Shutting down or restarting your machine stops running background sessions." < 48 h: shows `failed`, "Attach or reply to it and it restarts from its saved conversation." > 48 h: `stopped` with `ended while the background service was off`. | [DOC] |
| Transcript swept by retention (30 days default) | "Claude Code refuses to open the row: the message says there is nothing to resume." | [DOC] |

### 2.6 Platform notes & limits

* Linux is a first-class target (e.g. "On Linux and WSL, a session whose terminal host process died fails within seconds with the reason") [DOC]. Nothing requires a desktop/GUI on Linux; credentials are file-based there (§6) [INF].
* Containers: no background-session-specific container guidance; the [dev container page](https://code.claude.com/docs/en/devcontainer) covers non-root user, persisting `~/.claude` + `CLAUDE_CONFIG_DIR` [DOC]. A container restart equals a reboot for bg sessions [INF].
* Limits [DOC]: "**Rate limits apply**: background sessions consume your subscription usage the same as interactive sessions, so running ten agents in parallel uses quota roughly ten times as fast as running one." — "**Sessions are local** … stop if the machine shuts down." — "Claude-created worktrees are deleted with the session in agent view".
* **Worktree isolation & git behaviour** [DOC]: "Before editing files, Claude moves the session into an isolated git worktree under `.claude/worktrees/`". When it made changes there: "**Commit and push**: Claude commits without asking, and pushes the branch when the repository has a remote." / "**Draft pull request**: Claude opens one when the task calls for it" / "**Never**: pushing to `main` or `master`, force-pushing, and merging." / "**Your git instructions take precedence**". Disable with `"worktree": {"bgIsolation": "none"}`. → Nuera's diff/commit/PR screens must look at the **session's worktree**, not the main checkout.
* Attached sessions [DOC]: "Attached sessions always render in fullscreen mode, regardless of your `tui` setting … Scroll with `PgUp`, `PgDn`, or the mouse wheel, and press `Ctrl+O` for transcript mode."
* Turn off entirely: `disableAgentView` / `CLAUDE_CODE_DISABLE_AGENT_VIEW=1` [DOC].

---

## 3. Remote Control

Main source: [Remote Control](https://code.claude.com/docs/en/remote-control).

### 3.1 What it is and who can use it

* [DOC] "Remote Control connects claude.ai/code or the Claude app for iOS and Android to a Claude Code session running on your machine." "Claude keeps running locally the entire time".
* [DOC] Requirements: "**Subscription**: available on Pro, Max, Ultra, Team, and Enterprise plans. API keys are not supported." — "**Authentication**: run `claude` and use `/login` to sign in through claude.ai if you haven't already." — Not available with Bedrock/Vertex/Foundry, with "`ANTHROPIC_BASE_URL` at a host other than `api.anthropic.com`", or behind the Claude apps gateway. — "If you set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` or `DISABLE_GROWTHBOOK`, Remote Control is unavailable."
* [DOC] setup-token / `CLAUDE_CODE_OAUTH_TOKEN` cannot establish Remote Control (full-scope login required, §1.6).
* [LOCAL] v2.1.280 logged out: `claude remote-control --help` → "Error: You must be logged in to use Remote Control. Remote Control is only available with claude.ai subscriptions." `claude doctor` lists eligibility checks: "Not signed in to claude.ai", "claude.ai subscription auth not active", "Sign-in is missing the user:profile scope".

### 3.2 Starting it

[DOC] Three CLI modes:

* **Server mode** `claude remote-control [--name "…"] [--spawn same-dir|worktree|session] [--capacity N] [--permission-mode …]`: "The process stays running in your terminal in server mode, waiting for remote connections. It displays a URL you can use to connect from another device, and you can press spacebar to show a QR code". Asks once `Enable Remote Control? (y/n)`, and `Trust <directory>? [y/N]` in untrusted dirs ("When its standard input or output isn't a terminal, the command can't ask and exits with a `Workspace not trusted` error"). Global flags such as `--settings` before `remote-control` make it refuse to start.
* **Interactive** `claude --remote-control ["name"]` (`--rc`).
* **From a session** `/remote-control` (`/rc`): "carries over your current conversation history"; running it again opens a status panel with the URL and QR code.
* Auto-connect: `remoteControlAtStartup: true` in `~/.claude/settings.json` — "each interactive Claude Code process registers one remote session".

### 3.3 Connecting from claude.ai/code or the app

[DOC] "Open the URL Claude Code displays in any browser to go to claude.ai/code." / "Scan the QR code … to open it in the Claude app." / "find the session by name in the session list … Remote Control sessions show a computer icon with a green status dot when online."

[DOC] `CLAUDE_CODE_BRIDGE_SESSION_ID` is "Set automatically in Bash tool and hook command subprocesses while the session has an active Remote Control connection … The value is the session's ID in `session_` form, the same identifier that appears in the session's `claude.ai/code` URL" ([env-vars](https://code.claude.com/docs/en/env-vars)); and "The ID is the part of the session's URL at claude.ai/code between `/code/` and any `?`." → a Nuera command hook can read it and build `https://claude.ai/code/<id>` (+ its own QR) [INF].

### 3.4 Limitations relevant to Nuera

[DOC] "**One remote session per interactive process**" (server mode for many) — "**Local process must keep running**" — server mode "gives up after roughly 10 minutes" of network outage — server sessions can be brought back "for about four hours after the server stopped" — "While Remote Control is connected, the session transcript … is stored on Anthropic servers" — "Your local Claude Code session makes outbound HTTPS requests only and never opens inbound ports on your machine." — some commands are local-only (e.g. `/plugin`, `/resume`); `/usage`, `/compact`, `/model`, `/mcp` work from mobile/web. Permission prompts and `AskUserQuestion` stay open until answered; other forwarded dialogs expire after 5 min (`dialogExpiry`).

### 3.5 Combining with `--bg`

Not documented on the Remote Control page. Evidence that it exists: changelog v2.1.169 "Background sessions now preserve `--ide`, `--chrome`, `--bare`, `--remote-control`, and other flags across retire→wake"; v2.1.273 "Added forking a session started with `claude --remote-control` or `/remote-control` from the Claude app; the fork runs as a background session on your computer" ([changelog](https://code.claude.com/docs/en/changelog)) [DOC]. → **[VERIFY]** `claude --bg --remote-control "<name>" …` on the VPS. [INF] Caveat: an idle, unattached bg session's process is stopped after ~1 h, which takes its Remote Control session offline until the process is woken; server mode (`claude remote-control`) is better for "always reachable from the phone".

---

## 4. Hooks

Main source: [Hooks reference](https://code.claude.com/docs/en/hooks) (+ [guide](https://code.claude.com/docs/en/hooks-guide)).

### 4.1 Events (complete list in the current docs)

[DOC] `SessionStart`, `Setup`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `MessageDisplay`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `Elicitation`, `ElicitationResult`, `SessionEnd`.

Useful matcher values [DOC]: `SessionStart` → `startup|resume|clear|compact|fork`; `SessionEnd` reason → `clear|resume|logout|prompt_input_exit|other`; `StopFailure` error → `rate_limit|overloaded|authentication_failed|oauth_org_not_allowed|account_on_hold|billing_error|invalid_request|model_not_found|server_error|max_output_tokens|cloud_credential_error|unknown`; `PreCompact|PostCompact` → `manual|auto`.

### 4.2 Common input fields

[DOC] `session_id`, `prompt_id`, `transcript_path` ("The transcript file is written asynchronously and may lag the in-memory conversation … Hooks that need the final assistant text of the current turn should use `last_assistant_message` on Stop and SubagentStop"), `cwd`, `scratchpad_dir` (v2.1.257+), `permission_mode` (`"default"`, `"plan"`, `"acceptEdits"`, `"auto"`, `"dontAsk"`, `"bypassPermissions"`; "The mode labeled **Manual** arrives as `"default"`"), `effort`, `hook_event_name`; plus `agent_id`/`agent_type` inside subagents. Event-specific examples: `UserPromptSubmit.prompt`; `PreToolUse.tool_name|tool_input|tool_use_id`; `PostToolUse.tool_response|duration_ms`; `Stop.last_assistant_message|background_tasks|session_crons`; `StopFailure.error|error_details`; `PostCompact.compact_summary`; `SessionStart.source|model|session_title`; `MessageDisplay.turn_id|message_id|index|final|delta`.

Env for command hooks [DOC]: `CLAUDE_CODE_SESSION_ID` ("matches the `session_id` field in the hook JSON input"), `CLAUDE_PROJECT_DIR`, `CLAUDE_JOB_DIR` (bg sessions), `CLAUDE_CODE_BRIDGE_SESSION_ID` (Remote Control). "On macOS and Linux, command hooks run in their own session without a controlling terminal."

### 4.3 `PermissionRequest` decision format

[DOC] "Runs when Claude Code is about to ask you for permission to use a tool." Input: `tool_name`, `tool_input`, optional `permission_suggestions` (no `tool_use_id`). Output:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow",
      "updatedInput": { "command": "npm run lint" }
    }
  }
}
```

`behavior`: `"allow"` | `"deny"`; `updatedInput` and `updatedPermissions` (entries `addRules|replaceRules|removeRules|setMode|addDirectories|removeDirectories` with `destination` `session|localSettings|projectSettings|userSettings`) for allow; `message` and `interrupt` for deny. "A hook that exits 2 without a `decision` object leaves the permission flow unchanged". Deny/ask rules still apply. "Claude Code runs a Notification hook with the `permission_prompt` type only after the prompt has waited about six seconds." [DOC]

### 4.4 `Notification` types

[DOC] `permission_prompt` (after ~6 s), `idle_prompt` (~60 s after the last response), `auth_success`, `elicitation_dialog`, `elicitation_url_dialog`, `elicitation_complete`, `elicitation_response`, `agent_needs_input` and `agent_completed` ("Fires only while agent view is open in a terminal"), `quota_auto_resume_fired`, `quota_auto_resume_stale`, `quota_auto_resume_disabled`, `plugin_notification`. Input adds `message`, optional `title`, `notification_type`. Notification hooks can't block.

### 4.5 Hook types and timeouts

[DOC] Types: `command`, `http` (POST of the same JSON; response body = same JSON output), `mcp_tool`, `prompt`, `agent` ("experimental"). Default timeouts: "600 for `command`, `http`, and `mcp_tool`; 30 for `prompt`; 60 for `agent`", lowered to 30 on `UserPromptSubmit`, `PreModelSwitch`, `PostModelSwitch`, to 10 on `MessageDisplay`; "`SessionEnd` hooks share a 1.5-second budget". `async: true` (command hooks only) runs in the background; async output is delivered to Claude on the next turn. Exit 0 = success; exit 2 = block (on blocking events); other = non-blocking error. **Plain stdout becomes Claude context on `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`, `PostModelSwitch`** → an observer hook must print nothing.

Trust gating [DOC]: "**Interactive session**: Claude Code holds back hooks from every settings file, including your own `~/.claude/settings.json`, until you accept the workspace trust dialog".

### 4.6 Injecting hooks per session via `--settings`

[DOC] `--settings`: "Path to a settings JSON file or an inline JSON string. Values you set here override the same keys in your `settings.json` files for this session … The file must be a regular file no larger than 2 MiB." Precedence: managed > command line (`--settings`) > local > project > user ([settings](https://code.claude.com/docs/en/settings#settings-precedence)). "Hook entries merge across settings levels rather than replacing each other". For background sessions: "Configuration flags from the original launch carry through to the backgrounded session" (incl. `--settings`, `--mcp-config`, `--strict-mcp-config`, `--setting-sources`, `--add-dir`, `--plugin-dir`) and they "persist when the supervisor later stops and restarts its process". But for `claude --resume` (foreground): "If the session depended on `--mcp-config`, `--settings`, `--plugin-dir` … pass them again when you resume" ([sessions](https://code.claude.com/docs/en/sessions#what-a-resumed-session-restores)). Remote Control **server mode refuses** `--settings` (§3.2).

Example (file form preferred so it survives restarts):

```bash
claude --bg --settings /home/claude/.config/nuera/session-settings.json --name "nuera·app·3" "Fix the flaky test"
```

---

## 5. Transcripts, retention, `CLAUDE_CONFIG_DIR`

Source: [Manage sessions → Where transcripts are stored](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored) [DOC]

> "By default, Claude Code stores transcripts as JSONL at `~/.claude/projects/<project>/<session-id>.jsonl`, where `<project>` is your working directory path with non-alphanumeric characters replaced by `-`. For a working directory whose converted name exceeds 200 characters, Claude Code truncates the name to 200 characters and appends a hash of the full path"

> "Each line is a JSON object: a message, a tool use or result, a record of a request Claude Code sent the model, or a metadata entry. The entry format is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release. To build on session data, use `/export` or the script interfaces instead."

Script interfaces listed there [DOC]: `claude -p … --output-format json|stream-json`, `claude -p --resume`, hook/status-line `transcript_path`, the Agent SDK. Subagent transcripts: `projects/<project>/<session>/subagents/` ([claude-directory](https://code.claude.com/docs/en/claude-directory)).

Agent SDK helpers [DOC] ([sessions](https://code.claude.com/docs/en/agent-sdk/sessions#resume-across-hosts), [TS reference](https://code.claude.com/docs/en/agent-sdk/typescript#getsessionmessages)): "Both SDKs expose functions for enumerating sessions on disk and reading their messages: `listSessions()` and `getSessionMessages()` … Use them to build custom session pickers, cleanup logic, or transcript viewers." `getSessionMessages` returns `{type: "user"|"assistant"|"system", uuid, session_id, message (raw payload), parent_tool_use_id, parent_agent_id}`. For the store-backed variant the docs say it "returns the linked message chain the agent would see on resume", i.e. the post-compaction chain ([session-storage](https://code.claude.com/docs/en/agent-sdk/session-storage)); [INF] expect the same for local files (history before the last compaction is not returned).

Retention & privacy [DOC] ([claude-directory](https://code.claude.com/docs/en/claude-directory)): files are deleted "once they're older than `cleanupPeriodDays` … The default is 30 days". "Transcripts and history are not encrypted at rest. OS file permissions are the only protection. If a tool reads a `.env` file or a command prints a credential, that value is written to `projects/<project>/<session>.jsonl`."

`CLAUDE_CONFIG_DIR` [DOC]: "Override the configuration directory (default: `~/.claude`). All settings, session history, and plugins are stored under this path." Credentials move with it. `CLAUDE_CODE_PROJECT_DIR_NAME` (v2.1.234+, only with `CLAUDE_CONFIG_DIR`) names the `projects/` sub-directory yourself.

**Is reading transcripts for display acceptable?** [INF] Yes from a terms standpoint: it is the owner's local data, it involves no credential and no model request. The caveats are technical (unstable format → prefer the SDK read helpers and `transcript_path` from hooks; tolerate unknown entries) and privacy (they may contain secrets → never expose them outside the authenticated owner UI).

---

## 6. Authentication on a headless Linux server

Sources: [Authentication](https://code.claude.com/docs/en/authentication), [Troubleshoot install & login](https://code.claude.com/docs/en/troubleshoot-install#oauth-login-fails-in-wsl2-ssh-or-containers), [CLI reference](https://code.claude.com/docs/en/cli-reference) [DOC].

### 6.1 Login flow

* `claude auth login` — "Sign in to your Anthropic account. Use `--email` …, `--sso` …, and `--console` to sign in with Anthropic Console for API usage billing instead of a Claude subscription". [LOCAL] flags: `--claudeai` ("Use Claude subscription (default)"), `--console`, `--email <email>`, `--sso`.
* It is an OAuth browser flow **with a code-paste fallback**, not a device-code flow: "If the browser doesn't open automatically, press `c` to copy the login URL" / "If your browser shows a login code instead of redirecting back after you sign in, paste it into the terminal at the `Paste code here if prompted` prompt." / "When login completes, the terminal shows `Login successful`".
* Headless/SSH recipe: "At the interactive login prompt, press `c` to copy the URL, or select it in the terminal. With `claude auth login`, copy the URL that it prints." → "Open the URL in a browser on your local machine and sign in. The browser then shows a code instead of returning to `localhost`." → "Paste that code into the terminal at the prompt that begins `Paste code here`." `claude auth login` "reads the pasted code from standard input".
* "token validation depends on correct timestamps" → run NTP on the VPS.

### 6.2 `claude auth status`

[DOC] "Show authentication status as JSON. Use `--text` for human-readable output. Exits with code 0 if logged in, 1 if not. The JSON includes a `configDirectory` field … The JSON's `authMethod` field is one of `none`, `claude.ai`, `oauth_token`, `api_key`, `api_key_helper`, or `third_party`". v2.1.318 adds `loginExpiresAt` ("the date a stored claude.ai sign-in ends").

[LOCAL] v2.1.280, logged out: JSON keys `loggedIn` (false), `authMethod` ("none"), `apiProvider` ("firstParty"), `analyticsDisabled`, `projectsDirectory` (`…/.claude/projects`), `configDirectory`; exit code **1**. `--text` printed `Login: Expired — log in again`, `Organization: …`, `Email: …`, `Not logged in. Run claude auth login to authenticate.` → Keys such as email/organization/plan type in JSON are **not documented**: treat any extra key as optional [VERIFY].

Polling caution [DOC]: changelog v2.1.301 "Fixed sign-in refresh timeouts and unexpected sign-outs after a short command such as `claude auth status` or `claude plugin list` exited in the middle of a token refresh"; v2.1.317 "Fixed `claude auth status` exiting before a slow token refresh was saved, which could sign you out on the next run" → require ≥ 2.1.317 and poll sparingly.

### 6.3 Storage and sharing

* [DOC] "On Linux, credentials are stored in `~/.claude/.credentials.json` with file mode `0600`." "If you've set the `CLAUDE_CONFIG_DIR` environment variable, Claude Code keeps the `.credentials.json` file under that directory". "Claude Code manages `.credentials.json` through `/login` and `/logout`."
* [DOC] "Parallel sessions on one machine share a saved login and coordinate its renewal so that only one process refreshes the token at a time." And: "If you sign in with your claude.ai account in another Claude Code window that uses the same configuration directory, an interactive session showing this message starts using that login on its own."
* [DOC] Background sessions: "Background sessions get their credentials from the supervisor … Confirm you have run `/login` …, then stop the supervisor: `claude daemon stop --any --keep-workers`" and restart it within about a minute (fix for `Could not resolve authentication method`).
* [DOC] Precedence: cloud provider env → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → Anthropic profiles → "Subscription OAuth credentials from `/login`. This is the default for Claude Pro, Max, Ultra, Team, and Enterprise users." And: "In non-interactive mode (`-p`), the key is always used when present." → scrub `ANTHROPIC_*` from Nuera's environment.
* [DOC] Expiry: warning at 3 days (`Your login expires in 3 days · run /login to renew`); then `Login expired · Please run /login`. "A background session in agent view or a Remote Control session that outlives the login stops making progress once the credential expires and can't recover until you sign in again."

---

## 7. MCP

Source: [MCP](https://code.claude.com/docs/en/mcp) [DOC].

* **JSON format** (`.mcp.json`, `--mcp-config`, `claude mcp add-json`): `{"mcpServers": {"<name>": {"type": "http", "url": "…", "headers": {…}}, "<name2>": {"type": "stdio", "command": "…", "args": […], "env": {…}}}}`. "A JSON entry that has a `url` but no `type` is a configuration error". `type` also accepts `sse`, `ws`, and `streamable-http` (alias of `http`). `.mcp.json` supports `${VAR}` and `${VAR:-default}` expansion in `command`, `args`, `env`, `url`, `headers`.
* **Scopes**: local (default, `~/.claude.json` per project), project (`.mcp.json`, needs approval in interactive sessions), user (`~/.claude.json`, all projects). Precedence local > project > user > plugin > claude.ai connectors.
* **`--mcp-config <configs...>`** "Load MCP servers from JSON files or strings"; **`--strict-mcp-config`** "Only use MCP servers from `--mcp-config`, ignoring all other MCP configurations". Both carry over to background sessions; must be re-passed on `--resume`.
* **`claude mcp list` / `get`** — [LOCAL] help: "Unapproved .mcp.json servers are shown as ⏸ Pending approval and not connected to; approved servers are health-checked unless disabled for this project." [DOC] statuses: `✔ Connected`, `! Needs authentication`, `✘ Failed to connect` (+ detail), `⏸ Pending approval (run claude to approve)`, `✘ Rejected …`, `⊘ Disabled for this project …`, `✘ Blocked by enterprise managed policy`. Output is human text; no JSON flag in v2.1.280 [LOCAL]. Each call connects to every approved server → cache results.
* **`claude mcp login <name>`** [DOC]: "Run a configured MCP server's OAuth flow without opening the interactive `/mcp` panel. Works for HTTP, SSE, and claude.ai connector servers." "`claude mcp login` detects when no local browser is available, such as during an SSH session or on Linux without a display server, and prints the authorization URL … Open the URL on your local machine, then paste the full redirect URL from your browser's address bar back at the prompt. The command needs an interactive terminal for the paste step, so connect with `ssh -t`." `--no-browser` forces it. `claude mcp logout <name>` clears credentials. "A `claude -p` or Agent SDK run has no `/mcp` panel, so Claude Code can't run the OAuth flow there."
* **Figma remote MCP** ([Figma developer docs](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation)) [DOC]: `claude mcp add --transport http figma https://mcp.figma.com/mcp` (add `--scope user` for all projects), then authenticate (`/mcp` → **Authenticate**, or `claude mcp login figma --no-browser` on a headless host). Figma says only clients "listed in the Figma MCP catalog" can connect; Claude Code is one — Nuera itself must not reuse that registration [INF]. Plugin alternative: `claude plugin install figma@claude-plugins-official`.
* **Coolify**: not researched here (third-party). [INF] Configure like any stdio/HTTP server; keep tokens in env/`${VAR}`, never in a committed `.mcp.json`.

---

## 8. Permission modes, rules, sandboxing

Source: [Permission modes](https://code.claude.com/docs/en/permission-modes) [DOC]

| Mode | What runs without asking | Best for |
| :- | :- | :- |
| `default` (labelled **Manual**; CLI alias `manual`) | Reads only | Reviewing every action yourself |
| `acceptEdits` | Reads, file edits, and common filesystem commands (`mkdir`, `touch`, `mv`, `cp`, etc.) | Iterating on code you're reviewing |
| `plan` | Reads, plus classifier-approved commands when auto mode is available | Exploring before changing |
| `auto` | Everything, with background safety checks (a classifier model) | Long tasks, fewer prompts |
| `dontAsk` | Reads in working dirs and pre-approved tools; anything that would prompt is denied | Locked-down CI and scripts |
| `bypassPermissions` | Everything | "Isolated containers and VMs only" |

Key facts [DOC]: "Deny rules block in every mode, including `bypassPermissions`." Auto mode: "Auto mode reduces permission prompts but does not guarantee safety". Since v2.1.283 auto is the built-in starting mode for interactive terminal sessions (earlier: only on Pro/Max/Ultra/Team when feature flags are fetched); `-p` runs start in Manual from v2.1.302. `auto`/`bypassPermissions` as `defaultMode` take effect only from user, `--settings` or managed settings, not from project files. "On Linux and macOS, Claude Code refuses to start in `bypassPermissions` mode when running as root or under `sudo`". A background session started in `bypassPermissions` needs the acceptance recorded in `~/.claude/settings.json` (`skipDangerousModePermissionPrompt`).

Rules [DOC] ([permissions](https://code.claude.com/docs/en/permissions)): `permissions.allow|ask|deny` with rule syntax like `Bash(git diff *)`, `Edit(src/**)`, `mcp__server__tool`; `permissions.defaultMode`; `permissions.additionalDirectories`; CLI `--allowedTools`, `--disallowedTools`, `--tools`. Project `allow` rules apply only after workspace trust.

Sandboxing [DOC] ([sandboxing](https://code.claude.com/docs/en/sandboxing)): OS-level isolation of Bash; on Linux "the sandbox relies on `bubblewrap` and `socat`" (Ubuntu may need an AppArmor profile for `bwrap`); enable with `/sandbox` or `sandbox.enabled: true`; "To put the tools, processes, and commands … behind one boundary, run the Claude Code process itself in a container, virtual machine, or the sandbox runtime."

---

## 9. Installation on Linux, updates, containers

Source: [Advanced setup](https://code.claude.com/docs/en/setup) [DOC].

* Requirements: Ubuntu 20.04+, Debian 10+, Alpine 3.19+; "4 GB+ RAM, x64 or ARM64".
* **Native installer (recommended)**: `curl -fsSL https://claude.ai/install.sh | bash` — "Native installations automatically update in the background". Launcher `~/.local/bin/claude` → `~/.local/share/claude/versions/`.
* **Signed apt/dnf/apk repos** (`https://downloads.claude.ai/claude-code/apt/stable stable main`, key fingerprint `31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE`): "Package manager installations do not auto-update through Claude Code".
* **npm**: `npm install -g @anthropic-ai/claude-code` (Node ≥ 22; same native binary). "Do NOT use `sudo npm install -g`".
* **Updates**: `autoUpdatesChannel: "stable"` (~1 week old, skips major regressions); `minimumVersion` floor; disable background updates with `"env": {"DISABLE_AUTOUPDATER": "1"}` in settings ("Manual `claude update` still works"); `DISABLE_UPDATES=1` blocks all. After updating, `claude respawn --all` moves background sessions onto the new binary.
* **Non-root**: run as a normal user (bypass mode refuses root; npm must not be sudo). [INF] Dedicated Unix user `claude` (or the Nuera user) with its own `$HOME`.
* **Env vars to know**: `CLAUDE_CONFIG_DIR`, `DISABLE_AUTOUPDATER`, `DISABLE_UPDATES`, `CLAUDE_CODE_DISABLE_AGENT_VIEW`, `CLAUDE_JOB_DIR` (set by Claude Code), `CLAUDE_CODE_SESSION_ID` (set in subprocesses), `CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDE_CODE_SKIP_PROMPT_HISTORY`, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`. **Avoid**: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_GROWTHBOOK` ([env-vars](https://code.claude.com/docs/en/env-vars)).
* **Docker / dev containers** ([devcontainer](https://code.claude.com/docs/en/devcontainer)) [DOC]: mount a volume at `~/.claude` **and** set `CLAUDE_CONFIG_DIR` to it so `.claude.json` persists; pin a version via `npm install -g @anthropic-ai/claude-code@X.Y.Z` + `DISABLE_AUTOUPDATER=1`; "`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` also disables the feature-flag evaluation that Remote Control … depend[s] on"; warning: with `--dangerously-skip-permissions`, a container doesn't prevent exfiltration of "the Claude Code credentials stored in `~/.claude`". `claude doctor` reports install method, version, auto-update status and Remote Control eligibility [LOCAL].

---

## 10. Usage information that can legitimately be shown

* **Status line JSON** ([statusline](https://code.claude.com/docs/en/statusline#available-data)) [DOC]: `rate_limits.five_hour.used_percentage`, `rate_limits.seven_day.used_percentage` ("from 0 to 100"), `rate_limits.*.resets_at` ("Unix epoch seconds"). "`rate_limits`: appears only for claude.ai Pro, Max, and Ultra subscribers … Even then, it appears only after the first API response in the session. Each window … may be independently absent". Also `model.id/display_name`, `context_window.used_percentage`, `context_window.context_window_size`, `cost.total_duration_ms`, `cost.total_lines_added/removed`, `session_id`, `session_name`, `transcript_path`, `version`, `worktree.*`, `pr.*`, `effort.level`. `cost.total_cost_usd` = "Estimated session cost in USD, computed client-side at list price … May differ from your actual bill." Status line requires workspace trust, is debounced (300 ms), optional `refreshInterval`.
* **`/usage`** ([costs](https://code.claude.com/docs/en/costs#using-the-usage-command)) [DOC]: "Claude Pro, Max, and Ultra subscribers have usage included in their subscription, so the session cost figure isn't relevant for billing purposes. Subscribers see plan usage bars, activity stats, and a usage breakdown on the same screen." The breakdown "figures are approximate and computed from local session history on this machine, so usage from other devices or claude.ai is not included." `/cost`, `/stats` are aliases.
* **`/status`** [DOC]: "showing version, model, account, and connectivity", `Login` row (`Expired — log in again`), `Session kind` row. Support article: "Pro and Max plans have a five-hour session limit and a weekly limit." "Monitor your remaining allocation using the /status command." ([support](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)).
* **Limit messages** [DOC] ([errors](https://code.claude.com/docs/en/errors#youve-hit-your-session-limit)): `You've hit your session limit · resets 3:45pm`, `You've hit your weekly limit · …`, warnings like `You've used 85% of your session limit · resets 3:45pm`.

[INF] Show: 5 h % + reset, 7-day % + reset, context %, model, effort, durations, lines changed, PR. Optionally the `$` figure, labelled "estimation au tarif API — non facturé avec l'abonnement". Never invent: remaining messages, token budgets, € billed, projections.

---

## 11. Other official mechanisms considered

| Mechanism | Fit for Nuera | Notes |
| :- | :- | :- |
| **Channels** ([channels](https://code.claude.com/docs/en/channels), [reference](https://code.claude.com/docs/en/channels-reference)) | Future option | [DOC] "A channel is an MCP server that pushes events into your running Claude Code session"; two-way with a reply tool; can "relay permission prompts" (`notifications/claude/channel/permission_request` → verdict `allow`/`deny`). "Pro, Max, and Ultra users without an organization skip these checks entirely". **But**: research preview; custom channels need `--dangerously-load-development-channels` (interactive confirmation, "for local development"); "Fakechat is an officially supported demo channel that runs a chat UI on localhost". Not a production base today. |
| **Agent SDK `query()` / `claude -p` stream-json** | Rejected for the chat | §1.4. Would also bypass the TUI's own permission dialogs (needs `--permission-prompt-tool`/`canUseTool`). |
| **Agent SDK read helpers** (`listSessions`, `getSessionMessages`, `getSessionInfo`) | Yes, read-only history | Local file reads, no model call [INF]; package bundles a native binary as an optional dependency [DOC]. |
| **Cloud sessions / self-hosted environments** | No | Self-hosted runners: "public beta on Team and Enterprise plans" [DOC]. |
| **`claude doctor`** | Yes (diagnostics) | "read-only installation and settings diagnostics … including … Remote Control eligibility" [DOC]. |
| **`claude agents` (TUI) in the web terminal** | Yes (fallback "Vue agents") | Official multi-session UI rendered as-is. |

---

## 12. Version gates (docs v2.1.318 vs local v2.1.280)

| Feature | Min. version [DOC] |
| :- | :- |
| `claude agents --json` (`id`, `state`, `--all`) | 2.1.145 / 2.1.169 |
| `--resume <id> --bg` continues under the same ID | 2.1.257 |
| `scratchpad_dir` hook field; `/btw` detach | 2.1.257 |
| `--permission-prompts none` | 2.1.259 |
| `configDirectory` in `auth status` | 2.1.268 |
| auto mode as built-in default on every plan; Remote Control with `DISABLE_TELEMETRY` | 2.1.283 |
| `claude --resume` on a running bg session opens it | 2.1.285 |
| `attach`/`logs` by name | 2.1.290 |
| hook `onFailure` | 2.1.295 |
| sign-out-after-short-command fixes | 2.1.301, 2.1.317 |
| `-p` defaults to Manual | 2.1.302 |
| `loginExpiresAt` (auth status), `credential_expires_at` (`-p`) | 2.1.318 |

→ **Target on the VPS: ≥ 2.1.317** (auth-status sign-out fix), ideally ≥ 2.1.318 (`loginExpiresAt`). The `stable` channel lags ~1 week, so it may not serve 2.1.318 yet: either use `latest` until it does, or accept the missing `loginExpiresAt` (fall back to `/status`). Set `minimumVersion` to the version actually installed — a floor above what the channel serves makes updates refuse to install ("Background auto-updates and `claude update` refuse to install any version below this value", [setup](https://code.claude.com/docs/en/setup#pin-a-minimum-version)). Re-run the [VERIFY] checklist (§15) after each upgrade.

---

## 13. RECOMMENDED INTEGRATION DESIGN

### 13.1 Decision record — "native chat UI" question

| Option | Status | Why |
| :- | :- | :- |
| A. Native chat UI driven by `claude -p` / stream-json / Agent SDK on the **Max** login | **Rejected** | §1.1/§1.4: developers building products must use API keys; Agent SDK note forbids offering claude.ai login/rate limits in third-party products. Owner's constraint: don't simulate. |
| B. Same, on an API key | Allowed but out of scope | Owner refuses pay-per-use. |
| C. **Web terminal on the official TUI** (bg sessions + `claude attach` in a PTY) | **Chosen (primary)** | Unmodified binary, human input, documented session management. |
| D. **Remote Control** (claude.ai/code + Claude app) | **Chosen (mobile / away)** | Officially recommended for an always-on machine; Max-supported. |
| E. Custom channel bridge | Later | Research preview, dev flag. |

Around C, Nuera adds **read-only** structure (state, journal, diff, usage) from documented signals. It never fabricates assistant output and never parses screen text for structure.

### 13.2 Topology

```
 Browser (Nuera UI: xterm.js + panels)
      │ HTTPS + WSS (Nuera auth, CSRF, origin check)
      ▼
 Nuera backend (Node) ── execFile/node-pty (no shell) ──►  official `claude` binary (unmodified)
      ▲   │                                                  ├─ claude --bg … / --resume … --bg
      │   ├─ poll: claude agents --json --all  (3 s)         ├─ claude attach <id>   (one PTY / session)
      │   ├─ on demand: claude logs|stop|rm|respawn          ├─ claude auth status --json (≤ every 10 min)
      │   └─ on demand: claude mcp list|get, doctor          └─ Claude Code supervisor (on-demand) → workers → api.anthropic.com
      │                                                                     │
      └──── POST 127.0.0.1:<port>/internal/claude/events  ◄── command hooks + statusLine script (async, print nothing)

 Phone / other PC ── claude.ai/code or Claude app ──(Remote Control, Anthropic relay)──► same machine
```

### 13.3 Host layout

* One dedicated Unix user (e.g. `claude`) owns `~/.claude`, the projects (`~/projects/<slug>`), and runs every `claude` process. Simplest: the Nuera backend runs as the same user and enforces in code a **deny-list** (never open `~/.claude/.credentials.json`, never read `~/.claude.json` account fields, never log PTY input of login screens). Hardened variant [INF]: backend as user `nuera`, Claude processes as `claude` through a minimal privileged launcher that only spawns `/home/claude/.local/bin/claude` with whitelisted subcommands; the backend then cannot read the credentials file at all (transcripts read via the launcher).
* Install as that user: native installer (auto-updates, supervisor handles restarts) **or** apt `stable` (deterministic; run `claude respawn --all` after `apt upgrade`). Install `git`, `gh`, `bubblewrap`, `socat`; NTP on.
* Environment given to every spawned `claude` [INF]: `HOME`, `USER`, `PATH` (must include `~/.local/bin`, `node`, `git`, `gh` — bg sessions inherit the dispatcher's `PATH` [DOC]), `LANG=C.UTF-8`; for PTYs `TERM=xterm-256color`, `COLORTERM=truecolor`. Explicitly **unset** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_GROWTHBOOK`. Keep `CLAUDE_CONFIG_DIR` unset (or identical everywhere).
* User settings `~/.claude/settings.json` (written once by Nuera's installer, human-reviewed):

```json
{
  "autoUpdatesChannel": "stable",
  "minimumVersion": "<version actually installed, e.g. the first stable ≥ 2.1.317>",
  "cleanupPeriodDays": 90,
  "permissions": { "defaultMode": "default" },
  "sandbox": { "enabled": true },
  "statusLine": { "type": "command", "command": "/home/claude/.local/share/nuera/bin/nuera-statusline" },
  "hooks": { "...": "see 13.6 (Nuera event bridge)" }
}
```

[INF] Putting the bridge in **user** settings (rather than `--settings`) makes it apply to background sessions, sessions the owner starts over SSH, resumed sessions, and Remote Control server-mode sessions (which refuse `--settings`). Use a per-session `--settings` file only for per-session extras.

### 13.4 Project onboarding ("Ajouter un projet")

1. Nuera clones the repo (its own git credentials — e.g. a deploy key — unrelated to Claude).
2. **Workspace trust** (required before any `claude --bg` there [DOC]): open an ephemeral PTY running `claude` in the project; the official trust dialog lists what the repo would grant (allow rules, `.mcp.json` servers, hooks); the owner accepts, then types `/exit`. Error to map if skipped: `Workspace not trusted. Run \`claude\` in /path/to/project once and accept the trust prompt, then retry.` [DOC]. (Documented manual alternative: `projects["<path>"].hasTrustDialogAccepted = true` in `~/.claude.json` — not recommended for third-party repos, and don't write that file while Claude runs [INF].)
3. Project-scoped `.mcp.json` servers need a one-time approval in an interactive session; a bg session waiting on it shows `waitingFor: "dialog open"` → "Action requise dans le terminal".

### 13.5 Session lifecycle with stable IDs

Identifiers Nuera stores per session:

| Field | Source | Use |
| :- | :- | :- |
| `nueraId` | Nuera (UUID) | DB key, URLs |
| `claudeSessionId` | `--session-id <uuid>` at creation [VERIFY honoured with `--bg`]; else `sessionId` from `agents --json` | `--resume`, transcript lookup, hook correlation (`session_id`) |
| `bgId` | stdout `backgrounded · <id>` / `agents --json` `id` | `attach`, `logs`, `stop`, `rm`, `respawn` |
| `name` | `--name "nuera·<slug>·<n>"` (user may `/rename`) | display; fallback matching |
| `cwd` / `worktreePath` | `agents --json` `cwd`; hooks `cwd`; status line `worktree.path` | diff panel, git |
| `transcriptPath` | hook `transcript_path` | history |
| `rcUrl` | `CLAUDE_CODE_BRIDGE_SESSION_ID` via command hook | "Ouvrir sur claude.ai/code" |

Operations (all via `execFile`, no shell; `cwd` = project dir; stdin `/dev/null` for non-PTY commands):

* **Create**: `claude --bg --name <name> --session-id <uuid> --permission-mode <manual|acceptEdits|auto|plan> [--model <alias>] [--effort <level>] [--settings <file>] [--mcp-config <file> --strict-mcp-config] -- "<prompt>"` [INF: keep flags before a bare `--`, see "Prompts that contain `--bg`" in agent-view; VERIFY]. Without a prompt the session starts `blocked` waiting for its first prompt [DOC] → open the terminal. Parse `^backgrounded · ([0-9a-f]+)`; handle non-zero exit + stderr (`Workspace not trusted`, auth errors). Then confirm via `claude agents --json --cwd <dir>`.
* **Open (live)**: one node-pty per session running `claude attach <bgId>` (cols/rows from the focused client). `claude attach` "waits while the background service is starting or reconnecting" and restarts a stopped session from its saved conversation [DOC].
* **Detach**: write `\x1a` (Ctrl+Z: "goes back to … your shell if you ran `claude attach`") then close the PTY; killing the attach client should also leave the session running [VERIFY]. Note `←` on an empty prompt returns to **agent view** inside the PTY (official UI; Esc exits) [DOC].
* **Peek** (no attach): `claude logs <bgId>`.
* **Stop**: `claude stop <bgId>`. **Resume**: `claude attach <bgId>` or `claude respawn <bgId>`; or `claude --resume <claudeSessionId> --bg` (same ID or announced copy → update mapping on `note:`).
* **Fork**: `claude --resume <claudeSessionId> --fork-session --bg` or `/fork` in the TUI → new IDs.
* **Delete**: `claude rm <bgId>`; on refusal show the printed reason and offer the printed `--discard-unpushed …` only after an explicit destructive confirmation ("actions sensibles").
* **After a CLI update**: `claude respawn --all`.
* **Concurrency cap** [INF]: default max 3 working sessions, warning above (quota multiplies, §2.6).

### 13.6 Hook bridge (events → UI)

Settings fragment (same handler for every event; `async: true` so the agent loop never waits; the script **prints nothing** and **always exits 0**):

```json
{
  "hooks": {
    "SessionStart":       [{ "hooks": [{ "type": "command", "command": "/home/claude/.local/share/nuera/bin/nuera-hook", "args": [], "async": true, "timeout": 10 }] }],
    "UserPromptSubmit":   [{ "hooks": [{ "type": "command", "command": "/home/claude/.local/share/nuera/bin/nuera-hook", "args": [], "async": true, "timeout": 10 }] }],
    "PreToolUse":         [{ "matcher": "*", "hooks": [{ "type": "command", "command": "/home/claude/.local/share/nuera/bin/nuera-hook", "args": [], "async": true, "timeout": 10 }] }],
    "PermissionRequest":  [{ "matcher": "*", "hooks": [{ "type": "command", "command": "/home/claude/.local/share/nuera/bin/nuera-hook", "args": [], "async": true, "timeout": 10 }] }],
    "PostToolUse":        [{ "matcher": "*", "hooks": [{ "type": "command", "command": "/home/claude/.local/share/nuera/bin/nuera-hook", "args": [], "async": true, "timeout": 10 }] }],
    "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "/home/claude/.local/share/nuera/bin/nuera-hook", "args": [], "async": true, "timeout": 10 }] }],
    "Notification":       [{ "hooks": [{ "type": "command", "command": "/home/claude/.local/share/nuera/bin/nuera-hook", "args": [], "async": true, "timeout": 10 }] }],
    "SubagentStart":      [{ "hooks": [{ "type": "command", "command": "/home/claude/.local/share/nuera/bin/nuera-hook", "args": [], "async": true, "timeout": 10 }] }],
    "SubagentStop":       [{ "hooks": [{ "type": "command", "command": "/home/claude/.local/share/nuera/bin/nuera-hook", "args": [], "async": true, "timeout": 10 }] }],
    "Stop":               [{ "hooks": [{ "type": "command", "command": "/home/claude/.local/share/nuera/bin/nuera-hook", "args": [], "async": true, "timeout": 10 }] }],
    "StopFailure":        [{ "hooks": [{ "type": "command", "command": "/home/claude/.local/share/nuera/bin/nuera-hook", "args": [], "async": true, "timeout": 10 }] }],
    "PreCompact":         [{ "hooks": [{ "type": "command", "command": "/home/claude/.local/share/nuera/bin/nuera-hook", "args": [], "async": true, "timeout": 10 }] }],
    "PostCompact":        [{ "hooks": [{ "type": "command", "command": "/home/claude/.local/share/nuera/bin/nuera-hook", "args": [], "async": true, "timeout": 10 }] }],
    "CwdChanged":         [{ "hooks": [{ "type": "command", "command": "/home/claude/.local/share/nuera/bin/nuera-hook", "args": [], "async": true, "timeout": 10 }] }],
    "SessionEnd":         [{ "hooks": [{ "type": "command", "command": "/home/claude/.local/share/nuera/bin/nuera-hook", "args": [], "async": true, "timeout": 10 }] }]
  }
}
```

`nuera-hook` [INF]: read stdin (cap 1 MiB), attach `CLAUDE_CODE_SESSION_ID`, `CLAUDE_JOB_DIR`, `CLAUDE_CODE_BRIDGE_SESSION_ID`, POST to `http://127.0.0.1:<port>/internal/claude/events` with a bearer token read from a `0600` file, 2 s max, swallow every error. Backend: localhost-only route, token check, per-event allow-list, payload redaction (tool inputs/outputs can contain secrets), short retention. Alternative: `type: "http"` hooks (no process spawn) — but a down backend then yields visible "hook error" notices in the TUI [INF].

| Event | Nuera use |
| :- | :- |
| `SessionStart` | bind `session_id` ↔ `transcript_path` ↔ `cwd`; `source` (`startup/resume/fork/compact/clear`); RC id if present |
| `UserPromptSubmit` | journal "Vous : …" (`prompt`; note it also fires for `/loop`, subagent reports, cross-session messages) |
| `PreToolUse` / `PostToolUse` / `PostToolUseFailure` | activity timeline ("Bash `npm test` · 12 s"), files touched → refresh diff |
| `PermissionRequest` | instant "Autorisation requise : Bash `rm -rf node_modules`" card + push notification (no decision returned) |
| `Notification` | `permission_prompt`, `idle_prompt`, `auth_success`, elicitation types, `quota_auto_resume_*` |
| `Stop` | journal "Claude : …" (`last_assistant_message`), turn finished |
| `StopFailure` | `authentication_failed`/`oauth_org_not_allowed` → connexion requise; `rate_limit` → limite atteinte; `billing_error`, `overloaded`, `server_error` → error banner |
| `PreCompact`/`PostCompact` | "Conversation compactée" + `compact_summary` |
| `SubagentStart`/`Stop` | sub-task chips |
| `CwdChanged` | worktree move → diff panel target |
| `SessionEnd` | `reason` |
| `MessageDisplay` (optional) | live assistant text (`delta`, `index`, `final`); it is synchronous ("Claude Code holds each batch until your hook returns") → only with a very fast handler; [VERIFY] latency and failure noise; off by default |

Status line script `nuera-statusline` [INF]: prints a short line for the TUI (model · ctx % · 5 h % · 7 j %) and writes the full stdin JSON atomically to `~/.local/state/nuera/status/<session_id>.json` (or POSTs it). [VERIFY] it runs in unattended background sessions.

### 13.7 Surfacing permissions

1. **Starting mode** chosen in "Nouvelle session": Manuel (default) / Éditions auto (`acceptEdits`) / Auto (`auto`) / Plan. `bypassPermissions` hidden (docs: isolated containers/VMs only; refused as root).
2. **Live**: `agents --json` `status:"waiting"` + `waitingFor` gives the authoritative "blocked on what" signal; `PermissionRequest` hook gives the details; both feed a badge, the session card, and a web push.
3. **Answering**: button "Répondre dans le terminal" → opens the attached PTY; the owner answers the **official** dialog (Yes / don't ask again / No with comment). From the phone: Remote Control relays permission prompts.
4. **Optional phase 2** (documented but not v1): native Approve/Deny buttons via a synchronous `PermissionRequest` HTTP hook returning `decision.behavior`. Caveats [INF/VERIFY]: how the TUI behaves while the hook waits, double-answer races, and the security of approving from the web (re-auth, CSRF). Never auto-approve.
5. **Rules**: display allow/ask/deny from user/project/local settings; editing via `/permissions` in the TUI (or careful writes to `.claude/settings.local.json`).

### 13.8 Deriving the conversation view

1. **Authoritative & interactive**: xterm.js mirror of the attached TUI (fullscreen renderer; PgUp/PgDn/mouse wheel; `Ctrl+O` transcript mode). Mobile accessory bar: Esc, Tab, Shift+Tab (mode), ↑↓, Ctrl+C, PgUp/PgDn, Ctrl+O. A compose box may write text into the PTY as a bracketed paste + Enter [INF: identical to typing; acceptable], but the terminal stays visible.
2. **Journal (read-only)**: chronological cards from §13.6 events. Labelled "Journal", not a chat.
3. **History of past/stopped sessions (read-only)**: Agent SDK `listSessions({dir})` / `getSessionMessages(sessionId, {dir})`, pinned to the CLI's version; render text/tool_use/tool_result blocks, ignore unknown shapes; fallback: tolerant JSONL reader of `transcriptPath`; or ask the owner to run `/export <file>` in the TUI.
4. **Diff / commit / PR**: computed by Nuera with git in the session's worktree; PR number from status line `pr.*` / agent-view PR linking; Claude commits/pushes per §2.6.
5. **Never**: synthesize assistant messages, call `claude -p` to "answer" in a chat box, or screen-scrape TUI output into fake bubbles.

### 13.9 "Connexion requise" — detection and flow

| Signal | Meaning | Source |
| :- | :- | :- |
| `claude auth status --json` exit 1 / `loggedIn:false` / `authMethod:"none"` | not logged in | [DOC]/[LOCAL] |
| `authMethod` ≠ `"claude.ai"` (`api_key`, `oauth_token`, `api_key_helper`, `third_party`) | wrong credential type: billing risk, Remote Control impossible → warn | [DOC] |
| `loginExpiresAt` within 3 days | "Connexion expire bientôt" | [DOC] v2.1.318 |
| `StopFailure.error` = `authentication_failed` / `oauth_org_not_allowed` | a session hit an auth error | [DOC] |
| `agents --json` `state:"blocked"` with no live prompt + auth status not OK | blocked by expired login | [DOC]+[INF] |
| PTY text `Not logged in · Please run /login`, `Login expired · Please run /login`, `OAuth token revoked · Please run /login` | fallback only | [DOC] errors |
| `claude doctor` "Remote Control" section | RC eligibility | [LOCAL] |

Poll `auth status` on page load, after a `StopFailure`, and at most every 10 minutes (refresh-race fixes in 2.1.301/2.1.317).

**Login flow** (only Anthropic's own flow):
1. Screen "Connexion requise" explains and offers **"Se connecter (terminal)"**: an ephemeral PTY running `claude auth login --claudeai`; recording/scrollback persistence disabled; no Nuera field ever receives the code. The CLI prints the URL (clickable in xterm.js) → the owner signs in on claude.ai → pastes the displayed code into the terminal → `Login successful`.
2. Alternative shown on the same screen: `ssh -t <vps> claude auth login`.
3. Re-check `claude auth status --json`. If bg sessions then fail with `Could not resolve authentication method`: `claude daemon stop --any --keep-workers` and restart the supervisor within ~1 minute (e.g. by attaching a session) [DOC].

### 13.10 "Session indisponible" — detection matrix

| Cause | Signal | UI (FR) | Action |
| :- | :- | :- | :- |
| Idle process stopped (≈1 h) | `state:"done"`, no `pid` | "En veille" (not an error) | open = `claude attach` resumes |
| Crash / host died | `state:"failed"`; attach prints `terminal host process died` | "Interrompue" | "Relancer" → `claude attach` |
| Reboot < 48 h | `state:"failed"` | "Interrompue (redémarrage du serveur)" | attach, then ask Claude to continue |
| Reboot > 48 h | `state:"stopped"`, `ended while the background service was off` | "Arrêtée" | "Reprendre" (confirm) |
| Stopped by user | `state:"stopped"` | "Arrêtée" | attach / respawn |
| Transcript swept | attach: nothing to resume | "Historique supprimé" | `claude rm`; respawn reruns the original prompt (warn) |
| Open elsewhere | `Can't open — this session is running in another terminal` / `This conversation is already open in another running Claude session` | "Ouverte ailleurs" | wait/close other |
| Supervisor unreachable | `background service did not respond` / `claude daemon status` not running while sessions expected | banner "Service des sessions indisponible" | `claude daemon stop --any --keep-workers` then re-attach within 1 min |
| Removed | id absent from `agents --json --all` | "Introuvable" | history via SDK |
| Browser/WebSocket lost | Nuera-side | "Connexion perdue — la session continue sur le serveur" | auto-reconnect, re-spawn attach |

### 13.11 Remote Control (mobile & claude.ai/code)

* **Prerequisites**: full-scope claude.ai login (§6); none of the disabling variables (§3.1); one-time `Enable Remote Control?` acceptance in a TTY; trusted workspace.
* **Option A, per session** (v1): the owner types `/rc` in the attached terminal, or Nuera starts with `--remote-control "<name>"` [VERIFY with `--bg`]. The hook bridge captures `CLAUDE_CODE_BRIDGE_SESSION_ID` → Nuera shows "Ouvrir sur claude.ai/code" + its own QR of `https://claude.ai/code/<id>`.
* **Option B, server per project** (v2): Nuera runs `claude remote-control --name "<projet> · VPS-3" --spawn worktree` inside a managed PTY (so first-run prompts and the official QR are visible); sessions can be created from the app; resumable ~4 h after a stop; exits after ~10 min offline → Nuera restarts it.
* Tell the owner: while connected, "the session transcript … is stored on Anthropic servers" [DOC].

### 13.12 MCP in Nuera "Intégrations"

* Figma: guided setup (`claude mcp add --transport http figma https://mcp.figma.com/mcp --scope user`) and "Connecter" = PTY running `claude mcp login figma --no-browser` (the owner pastes the redirect URL back in the terminal). Coolify: whatever its MCP server documents, added via `claude mcp add`/`add-json`, secrets via env.
* Health: `claude mcp get <name>` / `claude mcp list` on demand, cached ≥ 5 min (they connect to servers); parse `✔`/`!`/`✘`/`⏸`/`⊘`, else show raw text.
* Per-session MCP selection: `--mcp-config <file> --strict-mcp-config` at creation (carried by bg restarts; re-pass on `--resume`).

### 13.13 Usage panel

Source: status-line JSON files (§13.6). Show the freshest `rate_limits.five_hour` / `seven_day` across sessions (with "mis à jour il y a …" — absent until a session made a request), per-session context %, model, effort, duration, lines ±. Link "Détails" → attached terminal running `/usage` (official screen). Cost only as a labelled API-price estimate, or hidden.

### 13.14 Mapping to the Figma screens

| Screen / state | Data & commands |
| :- | :- |
| Accueil | auth status, `agents --json --all` counts (working/blocked/done), freshest rate limits, supervisor health |
| Projets / Détail du projet | projects on disk; per-project `agents --json --cwd`, SDK `listSessions({dir})`, git status/worktrees |
| Ajouter un projet (clonage, erreur) | Nuera git clone → trust PTY (§13.4) |
| Workspace Claude Code | xterm.js attach + journal + diff + usage; mode chip from hooks `permission_mode` |
| Nouvelle session | `claude --bg …` form: prompt, mode, model, effort, MCP profile |
| Tâche longue | `state:"working"`; journal; push on `Stop`/blocked |
| Diff multi-fichiers / Commit et PR | git in the worktree; PR from status line / PR badge; Claude's own commit/PR behaviour |
| Sessions parallèles | multiple bg sessions, each in its worktree; concurrency cap |
| Connexion perdue | §13.10 last row + supervisor row |
| Sessions | `agents --json --all` (+ interactive sessions started over SSH) |
| Intégrations (MCP Figma, Coolify) | §13.12; Remote Control status (§13.11); `claude doctor` |
| Paramètres | CLI version/channel (`claude --version`, `doctor`), default mode, concurrency cap, retention, Remote Control toggle |
| États transversaux | loading = CLI call in flight; empty = no sessions; errors = mapped CLI stderr; actions sensibles = `rm`, `--discard-unpushed`, logout, purge |
| Workspace sur téléphone | Remote Control link (recommended) + mobile terminal with accessory bar |

---

## 14. COMPLIANCE ANALYSIS

### 14.1 Allowed (documented)

1. Installing and running the **unmodified** `claude` binary on the owner's VPS, signed in with the owner's **own** Claude Max account through the CLI's own login flow — [legal](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use) ("Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code").
2. Interactive use on a remote machine (tmux/screen explicitly suggested) — [remote-control](https://code.claude.com/docs/en/remote-control#limitations).
3. Background sessions and their shell commands, and reading their state with `claude agents --json` ("the supported way") — [agent-view](https://code.claude.com/docs/en/agent-view#read-session-state-from-a-script).
4. Remote Control on Max, including from claude.ai/code and the Claude app — [remote-control](https://code.claude.com/docs/en/remote-control#requirements), [self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments).
5. Hooks (command/http) and status-line scripts reporting to a local service — [hooks](https://code.claude.com/docs/en/hooks), [statusline](https://code.claude.com/docs/en/statusline).
6. MCP servers (incl. Figma remote MCP) authenticated through Claude Code's own OAuth (`/mcp`, `claude mcp login`) — [mcp](https://code.claude.com/docs/en/mcp#authenticate-from-the-command-line).
7. Reading the owner's local transcripts for display, preferably via the SDK read helpers built for "transcript viewers" — [agent-sdk sessions](https://code.claude.com/docs/en/agent-sdk/sessions#resume-across-hosts).
8. Displaying the usage data Claude Code exposes (status line `rate_limits`, `/usage`, `/status`) — [statusline](https://code.claude.com/docs/en/statusline#available-data), [costs](https://code.claude.com/docs/en/costs).
9. Saying in plain text that Nuera Dev "runs Claude Code" — [legal](https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products).

### 14.2 Uncertain — use with care or not at all

1. **Web terminal / PTY wrapper**: not addressed; judged allowed [INF] (equivalent to SSH; unmodified binary; human input). Keep it personal and unmodified.
2. **Login code pasted through Nuera's web terminal**: the bytes transit Nuera's PTY relay. Mitigate: no logging/recording on that PTY, no Nuera-owned input field, offer SSH as the clean path [INF].
3. **`claude -p` / stream-json / Agent SDK `query()` on the Max login**: documented as working for the subscriber's own scripts, but Anthropic directs "developers building products or services" to API keys and forbids claude.ai login/rate limits in third-party Agent-SDK products. **Not used** for Nuera's chat; avoid in v1 altogether.
4. **Nuera-initiated automation** (cron, webhooks that dispatch work): Consumer Terms bar "automated or non-human means … except … where we otherwise explicitly permit it". Prefer human-initiated actions and Claude Code's own scheduling/channels.
5. **Approving permissions from Nuera's UI via a `PermissionRequest` hook**: a documented hook capability, but a security-sensitive remote-approval path; phase 2 only, never automatic.
6. **Undocumented combinations**: `--bg` + `--session-id`, `--bg` + `--remote-control`, concurrent attach, status line in unattended sessions, `MessageDisplay` performance → [VERIFY].
7. **Agent SDK package licence** (Commercial Terms) when used only for local read helpers (no model call): low risk [INF]; alternative is a tolerant JSONL reader.
8. **Editing `~/.claude.json` to pre-trust a folder**: documented as a manual step, but it skips the human review of what a repo grants; prefer the trust dialog.
9. **Channels custom bridge**: research preview + `--dangerously-load-development-channels`; not for production now.

### 14.3 Must NOT be done

1. Reading, copying, parsing, transmitting, caching, or proxying `~/.claude/.credentials.json`, OAuth access/refresh tokens, or session tokens; calling Anthropic endpoints with them; exposing any "private API" backed by the Max subscription — "developers may not collect, store, or intermediate Claude.ai credentials or session tokens" ([legal](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)).
2. Generating or storing a `claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN` in Nuera (owner constraint; also cannot do Remote Control) — [authentication](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token).
3. A Nuera-owned "Se connecter avec Claude" form or embedded claude.ai login — "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications".
4. Unofficial proxies, gateways or shims (`ANTHROPIC_BASE_URL` pointed at a Max-to-API bridge, "OpenAI-compatible" wrappers, header spoofing).
5. Modifying, patching or repackaging the binary, or disabling its auth methods — [legal](https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products).
6. Letting anyone else use the Nuera instance (account sharing) or reselling access — [Consumer Terms](https://www.anthropic.com/legal/consumer-terms). If Nuera is ever offered to others: Commercial Terms, unmodified binary, each user's own credentials.
7. Simulating Claude's conversation: fabricated assistant messages, a chat box backed by `claude -p` on the subscription, or hiding the TUI behind screen-scraped bubbles.
8. Running `bypassPermissions` on the VPS host (only "isolated containers and VMs") — [permission-modes](https://code.claude.com/docs/en/permission-modes#skip-all-checks-with-bypasspermissions-mode).
9. Using Claude/Anthropic logos or names as Nuera's product identity — [legal](https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products).
10. (Functional) Setting `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`/`DISABLE_GROWTHBOOK`/`ANTHROPIC_API_KEY` on the VPS — they disable Remote Control or switch billing to the API.

---

## 15. VPS verification checklist (run once logged in, on the target version)

1. `claude --version` (≥ 2.1.317, ideally ≥ 2.1.318), `claude doctor` (install method, auto-updates, Remote Control eligibility).
2. `claude auth status --json` while logged in: record exact keys (expect `loggedIn`, `authMethod:"claude.ai"`, `loginExpiresAt`, …); confirm exit codes 0/1.
3. `claude --bg --session-id <uuid> --name t1 -- "say hi"` → does `agents --json` show `sessionId == <uuid>`? stdout format? exit code?
4. Same with `--remote-control "t1"` → RC session created? `CLAUDE_CODE_BRIDGE_SESSION_ID` visible to command hooks?
5. User-settings hooks fire in bg sessions (`SessionStart` … `SessionEnd`); still fire after `claude respawn`, supervisor restart, and a `--resume … --bg` copy.
6. Status line runs in an unattended bg session (file updated without any attach?).
7. node-pty `claude attach <id>`: Ctrl+Z detach, SIGHUP/kill of the attach client, resize, mouse wheel; second simultaneous attach behaviour.
8. Reboot test: states after reboot, `claude attach` recovery, supervisor auto-start.
9. `claude mcp list` / `get` output on the installed version (any `--json`?); `claude mcp login figma --no-browser` flow over the web terminal.
10. Untrusted cloned repo: exact `Workspace not trusted` error; trust via PTY dialog; `.mcp.json` approval behaviour in bg sessions.
11. Sandbox: `bubblewrap`/`socat` present, AppArmor on Ubuntu 24.04, `/sandbox` shows no missing dependency.
12. Auto-update path (native) or apt upgrade path + `claude respawn --all`; `claude daemon status` version-mismatch warning.
13. `MessageDisplay` hook: latency added to rendering; behaviour when the backend is down.

---

## 16. Sources

Official Claude Code docs (all fetched 2026-11-04; old `docs.anthropic.com` URLs redirect here):

* https://code.claude.com/docs/en/legal-and-compliance
* https://code.claude.com/docs/en/authentication
* https://code.claude.com/docs/en/agent-view
* https://code.claude.com/docs/en/sessions
* https://code.claude.com/docs/en/remote-control
* https://code.claude.com/docs/en/hooks · https://code.claude.com/docs/en/hooks-guide
* https://code.claude.com/docs/en/cli-reference
* https://code.claude.com/docs/en/headless
* https://code.claude.com/docs/en/permission-modes · https://code.claude.com/docs/en/permissions
* https://code.claude.com/docs/en/sandboxing
* https://code.claude.com/docs/en/settings · https://code.claude.com/docs/en/settings-reference
* https://code.claude.com/docs/en/env-vars
* https://code.claude.com/docs/en/setup · https://code.claude.com/docs/en/troubleshoot-install
* https://code.claude.com/docs/en/devcontainer
* https://code.claude.com/docs/en/mcp
* https://code.claude.com/docs/en/statusline · https://code.claude.com/docs/en/costs · https://code.claude.com/docs/en/commands
* https://code.claude.com/docs/en/errors
* https://code.claude.com/docs/en/claude-directory
* https://code.claude.com/docs/en/channels · https://code.claude.com/docs/en/channels-reference
* https://code.claude.com/docs/en/self-hosted-environments
* https://code.claude.com/docs/en/agent-sdk/overview · https://code.claude.com/docs/en/agent-sdk/sessions · https://code.claude.com/docs/en/agent-sdk/session-storage · https://code.claude.com/docs/en/agent-sdk/typescript
* https://code.claude.com/docs/en/changelog (v2.1.318, November 4, 2026)

Terms & help:

* https://www.anthropic.com/legal/consumer-terms (Effective Oct 8, 2025)
* https://www.anthropic.com/legal/commercial-terms (referenced, not analysed)
* https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan

Third party:

* https://developers.figma.com/docs/figma-mcp-server/remote-server-installation
* https://help.figma.com/hc/en-us/articles/35281350665623

Local read-only observations (v2.1.280, Windows): `claude --help`, `claude {agents,attach,logs,stop,rm,respawn,auth,auth login,auth status,mcp,mcp list,mcp get,mcp login,setup-token,install,update,project,doctor} --help`, `claude daemon --help`, `claude auth status --json|--text` (personal values redacted), `claude agents --json` (shape only), `claude daemon status`, `claude doctor`, `claude remote-control --help`.
