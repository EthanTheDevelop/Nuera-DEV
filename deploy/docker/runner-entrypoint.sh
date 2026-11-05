#!/bin/sh
# Runner entrypoint: prepares the persistent directories and installs the OFFICIAL Claude Code CLI
# (native installer, unmodified) into the persistent HOME on first start. The CLI then keeps itself
# up to date with its own official mechanism; Nuera Dev never touches its credentials.
set -eu

mkdir -p "${NUERA_DATA_DIR:-/data}/sessions" "${NUERA_DATA_DIR:-/data}/logs" "${NUERA_PROJECTS_ROOT:-/srv/dev}"

if ! command -v claude >/dev/null 2>&1; then
  echo "[runner] Claude Code CLI absent : installation via l'installateur officiel (canal stable)…"
  if curl -fsSL https://claude.ai/install.sh | bash -s stable; then
    echo "[runner] Claude Code installé : $(claude --version 2>/dev/null || echo 'version inconnue')"
  else
    echo "[runner] Installation du CLI impossible pour l'instant. Nuera Dev affichera « Claude Code indisponible »." >&2
  fi
fi

# Never let a pay-per-use key or a long-lived subscription token reach the CLI (owner constraint).
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_OAUTH_TOKEN || true

exec "$@"
