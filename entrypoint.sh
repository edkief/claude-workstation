#!/bin/bash
set -euo pipefail

SSH_SECRET_DIR="/run/secrets/github-ssh"
if [ -d "$SSH_SECRET_DIR" ] && [ -f "$SSH_SECRET_DIR/id_rsa" ]; then
    mkdir -p /home/ubuntu/.ssh
    cp "$SSH_SECRET_DIR/id_rsa" /home/ubuntu/.ssh/id_rsa
    chmod 600 /home/ubuntu/.ssh/id_rsa
    ssh-keyscan -H github.com >> /home/ubuntu/.ssh/known_hosts 2>/dev/null
fi

STATE_FILE="/home/ubuntu/.claude-sessions/state.json"
if [ ! -f "$STATE_FILE" ]; then
    mkdir -p "$(dirname "$STATE_FILE")"
    echo '[]' > "$STATE_FILE"
fi


# Read PAT from secret and export so sudo -E carries it into supervisord
SSH_SECRET_DIR="/run/secrets/github-ssh"
if [ -f "$SSH_SECRET_DIR/github_token" ]; then
    export GITHUB_TOKEN="$(cat "$SSH_SECRET_DIR/github_token")"
fi

# POD_NAME is injected by the Downward API but sudo strips it; re-export explicitly
export POD_NAME="${POD_NAME:-unknown}"

# Install/upgrade Claude Code to the requested version on every pod start, so a
# newer CLI can be picked up without rebuilding the image (just bump the env
# var + roll the pod). Falls back to whatever the image already has if this fails.
export NVM_DIR="/home/ubuntu/.nvm"
CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-latest}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh"
    CURRENT_VERSION="$(claude --version 2>/dev/null | awk '{print $1}' || true)"
    if [ "$CLAUDE_CODE_VERSION" = "latest" ] || [ "$CURRENT_VERSION" != "$CLAUDE_CODE_VERSION" ]; then
        npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
            || echo "WARN: claude-code install failed, keeping existing version ${CURRENT_VERSION:-unknown}"
    fi

    # Register the Playwright MCP server so Claude Code can drive a headless
    # Chromium for browser testing. Idempotent: skipped once it exists in the
    # (PVC-backed) user config.
    if command -v claude >/dev/null 2>&1; then
        claude mcp get playwright >/dev/null 2>&1 \
            || claude mcp add playwright --scope user -- \
                 npx -y @playwright/mcp@latest --headless --browser chromium >/dev/null 2>&1 \
            || echo "WARN: could not register playwright MCP server"
    fi
fi

# PostgreSQL: initialize the cluster on container start (postgres/postgres, scram
# password auth over TCP, trust for local socket). PGDATA is in the ephemeral
# layer, so each new pod gets a fresh DB. supervisord then runs it.
export PGDATA="/home/ubuntu/pgdata"
PG_BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
if [ -n "$PG_BIN" ] && [ ! -s "$PGDATA/PG_VERSION" ]; then
    mkdir -p "$PGDATA"
    chmod 700 "$PGDATA"
    echo 'postgres' > /tmp/pgpw
    "$PG_BIN/initdb" -D "$PGDATA" -U postgres \
        --auth-local=trust --auth-host=scram-sha-256 --pwfile=/tmp/pgpw \
        || echo "WARN: postgres initdb failed"
    rm -f /tmp/pgpw
    chown -R ubuntu:ubuntu "$PGDATA"
fi

# /var/run/postgresql is created by postgresql-common owned by the 'postgres'
# user. The server runs as ubuntu, so it can't write the unix-socket lock
# there. Re-own it before supervisord starts postgres.
mkdir -p /var/run/postgresql
chown -R ubuntu:ubuntu /var/run/postgresql

exec sudo -E /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
