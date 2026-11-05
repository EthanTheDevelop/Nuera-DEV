# syntax=docker/dockerfile:1.7
# Nuera Dev — runner (Git, worktrees, terminaux, sessions Claude Code dans tmux, processus).
# Construit depuis la racine du dépôt : docker build -f deploy/docker/runner.Dockerfile .
# Debian (glibc ≥ 2.28) obligatoire : les binaires précompilés de @lydell/node-pty ne visent pas musl/Alpine.

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/web/package.json apps/web/package.json
COPY apps/runner/package.json apps/runner/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@nuera/runner..."
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/runner ./apps/runner
RUN pnpm --filter @nuera/runner build \
 && pnpm --filter @nuera/runner deploy --prod /out/runner \
 && cp -r apps/runner/dist /out/runner/dist \
 && cp -r apps/runner/bin /out/runner/bin

FROM node:24-bookworm-slim AS runtime
# git, tmux : sessions et dépôts ; bubblewrap + socat : bac à sable du CLI Claude Code ; procps : métriques.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git tmux ca-certificates curl procps bubblewrap socat tini less openssh-client locales \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 1001 nuera \
 && useradd --uid 1001 --gid nuera --create-home --home-dir /home/nuera --shell /bin/bash nuera \
 && mkdir -p /srv/dev /data \
 && chown -R nuera:nuera /srv/dev /data /home/nuera
WORKDIR /app
COPY --from=build --chown=nuera:nuera /out/runner /app
COPY deploy/docker/runner-entrypoint.sh /usr/local/bin/runner-entrypoint.sh
RUN chmod 0755 /usr/local/bin/runner-entrypoint.sh
USER nuera
ENV NODE_ENV=production \
    HOME=/home/nuera \
    PATH=/home/nuera/.local/bin:/usr/local/bin:/usr/bin:/bin \
    LANG=C.UTF-8 \
    TERM=xterm-256color \
    NUERA_PROJECTS_ROOT=/srv/dev \
    NUERA_DATA_DIR=/data \
    NUERA_SESSION_BACKEND=tmux \
    RUNNER_HOST=0.0.0.0 \
    RUNNER_PORT=4100 \
    RUNNER_HOOK_PORT=4101
# /srv/dev : clones et worktrees · /data : runtime des sessions, journaux · /home/nuera : CLI Claude Code et ~/.claude
VOLUME ["/srv/dev", "/data", "/home/nuera"]
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD curl -fsS -H "Authorization: Bearer ${RUNNER_TOKEN}" http://127.0.0.1:4100/v1/health >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/runner-entrypoint.sh"]
CMD ["node", "dist/index.mjs"]
