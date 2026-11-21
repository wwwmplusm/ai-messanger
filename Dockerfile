FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN install -d -o node -g node -m 0700 /data

FROM base AS bot
COPY package*.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
COPY public/ ./public/
COPY assets/ ./assets/
USER node
CMD ["node", "src/bot.js"]

FROM base AS runner
RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap ca-certificates git poppler-utils python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @openai/codex@0.171.0
COPY src/ ./src/
USER node
CMD ["node", "src/runner.js"]
