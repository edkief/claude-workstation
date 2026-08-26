# Dashboard image: the control plane plus the shared-config shell.
#
# Deliberately much slimmer than the workspace image -- no Postgres, Chromium,
# JDK, Gradle or Rust. It does carry claude + ttyd + rclone, because the config
# terminal runs in this pod (a localhost hop, so it opens instantly rather than
# waiting on a Kubernetes round-trip).
FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/home/node \
    NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git openssh-client unzip \
        byobu tmux supervisor procps less vim-tiny \
    && rm -rf /var/lib/apt/lists/*

# ttyd for the config shell (same pinned build as the workspace image).
RUN curl -fsSL -o /usr/local/bin/ttyd \
        https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 \
    && chmod +x /usr/local/bin/ttyd

# rclone backs claude-config-sync.
RUN curl -fsSL -o /tmp/rclone.zip https://downloads.rclone.org/rclone-current-linux-amd64.zip \
    && unzip -q -j /tmp/rclone.zip '*/rclone' -d /usr/local/bin \
    && chmod +x /usr/local/bin/rclone \
    && rm -f /tmp/rclone.zip

RUN npm install -g @anthropic-ai/claude-code@latest \
    && npm cache clean --force

COPY shared/claude-config-sync/claude-config-sync /usr/local/bin/claude-config-sync
RUN chmod +x /usr/local/bin/claude-config-sync

WORKDIR /app
COPY dashboard/package.json dashboard/package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY dashboard/server.js ./server.js
COPY dashboard/prune-pvcs.js ./prune-pvcs.js
COPY dashboard/lib/ ./lib/
COPY dashboard/public/ ./public/

COPY dashboard/supervisord.conf /etc/supervisor/conf.d/dashboard.conf
COPY dashboard/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /home/node/.claude /var/log/supervisor \
    && chown -R node:node /home/node /app

# Pre-select byobu's backend so its first-run prompt never appears.
USER node
RUN byobu-select-backend tmux && BYOBU_BACKEND=tmux byobu-ctrl-a screen
USER root

# 3000 API + tty proxy (the only port the Service exposes), 7683 config shell.
EXPOSE 3000

CMD ["/usr/local/bin/entrypoint.sh"]
