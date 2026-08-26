#!/usr/bin/env bash
set -Eeuo pipefail

# ============================================================
# SHIVA - Simple CPU/API Deployment
# ============================================================

ROOT="/workspace/shiva"
REPO="$ROOT/repo"
APP="$REPO/app"
LOG_DIR="$ROOT/logs"
PM2_LOG_DIR="$LOG_DIR/pm2"
RUNTIME="$ROOT/runtime"


export NVM_DIR
export PM2_HOME

mkdir -p \
  "$PM2_LOG_DIR" \
  "$ROOT/config" \
  "$RUNTIME"

echo
echo "========================================"
echo " 🔱 Shiva CPU Deployment"
echo "========================================"

# ------------------------------------------------------------
# Load Shiva environment
# ------------------------------------------------------------

if [[ -f "$ROOT/scripts/env.sh" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT/scripts/env.sh"
fi

# ------------------------------------------------------------
# Database migrations
# ------------------------------------------------------------

echo
echo "[6/7] Running database migrations..."
cd "$APP"

ECOSYSTEM="$ROOT/config/ecosystem.config.cjs"
npm run db:migrate

# ------------------------------------------------------------
# PM2 services
# ------------------------------------------------------------

echo
echo "[7/7] Starting Shiva services..."

cat > "$ECOSYSTEM" <<PMEOF
module.exports = {
  apps: [
    {
      name: "shiva-api",
      cwd: "$APP",
      script: "npm",
      args: "start",
      interpreter: "none",

      autorestart: true,
      restart_delay: 2000,
      max_restarts: 20,

      out_file: "$PM2_LOG_DIR/api-out.log",
      error_file: "$PM2_LOG_DIR/api-error.log",

      filter_env: [
        "GOOGLE_",
        "EXPENSE_SHEET_ID"
      ],

      env: {
        NODE_ENV: "production"
      }
    },

    {
      name: "shiva-scheduler",
      cwd: "$APP",
      script: "npm",
      args: "run start:scheduler",
      interpreter: "none",

      autorestart: true,
      restart_delay: 2000,
      max_restarts: 20,
      kill_timeout: 35000,

      out_file: "$PM2_LOG_DIR/scheduler-out.log",
      error_file: "$PM2_LOG_DIR/scheduler-error.log",

      env: {
        NODE_ENV: "production"
      }
    },

    {
      name: "shiva-device-agent",
      cwd: "$APP",
      script: "npm",
      args: "run start:device-agent",
      interpreter: "none",

      autorestart: true,
      restart_delay: 2000,
      max_restarts: 20,

      out_file: "$PM2_LOG_DIR/device-agent-out.log",
      error_file: "$PM2_LOG_DIR/device-agent-error.log",

      env: {
        NODE_ENV: "production"
      }
    },

    {
      name: "shiva-google-agent",
      cwd: "$APP",
      script: "npm",
      args: "run start:google-agent",
      interpreter: "none",

      autorestart: true,
      restart_delay: 2000,
      max_restarts: 20,

      out_file: "$PM2_LOG_DIR/google-agent-out.log",
      error_file: "$PM2_LOG_DIR/google-agent-error.log",

      env: {
        NODE_ENV: "production"
      }
    },
   {
  name: "shiva-face",
  cwd: "/workspace/shiva/repo",

  script: "/workspace/shiva/runtime/venvs/face/bin/python",
  args: ["-m", "face.server"],
  interpreter: "none",

  autorestart: true,
  restart_delay: 2000,
  max_restarts: 20,

  out_file: "/workspace/shiva/runtime/pm2/logs/shiva-face-out.log",
  error_file: "/workspace/shiva/runtime/pm2/logs/shiva-face-error.log",

  env: {
    NODE_ENV: "production"
  }
}
  ]
};
PMEOF

pm2 delete shiva-api >/dev/null 2>&1 || true
pm2 delete shiva-scheduler >/dev/null 2>&1 || true
pm2 delete shiva-device-agent >/dev/null 2>&1 || true
pm2 delete shiva-google-agent >/dev/null 2>&1 || true

pm2 start "$ECOSYSTEM"
pm2 save

# ------------------------------------------------------------
# Health checks
# ------------------------------------------------------------

wait_for_health() {
  local NAME="$1"
  local URL="$2"

  echo "Waiting for ${NAME}..."

  for _ in {1..60}; do
    if curl -fsS "$URL" >/dev/null 2>&1; then
      echo "${NAME}: READY"
      return 0
    fi
    sleep 1
  done

  echo "ERROR: ${NAME} did not become healthy."
  return 1
}

wait_for_agent_heartbeat() {
  local NAME="$1"
  local AGENT_ID="$2"

  echo "Waiting for ${NAME} heartbeat..."

  for _ in {1..60}; do
    if [[ "$(redis-cli -u "$REDIS_URL" EXISTS "shiva:agent:heartbeat:${AGENT_ID}" 2>/dev/null)" == "1" ]]; then
      echo "${NAME}: READY"
      return 0
    fi
    sleep 1
  done

  echo "ERROR: ${NAME} did not publish a Redis heartbeat."
  return 1
}

echo
echo "Checking Shiva services..."

wait_for_health \
  "Shiva API" \
  "http://127.0.0.1:3000/health"

wait_for_health \
  "Device Agent" \
  "http://127.0.0.1:3002/health"

wait_for_agent_heartbeat \
  "Device Agent worker" \
  "device-agent"

wait_for_agent_heartbeat \
  "Google Agent" \
  "google-agent"

echo
echo "========================================"
echo " 🔱 Shiva is ready"
echo "========================================"
echo

pm2 status

echo
echo "Health:"
curl -s http://127.0.0.1:3000/health
echo

echo
echo "Useful commands:"
echo "  pm2 status"
echo "  pm2 logs shiva-api"
echo "  pm2 logs shiva-scheduler"
echo "  pm2 logs shiva-device-agent"
echo "  pm2 logs shiva-google-agent"
echo "  pm2 monit"
echo
