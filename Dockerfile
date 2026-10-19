# MokiDown sync plugin server (server + built-in proxy)
FROM node:22-alpine

WORKDIR /app
COPY server ./server
COPY bin ./bin

RUN addgroup -S sync && adduser -S sync -G sync \
    && mkdir -p /data && chown -R sync:sync /app /data
USER sync

ENV PORT=4319 \
    PROXY_PORT=4320 \
    DATA_DIR=/data \
    MOKIDOWN_SYNC_HOME=/data \
    TARGET=http://127.0.0.1:4319

EXPOSE 4320

# The proxy is the only listener; the sync server stays on loopback.
CMD ["node", "bin/cli.mjs", "run", "--no-tunnel", "--host", "0.0.0.0"]
