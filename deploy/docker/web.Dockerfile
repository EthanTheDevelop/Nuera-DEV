# syntax=docker/dockerfile:1.7
# Nuera Dev — application web (Next.js standalone) + image de migration.
# Construit depuis la racine du dépôt : docker build -f deploy/docker/web.Dockerfile .

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /repo

# --- Dépendances (couche mise en cache tant que les manifestes ne changent pas) ---
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/web/package.json apps/web/package.json
COPY apps/runner/package.json apps/runner/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@nuera/web..." --filter "@nuera/db..."

# --- Build Next.js (sortie standalone) ---
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
ENV NEXT_OUTPUT_STANDALONE=1 NODE_ENV=production
RUN pnpm --filter @nuera/web build

# --- Migrations (service ponctuel `migrate` du compose) ---
FROM deps AS migrate
COPY tsconfig.base.json ./
COPY packages ./packages
CMD ["pnpm", "--filter", "@nuera/db", "migrate"]

# --- Image d'exécution ---
FROM node:24-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/web/server.js"]
