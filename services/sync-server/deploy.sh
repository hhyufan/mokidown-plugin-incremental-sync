#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if ! docker compose version >/dev/null 2>&1; then
  echo 'Install Docker Engine and the Docker Compose plugin, then run sh deploy.sh again.' >&2
  exit 1
fi
docker compose build
docker compose run --rm --no-deps sync npm run setup
docker compose run --rm --no-deps sync npm run check:database
docker compose up -d
echo 'Service started on 127.0.0.1:8787. Configure your HTTPS reverse proxy and paste the access key into MokiDown settings.'
