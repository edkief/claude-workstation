#!/bin/bash
# Workspace pod bootstrap.
#
# Runs to completion BEFORE supervisord starts, so the readiness probe (which
# the agent serves) naturally reports "not ready" for the whole clone/sync, and
# `kubectl logs` shows any failure. Each phase writes a stage marker that the
# agent surfaces to the dashboard as human-readable progress text.
set -uo pipefail

STATE_DIR="${WORKSPACE_STATE_DIR:-/home/ubuntu/.workspace-state}"
export WORKSPACE_STATE_DIR="$STATE_DIR"
mkdir -p "$STATE_DIR"

stage() { echo "$1" > "$STATE_DIR/stage"; echo "[entrypoint] stage: $1"; }

# supervisord interpolates %(ENV_*)s and refuses to start if any are unset.
# The dashboard always sets these; defaults keep a manual `docker run` usable.
export WORKSPACE_ID="${WORKSPACE_ID:-local}"
export BRANCH="${BRANCH:-main}"
export BRANCH_SLUG="${BRANCH_SLUG:-$(echo "$BRANCH" | tr -c 'a-zA-Z0-9-' '-')}"
export CLAUDE_SESSION_NAME="${CLAUDE_SESSION_NAME:-$WORKSPACE_ID}"
export TTY_BASE_PATH="${TTY_BASE_PATH:-/tty/$WORKSPACE_ID}"
export GITHUB_TOKEN="${GITHUB_TOKEN:-}"

fail() {
    echo "$1" > "$STATE_DIR/error"
    stage failed
    echo "[entrypoint] FAILED: $1" >&2
    # Stay alive so the dashboard can show logs and the user can open a shell
    # to debug, rather than crash-looping the pod.
    exec sleep infinity
}

stage starting-bootstrap

# ------------------------------------------------------------------ ssh keys
SSH_SECRET_DIR="/run/secrets/github-ssh"
if [ -f "$SSH_SECRET_DIR/id_rsa" ]; then
    mkdir -p /home/ubuntu/.ssh
    cp "$SSH_SECRET_DIR/id_rsa" /home/ubuntu/.ssh/id_rsa
    chmod 600 /home/ubuntu/.ssh/id_rsa
    ssh-keyscan -H github.com >> /home/ubuntu/.ssh/known_hosts 2>/dev/null
fi
if [ -f "$SSH_SECRET_DIR/github_token" ]; then
    GITHUB_TOKEN="$(cat "$SSH_SECRET_DIR/github_token")"
    export GITHUB_TOKEN
fi
export GH_TOKEN="${GITHUB_TOKEN:-}"

export NVM_DIR="/home/ubuntu/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# ----------------------------------------------------- claude config from S3
# The PVC's ~/.claude is per-repo, so a brand-new repo starts with an empty
# config. Pull the shared, curated config (auth, settings, skills, plugins)
# before anything tries to run claude.
stage syncing-config
if [ -n "${S3_ENDPOINT:-}" ]; then
    claude-config-sync pull || echo "[entrypoint] WARN: config pull failed, continuing"
else
    echo "[entrypoint] S3_ENDPOINT unset; skipping config sync"
fi

# ~/.claude.json must live on the PVC so a token refresh survives a restart.
CLAUDE_CONFIG_FILE="/home/ubuntu/.claude.json"
CLAUDE_CONFIG_TARGET="/workspace/_home/claude.json"
mkdir -p /workspace/_home
if [ ! -e "$CLAUDE_CONFIG_TARGET" ]; then
    if [ -f "$CLAUDE_CONFIG_FILE" ] && [ ! -L "$CLAUDE_CONFIG_FILE" ]; then
        mv "$CLAUDE_CONFIG_FILE" "$CLAUDE_CONFIG_TARGET"
    else
        echo '{}' > "$CLAUDE_CONFIG_TARGET"
    fi
fi
if [ ! -L "$CLAUDE_CONFIG_FILE" ]; then
    rm -f "$CLAUDE_CONFIG_FILE"
    ln -s "$CLAUDE_CONFIG_TARGET" "$CLAUDE_CONFIG_FILE"
fi

# ----------------------------------------------------------------- the repo
stage cloning
/home/ubuntu/bootstrap/clone.sh || fail "git clone failed -- see logs"
WORKSPACE_DIR="$(cat "$STATE_DIR/dir")"

node /home/ubuntu/bootstrap/seed-claude-config.js || fail "could not seed claude config"

# ------------------------------------------------------------------ postgres
# PGDATA is on the container layer, not the PVC: every pod start gets a fresh,
# empty scratch database.
export PGDATA="/home/ubuntu/pgdata"
PG_BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
if [ -n "$PG_BIN" ] && [ ! -s "$PGDATA/PG_VERSION" ]; then
    mkdir -p "$PGDATA"
    chmod 700 "$PGDATA"
    echo 'postgres' > /tmp/pgpw
    "$PG_BIN/initdb" -D "$PGDATA" -U postgres \
        --auth-local=trust --auth-host=scram-sha-256 --pwfile=/tmp/pgpw \
        || echo "[entrypoint] WARN: postgres initdb failed"
    rm -f /tmp/pgpw
fi
if [ -s "$PGDATA/PG_VERSION" ]; then
    # /var/run/postgresql is owned by the distro postgres user and cannot be
    # chowned in-container, so the socket dir is pinned to PGDATA.
    echo "unix_socket_directories = '$PGDATA'" > "$PGDATA/postgresql.auto.conf"
fi

# -------------------------------------------------------------- claude code
CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-latest}"
if command -v npm >/dev/null 2>&1; then
    CURRENT_VERSION="$(claude --version 2>/dev/null | awk '{print $1}' || true)"
    if [ "$CLAUDE_CODE_VERSION" = "latest" ] || [ "$CURRENT_VERSION" != "$CLAUDE_CODE_VERSION" ]; then
        npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
            || echo "[entrypoint] WARN: claude-code install failed, keeping ${CURRENT_VERSION:-unknown}"
    fi
fi

if command -v claude >/dev/null 2>&1; then
    claude mcp get playwright >/dev/null 2>&1 \
        || claude mcp add playwright --scope user -- \
             npx -y @playwright/mcp@latest --headless --browser chromium >/dev/null 2>&1 \
        || echo "[entrypoint] WARN: could not register playwright MCP server"
fi

# --------------------------------------------------------- the claude session
# Created here rather than by the API (as the old single-pod design did), so the
# session exists whether or not a browser is attached. ttyd then attaches to it.
stage starting
SESSION_NAME="${CLAUDE_SESSION_NAME:-workspace}"
byobu new-session -d -s claude -c "$WORKSPACE_DIR" 2>/dev/null \
    || echo "[entrypoint] WARN: byobu session already exists"
byobu send-keys -t claude \
    "claude remote --name '${SESSION_NAME}' --spawn=same-dir" Enter

echo "[entrypoint] bootstrap complete; handing off to supervisord"
exec sudo -E /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
