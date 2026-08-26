#!/usr/bin/env bash

# ============================================================
# SHIVA - Hostinger KVM4 CPU Bootstrap
# ============================================================
# Intended for a fresh Ubuntu/Debian Hostinger KVM VPS.
#
# Installs only what Shiva needs in CPU/API mode:
#   - Git + basic CLI utilities
#   - Node.js latest LTS via NVM
#   - PM2
#   - Python / pip / venv / build tools
#   - PostgreSQL 18 + client + pgvector
#   - Redis 7+ with AOF persistence
#
# Does NOT install:
#   - NVIDIA drivers / CUDA
#   - Ollama
#   - Local Gemma/model weights
#   - Docker / Docker Compose
#
# Expected Shiva layout:
#   /workspace/shiva/
#     backups/
#     config/
#     data/
#     logs/
#     repo/
#     runtime/
#     scripts/
# ============================================================

set -Eeuo pipefail

export DEBIAN_FRONTEND=noninteractive

WORKSPACE="/workspace"
SHIVA_DIR="${WORKSPACE}/shiva"
LOG_DIR="${WORKSPACE}/_bootstrap_logs"

mkdir -p "$LOG_DIR"

TIMESTAMP="$(date '+%Y-%m-%d_%H-%M-%S')"
LOG_FILE="${LOG_DIR}/bootstrap-${TIMESTAMP}.log"
SUMMARY_FILE="${LOG_DIR}/system-summary-${TIMESTAMP}.txt"

exec > >(tee -a "$LOG_FILE") 2>&1

echo
echo "============================================================"
echo " SHIVA HOSTINGER KVM4 CPU BOOTSTRAP"
echo " Started: $(date)"
echo " Log:     $LOG_FILE"
echo "============================================================"
echo

on_error() {
    local exit_code=$?
    local line_no=$1

    echo
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    echo "BOOTSTRAP ERROR"
    echo "Line: $line_no"
    echo "Exit code: $exit_code"
    echo "Log file: $LOG_FILE"
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    echo

    exit "$exit_code"
}

trap 'on_error $LINENO' ERR

# ------------------------------------------------------------
# Root check
# ------------------------------------------------------------

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: Run this script as root."
    echo "Example:"
    echo "  sudo bash bootstrap-hostinger.sh"
    exit 1
fi

# ------------------------------------------------------------
# OS / system info
# ------------------------------------------------------------

echo ">>> SYSTEM INFORMATION"
uname -a || true
cat /etc/os-release || true

echo
echo "CPU:"
lscpu | head -30 || true

echo
echo "Memory:"
free -h || true

echo
echo "Disk:"
df -h || true
echo

if ! command -v apt-get >/dev/null 2>&1; then
    echo "This bootstrap expects Ubuntu/Debian with apt."
    exit 1
fi

# ------------------------------------------------------------
# Base packages
# ------------------------------------------------------------

echo "============================================================"
echo "INSTALLING BASE PACKAGES"
echo "============================================================"

apt-get update

apt-get install -y \
    ca-certificates \
    curl \
    wget \
    git \
    jq \
    rsync \
    unzip \
    zip \
    tar \
    gzip \
    xz-utils \
    gnupg \
    lsb-release \
    build-essential \
    make \
    gcc \
    g++ \
    pkg-config \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    openssh-client \
    tmux \
    htop \
    tree \
    ripgrep \
    nano \
    vim \
    less \
    lsof \
    net-tools \
    iproute2 \
    procps \
    psmisc

echo
echo "Base packages installed."
echo

# ------------------------------------------------------------
# Redis 7+
# ------------------------------------------------------------

echo "============================================================"
echo "INSTALLING REDIS"
echo "============================================================"

REDIS_KEYRING_PATH="/usr/share/keyrings/redis-archive-keyring.gpg"
REDIS_APT_LIST_PATH="/etc/apt/sources.list.d/redis.list"
REDIS_RELEASE_CODENAME="$(lsb_release -cs)"

curl -fsSL https://packages.redis.io/gpg \
    | gpg --dearmor --yes -o "$REDIS_KEYRING_PATH"

chmod 0644 "$REDIS_KEYRING_PATH"

echo "deb [signed-by=${REDIS_KEYRING_PATH}] https://packages.redis.io/deb ${REDIS_RELEASE_CODENAME} main" \
    > "$REDIS_APT_LIST_PATH"

apt-get update
apt-get install -y redis

REDIS_INSTALLED_VERSION="$(
    redis-server --version \
    | sed -n 's/.*v=\([0-9][0-9.]*\).*/\1/p'
)"
REDIS_INSTALLED_MAJOR="${REDIS_INSTALLED_VERSION%%.*}"

if [[ ! "$REDIS_INSTALLED_MAJOR" =~ ^[0-9]+$ ]] || (( REDIS_INSTALLED_MAJOR < 7 )); then
    echo "Redis 7 or newer is required."
    echo "Installed version: ${REDIS_INSTALLED_VERSION:-unknown}"
    exit 1
fi

echo "Redis ${REDIS_INSTALLED_VERSION} installed."

# Shiva agent queues use Redis Streams.
# AOF keeps queued work durable across VM/service restarts.
if [ -f /etc/redis/redis.conf ]; then
    if grep -qE '^appendonly ' /etc/redis/redis.conf; then
        sed -i 's/^appendonly .*/appendonly yes/' /etc/redis/redis.conf
    else
        echo 'appendonly yes' >> /etc/redis/redis.conf
    fi

    if grep -qE '^appendfsync ' /etc/redis/redis.conf; then
        sed -i 's/^appendfsync .*/appendfsync everysec/' /etc/redis/redis.conf
    else
        echo 'appendfsync everysec' >> /etc/redis/redis.conf
    fi
fi

systemctl enable redis-server
systemctl restart redis-server

echo
echo "Redis check:"
redis-cli ping
echo

# ------------------------------------------------------------
# Git
# ------------------------------------------------------------

echo "============================================================"
echo "CONFIGURING GIT"
echo "============================================================"

git config --global init.defaultBranch main
git config --global pull.rebase false

git --version
echo

# ------------------------------------------------------------
# Node.js via NVM
# ------------------------------------------------------------

echo "============================================================"
echo "INSTALLING NODE.JS LTS"
echo "============================================================"

export NVM_DIR="/root/.nvm"

if [ ! -s "${NVM_DIR}/nvm.sh" ]; then
    mkdir -p "$NVM_DIR"

    NVM_VERSION="$(
        curl -fsSL \
        https://api.github.com/repos/nvm-sh/nvm/releases/latest \
        | jq -r '.tag_name'
    )"

    if [ -z "$NVM_VERSION" ] || [ "$NVM_VERSION" = "null" ]; then
        echo "Could not determine latest NVM version."
        exit 1
    fi

    echo "Installing NVM ${NVM_VERSION}"

    curl -fsSL \
        "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" \
        | bash
fi

# shellcheck disable=SC1090
source "${NVM_DIR}/nvm.sh"

nvm install --lts
nvm alias default 'lts/*'
nvm use default

echo "Node:"
node --version

echo "npm:"
npm --version

if command -v corepack >/dev/null 2>&1; then
    corepack enable || true
fi

echo
echo "Installing PM2..."
npm install -g pm2

pm2 --version
echo

# ------------------------------------------------------------
# PostgreSQL 18 + pgvector
# ------------------------------------------------------------

echo "============================================================"
echo "INSTALLING POSTGRESQL 18 + PGVECTOR"
echo "============================================================"

apt-get install -y postgresql-common

# Adds the official PostgreSQL PGDG repository.
# The script may prompt in some environments, so pre-answer yes.
yes "" | /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh || true

apt-get update

apt-get install -y \
    postgresql-18 \
    postgresql-client-18 \
    postgresql-18-pgvector

systemctl enable postgresql
systemctl start postgresql

echo
echo "PostgreSQL:"
psql --version

echo "pg_restore:"
pg_restore --version

echo "PostgreSQL service:"
systemctl --no-pager --full status postgresql | head -20 || true
echo

# ------------------------------------------------------------
# Shiva workspace
# ------------------------------------------------------------

echo "============================================================"
echo "CREATING SHIVA WORKSPACE"
echo "============================================================"

mkdir -p "${SHIVA_DIR}/backups/postgres"
mkdir -p "${SHIVA_DIR}/config"
mkdir -p "${SHIVA_DIR}/data"
mkdir -p "${SHIVA_DIR}/logs"
mkdir -p "${SHIVA_DIR}/repo"
mkdir -p "${SHIVA_DIR}/runtime"
mkdir -p "${SHIVA_DIR}/scripts"

# Some existing Shiva scripts expect NVM here.
ln -sfn /root/.nvm "${SHIVA_DIR}/runtime/nvm"

# PostgreSQL startup scripts may write here as the postgres user.
touch "${SHIVA_DIR}/logs/postgres.log"
chown postgres:postgres "${SHIVA_DIR}/logs/postgres.log"
chmod 664 "${SHIVA_DIR}/logs/postgres.log"

echo "Created:"
echo "  ${SHIVA_DIR}/backups/postgres"
echo "  ${SHIVA_DIR}/config"
echo "  ${SHIVA_DIR}/data"
echo "  ${SHIVA_DIR}/logs"
echo "  ${SHIVA_DIR}/repo"
echo "  ${SHIVA_DIR}/runtime"
echo "  ${SHIVA_DIR}/scripts"
echo

# ------------------------------------------------------------
# Shell settings
# ------------------------------------------------------------

echo "============================================================"
echo "ADDING SHIVA SHELL SETTINGS"
echo "============================================================"

PROFILE_FILE="/root/.bashrc"

if ! grep -q "# SHIVA HOSTINGER" "$PROFILE_FILE" 2>/dev/null; then
cat >> "$PROFILE_FILE" <<'EOF'

# ============================================================
# SHIVA HOSTINGER
# ============================================================

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

alias shiva='cd /workspace/shiva'
alias shiva-repo='cd /workspace/shiva/repo'
alias mem='free -h'
alias disk='df -h'
alias pml='pm2 logs'
alias pms='pm2 status'
alias redis-ping='redis-cli ping'

EOF
fi

# ------------------------------------------------------------
# PM2 startup integration
# ------------------------------------------------------------

echo "============================================================"
echo "CONFIGURING PM2 STARTUP"
echo "============================================================"

# Generates/enables the systemd unit for root's PM2 processes.
# This is safe before apps are added; pm2 save can be run again after deploy.
PM2_STARTUP_CMD="$(pm2 startup systemd -u root --hp /root 2>/dev/null | grep '^sudo ' | tail -1 || true)"

if [ -n "$PM2_STARTUP_CMD" ]; then
    eval "${PM2_STARTUP_CMD#sudo }" || true
fi

pm2 save --force || true
echo

# ------------------------------------------------------------
# System summary
# ------------------------------------------------------------

echo "============================================================"
echo "GENERATING SYSTEM SUMMARY"
echo "============================================================"

{
    echo "============================================================"
    echo "SHIVA HOSTINGER KVM4 CPU SYSTEM SUMMARY"
    echo "Generated: $(date)"
    echo "============================================================"

    echo
    echo "----- OS -----"
    cat /etc/os-release || true

    echo
    echo "----- KERNEL -----"
    uname -a || true

    echo
    echo "----- CPU -----"
    lscpu || true

    echo
    echo "----- MEMORY -----"
    free -h || true

    echo
    echo "----- DISK -----"
    df -h || true

    echo
    echo "----- GIT -----"
    git --version || true

    echo
    echo "----- NODE -----"
    node --version || true

    echo
    echo "----- NPM -----"
    npm --version || true

    echo
    echo "----- PM2 -----"
    pm2 --version || true

    echo
    echo "----- PYTHON -----"
    python3 --version || true

    echo
    echo "----- POSTGRESQL -----"
    psql --version || true
    pg_dump --version || true
    pg_restore --version || true

    echo
    echo "----- REDIS -----"
    redis-server --version || true
    redis-cli ping || true

} > "$SUMMARY_FILE"

# ------------------------------------------------------------
# Final checks
# ------------------------------------------------------------

echo
echo "============================================================"
echo "FINAL CHECKS"
echo "============================================================"

printf "%-20s %s\n" "Git"        "$(git --version 2>/dev/null || echo FAIL)"
printf "%-20s %s\n" "Node"       "$(node --version 2>/dev/null || echo FAIL)"
printf "%-20s %s\n" "npm"        "$(npm --version 2>/dev/null || echo FAIL)"
printf "%-20s %s\n" "PM2"        "$(pm2 --version 2>/dev/null || echo FAIL)"
printf "%-20s %s\n" "Python"     "$(python3 --version 2>/dev/null || echo FAIL)"
printf "%-20s %s\n" "PostgreSQL" "$(psql --version 2>/dev/null || echo FAIL)"
printf "%-20s %s\n" "Redis"      "$(redis-server --version 2>/dev/null | head -1 || echo FAIL)"
printf "%-20s %s\n" "Redis Ping" "$(redis-cli ping 2>/dev/null || echo FAIL)"

echo
echo "============================================================"
echo " SHIVA CPU BOOTSTRAP COMPLETE"
echo "============================================================"
echo
echo "Workspace:"
echo "  ${SHIVA_DIR}"
echo
echo "Installation log:"
echo "  ${LOG_FILE}"
echo
echo "System summary:"
echo "  ${SUMMARY_FILE}"
echo
echo "This VM intentionally has:"
echo "  - NO Ollama"
echo "  - NO local Gemma models"
echo "  - NO CUDA / NVIDIA setup"
echo "  - NO Docker"
echo
echo "Next steps:"
echo
echo "  1. Put/clone the Shiva repo into:"
echo "       /workspace/shiva/repo"
echo
echo "  2. Restore/copy:"
echo "       /workspace/shiva/config"
echo "       /workspace/shiva/data"
echo "       /workspace/shiva/scripts"
echo "       /workspace/shiva/backups"
echo
echo "  3. Install repo dependencies:"
echo "       cd /workspace/shiva/repo"
echo "       npm install"
echo
echo "  4. Configure Shiva to use your remote AI API provider."
echo
echo "  5. Restore/start PostgreSQL using your Shiva scripts."
echo
echo "  6. Start Shiva with PM2 and then run:"
echo "       pm2 save"
echo
echo "Finished: $(date)"
echo
