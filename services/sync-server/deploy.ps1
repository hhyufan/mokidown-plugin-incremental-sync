$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
docker compose version
if ($LASTEXITCODE -ne 0) { throw 'Install Docker Desktop with Compose first.' }
docker compose build
if ($LASTEXITCODE -ne 0) { throw 'Image build failed.' }
docker compose run --rm --no-deps sync npm run setup
if ($LASTEXITCODE -ne 0) { throw 'Configuration failed.' }
docker compose run --rm --no-deps sync npm run check:database
if ($LASTEXITCODE -ne 0) { throw 'Database check failed.' }
docker compose up -d
if ($LASTEXITCODE -ne 0) { throw 'Service start failed.' }
