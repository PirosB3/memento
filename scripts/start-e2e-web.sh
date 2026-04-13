#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

docker compose up -d postgres

until docker compose exec -T postgres pg_isready -U summon -d summon_dev > /dev/null 2>&1; do
  sleep 1
done

dotenv -e .env.test -- pnpm --filter @summon/shared db:migrate:reset
SUMMON_FAKE_EXTERNALS=1 dotenv -e .env.test -- pnpm --filter @summon/web exec next dev --hostname 127.0.0.1 --port 3310
