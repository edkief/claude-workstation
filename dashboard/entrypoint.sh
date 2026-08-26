#!/bin/bash
# Dashboard bootstrap: pull the shared Claude config, then start supervisord.
set -uo pipefail

mkdir -p /home/node/.claude
chown -R node:node /home/node 2>/dev/null || true

# The config shell edits this working copy; S3 is the distribution artifact.
if [ -n "${S3_ENDPOINT:-}" ]; then
    su node -c 'claude-config-sync pull' || echo "[entrypoint] WARN: config pull failed"
else
    echo "[entrypoint] S3_ENDPOINT unset; skipping config sync"
fi

exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
