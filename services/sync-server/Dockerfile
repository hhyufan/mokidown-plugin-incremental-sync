FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir /app/state && chown node:node /app/state
COPY src ./src
COPY scripts ./scripts
USER node
ENV HOST=0.0.0.0 PORT=8787 MOKIDOWN_CONFIG=/app/state/config.json
VOLUME ["/app/state"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["node", "scripts/healthcheck.mjs"]
CMD ["node", "src/index.mjs"]
