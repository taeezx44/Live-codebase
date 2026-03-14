#!/usr/bin/env bash
# ============================================================
# scripts/dev-setup.sh
#
# One-time setup script for a fresh clone.
# Run once: bash infra/scripts/dev-setup.sh
#
# What it does:
#   1. Check prerequisites (Docker, pnpm, bun, git)
#   2. Copy .env.example → .env (skip if already exists)
#   3. Start infra containers (postgres, neo4j, redis)
#   4. Wait for all health checks to pass
#   5. Run PostgreSQL migrations
#   6. Run Neo4j constraint setup
#   7. Install npm dependencies
#   8. Build shared packages
#   9. Print next steps
# ============================================================

set -euo pipefail

# ── Colors ───────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${BLUE}[setup]${RESET} $*"; }
success() { echo -e "${GREEN}[setup]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[setup]${RESET} $*"; }
error()   { echo -e "${RED}[setup] ERROR:${RESET} $*" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INFRA_DIR="$REPO_ROOT/infra"

info "Starting CodeVis dev setup from $REPO_ROOT"

# ── 1. Check prerequisites ────────────────────────────────────
info "Checking prerequisites..."

check_cmd() {
  command -v "$1" &>/dev/null || error "$1 is required but not installed. $2"
}

check_cmd docker  "Install from https://docs.docker.com/get-docker/"
check_cmd pnpm    "Install with: npm install -g pnpm"
check_cmd bun     "Install from https://bun.sh"
check_cmd git     "Install from https://git-scm.com"

DOCKER_VERSION=$(docker --version | grep -oP '\d+\.\d+' | head -1)
if (( $(echo "$DOCKER_VERSION < 24" | bc -l) )); then
  warn "Docker $DOCKER_VERSION detected — Docker 24+ recommended"
fi

success "All prerequisites found"

# ── 2. .env file ─────────────────────────────────────────────
if [[ ! -f "$REPO_ROOT/.env" ]]; then
  info "Creating .env from .env.example..."
  cp "$REPO_ROOT/.env.example" "$REPO_ROOT/.env"
  success ".env created — edit it to add your GitHub token"
else
  info ".env already exists — skipping"
fi

# ── 3. Start infra containers ─────────────────────────────────
info "Starting infrastructure containers (postgres, neo4j, redis)..."
cd "$INFRA_DIR"
docker compose up -d postgres neo4j redis

# ── 4. Wait for health checks ─────────────────────────────────
info "Waiting for services to be healthy..."

wait_healthy() {
  local SERVICE=$1
  local MAX_WAIT=${2:-120}
  local ELAPSED=0
  local INTERVAL=3

  printf "${BLUE}[setup]${RESET} Waiting for %s " "$SERVICE"
  while true; do
    STATUS=$(docker compose ps --format json "$SERVICE" 2>/dev/null \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('Health',''))" 2>/dev/null || echo "")

    if [[ "$STATUS" == "healthy" ]]; then
      echo -e " ${GREEN}healthy${RESET}"
      return 0
    fi

    if (( ELAPSED >= MAX_WAIT )); then
      echo ""
      error "$SERVICE did not become healthy within ${MAX_WAIT}s"
    fi

    printf "."
    sleep $INTERVAL
    (( ELAPSED += INTERVAL ))
  done
}

wait_healthy postgres 60
wait_healthy neo4j    120    # Neo4j is slow to start
wait_healthy redis    30

success "All services healthy"

# ── 5. PostgreSQL migrations ──────────────────────────────────
info "Running PostgreSQL migrations..."

# Check if schema already exists (idempotent)
TABLE_COUNT=$(docker compose exec -T postgres \
  psql -U postgres -d codevis -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo "0")

if [[ "$TABLE_COUNT" -gt "0" ]]; then
  info "PostgreSQL schema already exists ($TABLE_COUNT tables) — skipping"
else
  docker compose exec -T postgres \
    psql -U postgres -d codevis \
    -f /docker-entrypoint-initdb.d/001_init.sql
  success "PostgreSQL migrations complete"
fi

# ── 6. Neo4j constraints ──────────────────────────────────────
info "Setting up Neo4j constraints and indexes..."

NEO4J_CYPHER=$(cat "$INFRA_DIR/migrations/neo4j/001_constraints.cypher" \
  | grep -v '^//' | grep -v '^$' | tr '\n' ' ')

docker compose exec -T neo4j \
  cypher-shell -u neo4j -p password \
  "$NEO4J_CYPHER" 2>/dev/null && success "Neo4j constraints created" \
  || warn "Neo4j constraint setup skipped (may already exist)"

# ── 7. Install npm dependencies ───────────────────────────────
info "Installing npm dependencies..."
cd "$REPO_ROOT"
pnpm install
success "Dependencies installed"

# ── 8. Build shared packages ──────────────────────────────────
info "Building shared packages..."
pnpm run --filter @codevis/shared build
pnpm run --filter @codevis/analysis-engine build
success "Shared packages built"

# ── 9. Done ───────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${GREEN}${BOLD}  CodeVis dev setup complete!${RESET}"
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e "  ${BOLD}Start everything:${RESET}   pnpm dev"
echo -e "  ${BOLD}Start infra only:${RESET}   docker compose up -d"
echo ""
echo -e "  ${BOLD}Service URLs:${RESET}"
echo -e "   Frontend     →  http://localhost:3000"
echo -e "   API          →  http://localhost:4000"
echo -e "   Neo4j UI     →  http://localhost:7474  (neo4j / password)"
echo -e "   RedisInsight →  docker compose --profile tools up redis-insight"
echo ""
echo -e "  ${BOLD}Useful commands:${RESET}"
echo -e "   pnpm test            run all tests"
echo -e "   pnpm typecheck       typecheck all packages"
echo -e "   docker compose logs  tail service logs"
echo -e "   bash infra/scripts/reset-db.sh   wipe all data"
echo ""
