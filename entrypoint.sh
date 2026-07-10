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
fi

exec sudo -E /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
