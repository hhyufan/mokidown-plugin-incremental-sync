#!/usr/bin/env bash
# One-shot deployment for the MokiDown sync plugin server on a Linux VPS.
#
#   sudo bash deploy/install.sh sync.example.com
#
# Installs Node 22 + Caddy, creates an unprivileged user, writes the access
# token, starts the sync server and the built-in proxy as systemd services,
# and configures Caddy for automatic HTTPS.
set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "usage: sudo bash deploy/install.sh <sync-domain>" >&2
  exit 1
fi

APP_DIR=/opt/mokidown-plugin-incremental-sync
DATA_DIR=/var/lib/mokidown-sync
ENV_FILE=/etc/mokidown-sync.env
USER_NAME=mokidown-sync

if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi

id -u "$USER_NAME" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$USER_NAME"
mkdir -p "$APP_DIR" "$DATA_DIR" /var/log/caddy
cp -r server "$APP_DIR/"
chown -R "$USER_NAME:$USER_NAME" "$DATA_DIR"
chmod 700 "$DATA_DIR"

if [ ! -f "$ENV_FILE" ]; then
  TOKEN="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  cat > "$ENV_FILE" <<EOF
SYNC_TOKEN=$TOKEN
PORT=4319
PROXY_PORT=4320
DATA_DIR=$DATA_DIR
TARGET=http://127.0.0.1:4319
PROXY_RATE_LIMIT=120
PROXY_RATE_WINDOW_MS=60000
EOF
  chmod 600 "$ENV_FILE"
  echo "Generated access token in $ENV_FILE"
fi

cat > /etc/systemd/system/mokidown-sync-server.service <<EOF
[Unit]
Description=MokiDown sync server (loopback only)
After=network.target

[Service]
Type=simple
User=$USER_NAME
Group=$USER_NAME
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node server/index.mjs
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/mokidown-sync-proxy.service <<EOF
[Unit]
Description=MokiDown sync proxy (only public listener)
After=network.target mokidown-sync-server.service

[Service]
Type=simple
User=$USER_NAME
Group=$USER_NAME
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node server/proxy.mjs
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now mokidown-sync-server.service mokidown-sync-proxy.service

cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode zstd gzip
	request_body {
		max_size 6MB
	}
	reverse_proxy 127.0.0.1:4320 {
		header_up Host {host}
	}
	log {
		output file /var/log/caddy/mokidown-sync.log
		format json
	}
}
EOF
systemctl reload caddy || systemctl restart caddy

echo
echo "Deployed. Endpoint for the plugin: https://$DOMAIN"
echo "Access token (kept server-side): see $ENV_FILE"
