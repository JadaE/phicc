# Discord bridge image for the NAS. Secrets are not copied and are not ENV values.
# Pin is the node:22-bookworm-slim manifest list (linux, multi-arch).
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY bridge.js bot.js config.example.json ./
COPY discord-bridge ./discord-bridge
COPY scripts ./scripts
COPY deploy/nas/entrypoint.js ./deploy/nas/entrypoint.js

USER 10001:10001

ENV NODE_ENV=production \
    HOME=/tmp

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "discord-bridge/scripts/health.js", "/srv/ssd1/discord-bridge/logs/heartbeat.json"]

ENTRYPOINT ["node", "deploy/nas/entrypoint.js"]
