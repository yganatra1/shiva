#!/usr/bin/env bash
set -Eeuo pipefail

# ============================================================
# Shiva deployment / startup
# ============================================================

ROOT="/workspace/shiva"
REPO="$ROOT/repo"
APP="$REPO/app"

RUNTIME="$ROOT/runtime"
STATE_DIR="$RUNTIME/state"

ASR_VENV="$RUNTIME/venvs/asr"
TTS_VENV="$RUNTIME/venvs/tts"

LOG_DIR="$ROOT/logs"
PM2_LOG_DIR="$LOG_DIR/pm2"

ECOSYSTEM="$ROOT/config/ecosystem.config.cjs"

NVM_DIR="$RUNTIME/nvm"
PM2_HOME="$RUNTIME/pm2"

export NVM_DIR
export PM2_HOME

mkdir -p \
  "$STATE_DIR" \
  "$PM2_LOG_DIR" \
  "$ROOT/config" \
  "$ROOT/models/huggingface" \
  "$RUNTIME/venvs"

echo
echo "========================================"
echo " 🔱 Shiva Deployment"
echo "========================================"

# ------------------------------------------------------------
# Load Shiva environment
# ------------------------------------------------------------

if [[ -f "$ROOT/scripts/env.sh" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT/scripts/env.sh"
fi

export HF_HOME="${HF_HOME:-$ROOT/models/huggingface}"

# ------------------------------------------------------------
# Node / NVM
# ------------------------------------------------------------

echo
echo "[1/9] Preparing Node.js..."

if [[ ! -f "$NVM_DIR/nvm.sh" ]]; then
  echo "ERROR: NVM not found at:"
  echo "$NVM_DIR/nvm.sh"
  exit 1
fi

# shellcheck disable=SC1090
source "$NVM_DIR/nvm.sh"

nvm install 24
nvm use 24
nvm alias default 24 >/dev/null

echo "Node: $(node --version)"
echo "npm:  $(npm --version)"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "Installing PM2..."
  npm install -g pm2
fi

echo "PM2:  $(pm2 --version)"

# ------------------------------------------------------------
# PostgreSQL + Redis + Ollama
# ------------------------------------------------------------

echo
echo
echo "[2/9] Starting PostgreSQL + Redis + Ollama..."

"$ROOT/scripts/start-postgres.sh"

# PostgreSQL startup may update DATABASE_URL/password.
# Reload the latest Shiva environment.
set -a
source "$ROOT/config/postgres.env"
set +a

echo "Checking Shiva database connection..."


if ! psql "$DATABASE_URL" -c "SELECT 1;" >/dev/null 2>&1; then
  echo "ERROR: Shiva database authentication failed."
  exit 1
fi

echo "Database: READY"

export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
if ! redis-cli -u "$REDIS_URL" ping >/dev/null 2>&1; then
  if command -v service >/dev/null 2>&1; then
    service redis-server start >/dev/null 2>&1 || true
  fi
fi
if ! redis-cli -u "$REDIS_URL" ping >/dev/null 2>&1; then
  echo "ERROR: Redis is not available at the configured REDIS_URL."
  exit 1
fi

REDIS_VERSION="$(redis-cli -u "$REDIS_URL" --raw INFO server 2>/dev/null | tr -d '\r' | sed -n 's/^redis_version:\([0-9][0-9.]*\)$/\1/p' | head -n 1)"
REDIS_MAJOR="${REDIS_VERSION%%.*}"
if [[ ! "$REDIS_MAJOR" =~ ^[0-9]+$ ]] || (( REDIS_MAJOR < 7 )); then
  echo "ERROR: Redis 7 or newer is required for agent task recovery (found: ${REDIS_VERSION:-unknown})."
  exit 1
fi

echo "Redis $REDIS_VERSION: READY"

if ! curl -fsS http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
  echo "ERROR: Ollama is not available."
  exit 1
fi

# ------------------------------------------------------------
# Git pull
# ------------------------------------------------------------

echo
echo "[3/9] Updating Shiva repository..."

cd "$REPO"

git status --short

git pull --ff-only

echo "Revision:"
git log -1 --oneline

# ------------------------------------------------------------
# Node dependencies
# ------------------------------------------------------------

echo
echo "[4/9] Installing Node dependencies..."

cd "$APP"

LOCK_HASH="$(sha256sum package-lock.json | awk '{print $1}')"
LOCK_STATE="$STATE_DIR/package-lock.sha256"

CURRENT_LOCK_HASH=""
if [[ -f "$LOCK_STATE" ]]; then
  CURRENT_LOCK_HASH="$(cat "$LOCK_STATE")"
fi

if [[ \
  ! -d node_modules || \
  "$LOCK_HASH" != "$CURRENT_LOCK_HASH" \
]]; then

  echo "package-lock changed or node_modules missing."
  echo "Running npm ci..."

  npm ci --include=dev
 

  echo "$LOCK_HASH" > "$LOCK_STATE"

else
  echo "Node dependencies unchanged. Skipping npm ci."
fi

# ------------------------------------------------------------
# Build Node
# ------------------------------------------------------------

echo
echo "[5/9] Building Shiva API..."

# npm run typecheck
npm run build

# Optional:
# RUN_TESTS=1 /workspace/shiva/scripts/deploy-shiva.sh

if [[ "${RUN_TESTS:-0}" == "1" ]]; then
  echo
  echo "Running tests..."
  npm test
fi

# ------------------------------------------------------------
# Python environment helper
# ------------------------------------------------------------

install_python_service() {
  local NAME="$1"
  local VENV="$2"
  local REQUIREMENTS="$3"

  echo
  echo "Preparing ${NAME}..."

  if [[ ! -x "$VENV/bin/python" ]]; then
    echo "Creating ${NAME} virtual environment..."

    python3.12 -m venv "$VENV"
  fi

  local REQ_HASH
  local STATE_FILE
  local OLD_HASH=""

  REQ_HASH="$(sha256sum "$REQUIREMENTS" | awk '{print $1}')"
  STATE_FILE="$STATE_DIR/${NAME}-requirements.sha256"

  if [[ -f "$STATE_FILE" ]]; then
    OLD_HASH="$(cat "$STATE_FILE")"
  fi

  if [[ \
    "$REQ_HASH" != "$OLD_HASH" || \
    "${FORCE_PY_INSTALL:-0}" == "1" \
  ]]; then

    echo "${NAME} requirements changed."
    echo "Installing dependencies..."

    "$VENV/bin/python" -m pip install --upgrade pip

    "$VENV/bin/python" \
      -m pip install \
      -r "$REQUIREMENTS"

    echo "$REQ_HASH" > "$STATE_FILE"

  else
    echo "${NAME} requirements unchanged. Skipping pip install."
  fi
}

# ------------------------------------------------------------
# ASR
# ------------------------------------------------------------

echo
echo "[6/9] Preparing ASR..."

install_python_service \
  "asr" \
  "$ASR_VENV" \
  "$REPO/voice/asr/requirements.txt"

# ------------------------------------------------------------
# TTS
# ------------------------------------------------------------

echo
echo "[7/9] Preparing TTS..."

install_python_service \
  "tts" \
  "$TTS_VENV" \
  "$REPO/voice/tts/requirements.txt"

# ------------------------------------------------------------
# Database migrations
# ------------------------------------------------------------
echo
echo "[8/9] Running database migrations..."

cd "$APP"

npm run db:migrate

# ------------------------------------------------------------
# PM2 ecosystem
# ------------------------------------------------------------

echo
echo "[9/9] Starting Shiva services with PM2..."

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

      // Google credentials belong only to google-agent. Core coordinates the
      // request and owns policy, but no longer executes Google skills.
      filter_env: [
        "GOOGLE_",
        "EXPENSE_SHEET_ID"
      ],

      env: {
        NODE_ENV: "production"
      }
    },

    {
      name: "shiva-device-agent",
      cwd: "$APP",
      script: "npm",
      args: "start:device-agent",
      interpreter: "none",

      autorestart: true,
      restart_delay: 2000,
      max_restarts: 20,

      out_file: "$PM2_LOG_DIR/device-agent-out.log",
      error_file: "$PM2_LOG_DIR/device-agent-error.log",

      // PM2 inherits the deployment shell. Filter secret-bearing Core/Google
      // prefixes before it starts the npm wrapper; the runner then applies a
      // strict allowlist again before accepting work.
      filter_env: [
        "DATABASE_",
        "POSTGRES_",
        "GOOGLE_",
        "BRAVE_",
        "WEB_",
        "EXPENSE_",
        "EMBEDDING_",
        "WORKING_MEMORY_",
        "MEMORY_",
        "ASR_",
        "TTS_",
        "FACE_",
        "SHIVA_USER_",
        "SHIVA_MAX_EXECUTION_MODE",
        "SHIVA_CONFIRMATION_",
        "AGENT_TASK_TIMEOUT_MS",
        "DEVICE_AGENT_URL"
      ],

      env: {
        NODE_ENV: "production"
      }
    },

    {
      name: "shiva-google-agent",
      cwd: "$APP",
      script: "npm",
      args: "start:google-agent",
      interpreter: "none",

      autorestart: true,
      restart_delay: 2000,
      max_restarts: 20,

      out_file: "$PM2_LOG_DIR/google-agent-out.log",
      error_file: "$PM2_LOG_DIR/google-agent-error.log",

      // Google Agent needs only OAuth/Sheets, Ollama, Redis, and bounded
      // worker settings. Core owns PostgreSQL and confirmation state.
      filter_env: [
        "DATABASE_",
        "POSTGRES_",
        "DEVICE_",
        "BRAVE_",
        "WEB_",
        "EMBEDDING_",
        "WORKING_MEMORY_",
        "MEMORY_",
        "ASR_",
        "TTS_",
        "FACE_",
        "SHIVA_MAX_EXECUTION_MODE",
        "SHIVA_CONFIRMATION_",
        "SHIVA_PERF_LOG",
        "SHIVA_AGENT_TRACE_LOG",
        "AGENT_TASK_TIMEOUT_MS",
        "EXPENSE_SHEET_ID",
        "GOOGLE_APPLICATION_CREDENTIALS"
      ],

      env: {
        NODE_ENV: "production"
      }
    },

    {
      name: "shiva-asr",
      cwd: "$REPO",
      script: "/bin/bash",
      args: [
        "-lc",
        "exec $ASR_VENV/bin/python -m voice.asr.server"
      ],
      interpreter: "none",

      autorestart: true,
      restart_delay: 3000,
      max_restarts: 20,

      out_file: "$PM2_LOG_DIR/asr-out.log",
      error_file: "$PM2_LOG_DIR/asr-error.log",

      // Google credentials belong exclusively to google-agent, including
      // when PM2 starts auxiliary voice services from the same shell.
      filter_env: [
        "GOOGLE_"
      ]
    },

    {
      name: "shiva-tts",
      cwd: "$REPO",
      script: "/bin/bash",
      args: [
        "-lc",
        "exec $TTS_VENV/bin/python -m voice.tts.server"
      ],
      interpreter: "none",

      autorestart: true,
      restart_delay: 3000,
      max_restarts: 20,

      out_file: "$PM2_LOG_DIR/tts-out.log",
      error_file: "$PM2_LOG_DIR/tts-error.log",

      filter_env: [
        "GOOGLE_"
      ]
    }
  ]
};
PMEOF

# Re-create managed apps on deployment so changed ecosystem
# configuration is always applied.

pm2 delete shiva-api >/dev/null 2>&1 || true
pm2 delete shiva-device-agent >/dev/null 2>&1 || true
pm2 delete shiva-google-agent >/dev/null 2>&1 || true
pm2 delete shiva-asr >/dev/null 2>&1 || true
pm2 delete shiva-tts >/dev/null 2>&1 || true

pm2 start "$ECOSYSTEM"

pm2 save

# ------------------------------------------------------------
# Health checks
# ------------------------------------------------------------

wait_for_health() {
  local NAME="$1"
  local URL="$2"

  echo "Waiting for ${NAME}..."

  for i in {1..60}; do

    if curl -fsS "$URL" >/dev/null 2>&1; then
      echo "${NAME}: READY"
      return 0
    fi

    sleep 1
  done

  echo "ERROR: ${NAME} did not become healthy."
  return 1
}

echo
echo "Checking Shiva services..."

wait_for_health \
  "ASR" \
  "http://127.0.0.1:8101/health"

wait_for_health \
  "TTS" \
  "http://127.0.0.1:8102/health"

wait_for_health \
  "Shiva API" \
  "http://127.0.0.1:3000/health"

wait_for_health \
  "Device Agent" \
  "http://127.0.0.1:3002/health"

wait_for_agent_heartbeat() {
  local NAME="$1"
  local AGENT_ID="$2"
  echo "Waiting for ${NAME} heartbeat..."
  for i in {1..60}; do
    if [[ "$(redis-cli -u "$REDIS_URL" EXISTS "shiva:agent:heartbeat:${AGENT_ID}" 2>/dev/null)" == "1" ]]; then
      echo "${NAME}: READY"
      return 0
    fi
    sleep 1
  done
  echo "ERROR: ${NAME} did not publish a Redis heartbeat."
  return 1
}

wait_for_agent_heartbeat "Device Agent worker" "device-agent"
wait_for_agent_heartbeat "Google Agent" "google-agent"

# ------------------------------------------------------------
# Warm Ollama models
# ------------------------------------------------------------

echo
echo "Keeping Shiva models resident..."

MAIN_MODEL="${SHIVA_MODEL:-gemma4:26b-a4b-it-q4_K_M}"
EMBED_MODEL="${EMBEDDING_MODEL:-embeddinggemma}"

curl -fsS http://127.0.0.1:11434/api/embed \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$EMBED_MODEL\",
    \"input\": \"Shiva startup\",
    \"keep_alive\": -1
  }" >/dev/null

curl -fsS http://127.0.0.1:11434/api/chat \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$MAIN_MODEL\",
    \"messages\": [
      {
        \"role\": \"user\",
        \"content\": \"Reply only OK\"
      }
    ],
    \"stream\": false,
    \"think\": false,
    \"keep_alive\": -1
  }" >/dev/null

echo
echo "========================================"
echo " 🔱 Shiva is ready"
echo "========================================"
echo

pm2 status

echo
echo "Ollama:"
ollama ps

echo
echo "Health:"
curl -s http://127.0.0.1:3000/health
echo

echo
echo "Useful commands:"
echo "  pm2 status"
echo "  pm2 logs shiva-api"
echo "  pm2 logs shiva-device-agent"
echo "  pm2 logs shiva-google-agent"
echo "  pm2 logs shiva-asr"
echo "  pm2 logs shiva-tts"
echo "  pm2 monit"
echo
