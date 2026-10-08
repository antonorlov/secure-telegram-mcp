# syntax=docker/dockerfile:1
#
# secure-telegram-mcp — split setup/connect entrypoints, non-root, fail-closed.
#
#   SETUP (interactive, RW config volume):
#     docker run --rm -it \
#       --env-file ./telegram.env \
#       -v "$PWD/config:/config" \
#       -v tg-sessions:/sessions \
#       -v "$PWD/media:/media" \
#       IMAGE setup
#
#   CONNECT (stdio MCP, config mounted READ-ONLY so the model cannot rewrite its
#            own ACL even in-container — #5/#8):
#     docker run --rm -i \
#       --env-file ./telegram.env \
#       -v "$PWD/config:/config:ro" \
#       -v tg-sessions:/sessions \
#       -v "$PWD/media:/media" \
#       IMAGE connect
#
# Secrets (TELEGRAM_API_ID/HASH, TELEGRAM_MCP_SESSION_PASSPHRASE) are supplied
# via --env-file or a secrets manager — NEVER baked into the image.

# ---- build stage ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Prune to production dependencies for the runtime image.
RUN npm prune --omit=dev

# ---- runtime stage (non-root) ----
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Copy only what the CLI needs at runtime.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Mount points: config (RW for setup, RO for connect), encrypted sessions, and
# confined media ingress/egress. Pre-create them for the unprivileged runtime.
RUN mkdir -p /config /sessions /media && chown -R node:node /config /sessions /media

# Defaults; override via --env-file. STDOUT is reserved for the MCP transport.
ENV TELEGRAM_MCP_CONFIG=/config/telegram-mcp.config.json
ENV TELEGRAM_MCP_SESSION_DIR=/sessions
ENV TELEGRAM_MCP_AUDIT_LOG=/sessions/audit.log
ENV TELEGRAM_MCP_MEDIA_DIR=/media

VOLUME ["/config", "/sessions", "/media"]

# Run as the unprivileged 'node' user (already present in the base image).
USER node

# Split entrypoints share one dispatcher bin; CMD selects setup vs connect.
ENTRYPOINT ["node", "dist/presentation/cli/main.js"]
CMD ["connect"]
