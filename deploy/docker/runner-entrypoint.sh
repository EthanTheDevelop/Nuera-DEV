#!/bin/sh
# Runner entrypoint. Docker starts it as PID 1; it hands PID 1 over to tini, which runs it again as its child.
#  1. Environment hygiene, before any long-lived process exists. Claude sessions, terminals and project commands run
#     under the runner's uid and can read /proc/<pid>/environ of every process of the container, PID 1 included.
#     - RUNNER_DATABASE_URL (restricted PostgreSQL role of this server, docs/DEPLOY.md §13 and §14) replaces
#       DATABASE_URL: the instance DSN is then in no process environment (tini, runner, tmux, sessions). It only
#       stays in the container configuration Docker gives the processes it starts itself (healthcheck, docker exec).
#     - An optional variable left empty (compose passes "" when it is not set) is removed: the runner sees it unset.
#     - A pay-per-use key or a long-lived subscription token must never reach the CLI (owner constraint).
#  2. As PID 1: exec tini (signal forwarding, zombie reaping) with that cleaned environment.
#  3. Under tini: prepare the persistent directories and install the OFFICIAL Claude Code CLI (native installer,
#     unmodified) into the persistent HOME on first start. The CLI then keeps itself up to date with its own official
#     mechanism; Nuera Dev never touches its credentials. Each server has its own HOME volume, hence its own CLI and
#     its own Claude login.
set -eu

if [ -n "${RUNNER_DATABASE_URL:-}" ]; then
  DATABASE_URL="${RUNNER_DATABASE_URL}"
  export DATABASE_URL
else
  unset RUNNER_DATABASE_URL
fi
if [ -z "${NUERA_ENVIRONMENT_ID:-}" ]; then
  unset NUERA_ENVIRONMENT_ID
fi
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_OAUTH_TOKEN || true

if [ "$$" = "1" ]; then
  exec /usr/bin/tini -- "$0" "$@"
fi

mkdir -p "${NUERA_DATA_DIR:-/data}/sessions" "${NUERA_DATA_DIR:-/data}/logs" "${NUERA_PROJECTS_ROOT:-/srv/dev}"

if ! command -v claude >/dev/null 2>&1; then
  echo "[runner] Claude Code CLI absent : installation via l'installateur officiel (canal stable)…"
  if curl -fsSL https://claude.ai/install.sh | bash -s stable; then
    echo "[runner] Claude Code installé : $(claude --version 2>/dev/null || echo 'version inconnue')"
  else
    echo "[runner] Installation du CLI impossible pour l'instant. Nuera Dev affichera « Claude Code indisponible »." >&2
  fi
fi

exec "$@"
