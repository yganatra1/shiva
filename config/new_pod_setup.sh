#!/usr/bin/env bash

# ============================================================
# SHIVA - Fresh RunPod Bootstrap
# ============================================================
# Intended for a brand-new Ubuntu/Debian RunPod.
#
# Installs:
#   - Git
#   - curl / wget / jq / rsync
#   - Node.js latest LTS via NVM
#   - npm + Corepack
#   - Python / pip / venv
#   - PostgreSQL client
#   - Docker + Docker Compose
#   - Ollama
#   - tmux / htop / tree / ripgrep / unzip etc.
#
# Does NOT:
#   - clone Shiva repo
#   - download Gemma/model weights
#   - restore PostgreSQL
#   - install NVIDIA drivers/CUDA
#
# All output is logged.
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

# Log stdout + stderr both to terminal and file
exec > >(tee -a "$LOG_FILE") 2>&1

echo
echo "============================================================"
echo " SHIVA RUNPOD BOOTSTRAP"
echo " Started: $(date)"
echo " Log:     $LOG_FILE"
echo "============================================================"
echo

# ------------------------------------------------------------
# Error handler
# ------------------------------------------------------------

on_error() {
    EXIT_CODE=$?
    LINE_NO=$1

    echo
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    echo "BOOTSTRAP ERROR"
    echo "Line: $LINE_NO"
    echo "Exit code: $EXIT_CODE"
    echo "Log file: $LOG_FILE"
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    echo

    exit "$EXIT_CODE"
}

trap 'on_error $LINENO' ERR


# ------------------------------------------------------------
# Make sure we're root
# ------------------------------------------------------------

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: Run this script as root."
    echo
    echo "Example:"
    echo "  sudo bash bootstrap-runpod.sh"
    exit 1
fi


# ------------------------------------------------------------
# OS information
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
echo "GPU:"
if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi || true
else
    echo "No nvidia-smi detected."
    echo "This is OK if this Pod is currently CPU-only."
fi

echo


# ------------------------------------------------------------
# Verify supported distro
# ------------------------------------------------------------

if ! command -v apt-get >/dev/null 2>&1; then
    echo "This bootstrap currently expects Ubuntu/Debian with apt."
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
    software-properties-common \
    build-essential \
    make \
    gcc \
    g++ \
    pkg-config \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    postgresql-client \
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
# Git configuration defaults
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

    echo "Finding latest NVM release..."

    NVM_VERSION="$(
        curl -fsSL \
        https://api.github.com/repos/nvm-sh/nvm/releases/latest \
        | jq -r '.tag_name'
    )"

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

echo
echo "Node:"
node --version

echo "npm:"
npm --version

# Enable Corepack where supported
if command -v corepack >/dev/null 2>&1; then
    corepack enable || true
fi

echo


# ------------------------------------------------------------
# Python verification
# ------------------------------------------------------------

echo "============================================================"
echo "VERIFYING PYTHON"
echo "============================================================"

python3 --version
pip3 --version || true

echo


# ------------------------------------------------------------
# PostgreSQL tools
# ------------------------------------------------------------

echo "============================================================"
echo "VERIFYING POSTGRESQL CLIENT"
echo "============================================================"

psql --version
pg_dump --version
pg_restore --version

echo


# ------------------------------------------------------------
# Docker
# ------------------------------------------------------------

echo "============================================================"
echo "INSTALLING / VERIFYING DOCKER"
echo "============================================================"

if command -v docker >/dev/null 2>&1; then

    echo "Docker is already installed."

else

    echo "Docker not found. Installing official Docker packages..."

    install -m 0755 -d /etc/apt/keyrings

    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        -o /etc/apt/keyrings/docker.asc

    chmod a+r /etc/apt/keyrings/docker.asc

    . /etc/os-release

    ARCH="$(dpkg --print-architecture)"

    if [ "${ID:-}" = "ubuntu" ]; then
        DOCKER_DISTRO="ubuntu"
    elif [ "${ID:-}" = "debian" ]; then
        DOCKER_DISTRO="debian"

        curl -fsSL https://download.docker.com/linux/debian/gpg \
            -o /etc/apt/keyrings/docker.asc
    else
        echo "Unknown distribution: ${ID:-unknown}"
        echo "Skipping automatic Docker installation."
        DOCKER_DISTRO=""
    fi

    if [ -n "$DOCKER_DISTRO" ]; then

        echo \
          "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${DOCKER_DISTRO} \
          ${VERSION_CODENAME} stable" \
          > /etc/apt/sources.list.d/docker.list

        apt-get update

        apt-get install -y \
            docker-ce \
            docker-ce-cli \
            containerd.io \
            docker-buildx-plugin \
            docker-compose-plugin
    fi
fi


echo
echo "Docker version:"
docker --version || true

echo
echo "Docker Compose:"
docker compose version || true


# ------------------------------------------------------------
# Try starting Docker if daemon isn't running
# ------------------------------------------------------------

if command -v docker >/dev/null 2>&1; then

    if docker info >/dev/null 2>&1; then

        echo "Docker daemon is already running."

    else

        echo
        echo "Docker daemon is not currently available."

        if command -v systemctl >/dev/null 2>&1 \
           && [ -d /run/systemd/system ]; then

            echo "Trying systemctl..."

            systemctl enable docker || true
            systemctl start docker || true

        else

            echo "No systemd detected."
            echo "Trying dockerd manually..."

            mkdir -p "$LOG_DIR"

            nohup dockerd \
                > "${LOG_DIR}/dockerd.log" \
                2>&1 &

            sleep 5
        fi

        if docker info >/dev/null 2>&1; then
            echo "Docker daemon started successfully."
        else
            echo
            echo "WARNING:"
            echo "Docker CLI is installed but the daemon could not start."
            echo
            echo "Some RunPod templates do not allow nested Docker."
            echo "If necessary, use a RunPod template with Docker support."
            echo
            echo "Docker log:"
            echo "${LOG_DIR}/dockerd.log"
            echo
        fi
    fi
fi


# ------------------------------------------------------------
# Ollama
# ------------------------------------------------------------

echo
echo "============================================================"
echo "INSTALLING / VERIFYING OLLAMA"
echo "============================================================"

if command -v ollama >/dev/null 2>&1; then

    echo "Ollama already installed."

else

    echo "Installing Ollama..."

    curl -fsSL https://ollama.com/install.sh | sh
fi


echo
echo "Ollama version:"

ollama --version || true


# ------------------------------------------------------------
# Start Ollama
# ------------------------------------------------------------

echo
echo "Starting Ollama if necessary..."

if curl -fsS http://127.0.0.1:11434/api/version \
    >/dev/null 2>&1; then

    echo "Ollama is already running."

else

    if pgrep -f "ollama serve" >/dev/null 2>&1; then

        echo "ollama serve process already exists."

    else

        # Keep Ollama private to the machine by default.
        export OLLAMA_HOST="127.0.0.1:11434"

        nohup ollama serve \
            > "${LOG_DIR}/ollama.log" \
            2>&1 &

        sleep 3
    fi
fi


if curl -fsS http://127.0.0.1:11434/api/version \
    >/dev/null 2>&1; then

    echo "Ollama is responding:"
    curl -fsS http://127.0.0.1:11434/api/version
    echo

else

    echo
    echo "WARNING: Ollama installed but is not responding yet."
    echo "Check:"
    echo "  ${LOG_DIR}/ollama.log"
    echo
fi


# ------------------------------------------------------------
# Shiva workspace structure
# ------------------------------------------------------------

echo
echo "============================================================"
echo "CREATING SHIVA WORKSPACE"
echo "============================================================"

mkdir -p "${SHIVA_DIR}"
mkdir -p "${SHIVA_DIR}/backups/postgres"
mkdir -p "${SHIVA_DIR}/logs"
mkdir -p "${SHIVA_DIR}/scripts"
mkdir -p "${WORKSPACE}/models"

echo "Created:"
echo
echo "  ${SHIVA_DIR}"
echo "  ${SHIVA_DIR}/backups/postgres"
echo "  ${SHIVA_DIR}/logs"
echo "  ${SHIVA_DIR}/scripts"
echo "  ${WORKSPACE}/models"
echo


# ------------------------------------------------------------
# Useful shell aliases
# ------------------------------------------------------------

echo "============================================================"
echo "ADDING USEFUL SHELL SETTINGS"
echo "============================================================"

PROFILE_FILE="/root/.bashrc"

if ! grep -q "# SHIVA RUNPOD" "$PROFILE_FILE" 2>/dev/null; then

cat >> "$PROFILE_FILE" <<'EOF'

# ============================================================
# SHIVA RUNPOD
# ============================================================

export NVM_DIR="$HOME/.nvm"

[ -s "$NVM_DIR/nvm.sh" ] && \
    . "$NVM_DIR/nvm.sh"

export OLLAMA_HOST="127.0.0.1:11434"

alias shiva='cd /workspace/shiva'
alias dps='docker ps'
alias dlogs='docker compose logs -f'
alias gpu='watch -n 1 nvidia-smi'
alias mem='free -h'
alias disk='df -h'

EOF

fi


# ------------------------------------------------------------
# Collect complete system manifest
# ------------------------------------------------------------

echo
echo "============================================================"
echo "GENERATING SYSTEM SUMMARY"
echo "============================================================"

{
    echo "============================================================"
    echo "SHIVA RUNPOD SYSTEM SUMMARY"
    echo "Generated: $(date)"
    echo "============================================================"

    echo
    echo "----- OS -----"
    cat /etc/os-release || true

    echo
    echo "----- Kernel -----"
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
    echo "----- GPU -----"
    nvidia-smi || true

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
    echo "----- PYTHON -----"
    python3 --version || true

    echo
    echo "----- POSTGRES -----"
    psql --version || true
    pg_dump --version || true

    echo
    echo "----- DOCKER -----"
    docker --version || true
    docker compose version || true

    echo
    echo "----- OLLAMA -----"
    ollama --version || true

    echo
    echo "----- INSTALLED PACKAGES -----"
    dpkg-query -W \
        -f='${binary:Package}\t${Version}\n' \
        2>/dev/null \
        | sort || true

} > "$SUMMARY_FILE"


apt install -y postgresql-common

/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh

apt update

apt install -y \
  postgresql-18 \
  postgresql-client-18 \
  postgresql-18-pgvector

mkdir -p /workspace/shiva/runtime
ln -s /root/.nvm /workspace/shiva/runtime/nvm

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
printf "%-20s %s\n" "Python"     "$(python3 --version 2>/dev/null || echo FAIL)"
printf "%-20s %s\n" "PostgreSQL" "$(psql --version 2>/dev/null || echo FAIL)"
printf "%-20s %s\n" "Docker"     "$(docker --version 2>/dev/null || echo NOT_AVAILABLE)"
printf "%-20s %s\n" "Compose"    "$(docker compose version 2>/dev/null || echo NOT_AVAILABLE)"
printf "%-20s %s\n" "Ollama"     "$(ollama --version 2>/dev/null || echo FAIL)"

if command -v nvidia-smi >/dev/null 2>&1; then
    printf "%-20s %s\n" "NVIDIA GPU" "DETECTED"
else
    printf "%-20s %s\n" "NVIDIA GPU" "NOT DETECTED / CPU MODE"
fi


echo
echo "============================================================"
echo " BOOTSTRAP COMPLETE"
echo "============================================================"
echo
echo "Workspace:"
echo "  $SHIVA_DIR"
echo
echo "Full installation log:"
echo "  $LOG_FILE"
echo
echo "System/version summary:"
echo "  $SUMMARY_FILE"
echo
echo "Ollama log:"
echo "  ${LOG_DIR}/ollama.log"
echo
echo "Docker daemon log (if manually started):"
echo "  ${LOG_DIR}/dockerd.log"
echo
echo "Next:"
echo
echo "  cd /workspace"
echo "  git clone YOUR_REPOSITORY_URL shiva"
echo
echo "Then restore:"
echo "  1. .env"
echo "  2. PostgreSQL backup"
echo "  3. any RunPod-only scripts"
echo
echo "DO NOT download Gemma until a GPU is available."
echo
echo "Finished: $(date)"
echo