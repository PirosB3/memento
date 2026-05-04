#!/usr/bin/env bash
set -euo pipefail

# Start all Summon Agents services in a single terminal.
# Infrastructure (PostgreSQL, Temporal) runs in Docker.
# App processes (worker, web, gateway) run on the host.
#
# Usage: ./scripts/dev.sh
# Stop:  Ctrl-C (kills app processes; Docker containers keep running)
# Full stop: Ctrl-C then `docker compose down`

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

cleanup() {
  trap - EXIT INT TERM
  echo ""
  echo "Shutting down app services..."
  kill 0 2>/dev/null
  wait 2>/dev/null
  echo "Done. Docker containers are still running — use 'docker compose down' to stop them."
}
trap cleanup EXIT INT TERM

# Colors for log prefixes
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

prefix() {
  local color="$1" label="$2"
  sed -u "s/^/$(printf "${color}[${label}]${NC} ")/"
}

# --- Start infrastructure via Docker Compose ---
echo "Starting infrastructure (PostgreSQL, Temporal)..."
docker compose up -d

# Wait for PostgreSQL to be healthy
echo "Waiting for PostgreSQL..."
until docker compose exec -T postgres pg_isready -U summon -d summon_dev > /dev/null 2>&1; do
  sleep 1
done
echo "PostgreSQL is ready."

# Wait for Temporal to accept connections
echo "Waiting for Temporal..."
until docker compose exec -T temporal temporal operator cluster health --address temporal:7233 2>/dev/null | grep -q SERVING; do
  sleep 2
done
echo "Temporal is ready."

# --- Optionally expose the dev server over Tailscale ---
# Best-effort: if the Tailscale CLI is present and the node is logged in,
# proxy https://<magic-dns>:8443 -> http://127.0.0.1:3000 (tailnet only,
# never public). Skips silently when tailscale isn't available.
TAILSCALE_HOSTNAME=""
if command -v tailscale >/dev/null 2>&1; then
  TAILSCALE_HOSTNAME="$(
    tailscale status --json 2>/dev/null \
      | python3 -c 'import sys, json; print(json.load(sys.stdin).get("Self", {}).get("DNSName", "").rstrip("."))' 2>/dev/null \
      || true
  )"
  if [ -n "$TAILSCALE_HOSTNAME" ]; then
    if tailscale serve --bg --https=8443 3000 >/dev/null 2>&1; then
      export DEV_ALLOWED_ORIGINS="$TAILSCALE_HOSTNAME"
      echo "Tailscale proxy: https://$TAILSCALE_HOSTNAME:8443 -> :3000"
    else
      echo "Note: 'tailscale serve' failed; continuing without tailnet proxy."
      TAILSCALE_HOSTNAME=""
    fi
  fi
fi

# --- Run pending database migrations ---
echo "Applying database migrations..."
pnpm db:migrate:deploy 2>&1 | prefix "$RED" "migrate"

# --- Start app processes ---
echo "Starting worker..."
pnpm dev:worker 2>&1 | prefix "$GREEN" "worker" &

echo "Starting web..."
pnpm dev:web 2>&1 | prefix "$BLUE" "web" &

echo "Starting email gateway..."
pnpm dev:gateway 2>&1 | prefix "$YELLOW" "gateway" &

echo ""
echo "All services started. Press Ctrl-C to stop app processes."
echo "  Temporal UI: http://localhost:8233"
echo "  Web:         http://localhost:3000"
[ -n "$TAILSCALE_HOSTNAME" ] && echo "  Web (tailnet): https://$TAILSCALE_HOSTNAME:8443"
echo ""

wait
