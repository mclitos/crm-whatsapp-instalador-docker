FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app /data /workspace/crm \
    && chown -R node:node /app /workspace \
    && chmod 1777 /data

COPY --chown=node:node package.json credenciales.env.example ./
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node deploy ./deploy

USER node
EXPOSE 7359 3000

CMD ["node", "scripts/container/start-installer.mjs"]
