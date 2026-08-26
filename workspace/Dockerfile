FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV NVM_DIR=/home/ubuntu/.nvm
ENV RUSTUP_HOME=/home/ubuntu/.rustup
ENV CARGO_HOME=/home/ubuntu/.cargo
ENV PATH="/home/ubuntu/.cargo/bin:${PATH}"

RUN apt-get update && apt-get install -y \
    curl htop \
    git \
    build-essential \
    pkg-config \
    libssl-dev \
    ca-certificates \
    sudo \
    vim \
    byobu \
    supervisor \
    openssh-client \
    unzip \
    python3 python3-venv \
    openjdk-21-jdk  \
    postgresql postgresql-contrib \
    && rm -rf /var/lib/apt/lists/*

RUN curl -Lo /tmp/gradle.zip https://services.gradle.org/distributions/gradle-8.14.5-bin.zip \
    && mkdir -p /opt/gradle \
    && unzip /tmp/gradle.zip -d /opt/gradle \
    && rm /tmp/gradle.zip \
    && ln -s /opt/gradle/gradle-8.14.5/bin/gradle /usr/local/bin/gradle

RUN curl -Lo /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 \
    && chmod +x /usr/local/bin/ttyd

# GitHub CLI (gh) from the official apt repo
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

RUN echo "ubuntu ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

USER ubuntu

RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.5/install.sh | bash \
    && . "$NVM_DIR/nvm.sh" \
    && nvm install 24 \
    && nvm alias default 24 \
    && nvm use default \
    && npm install -g pnpm @anthropic-ai/claude-code

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable \
    && . "$CARGO_HOME/env" \
    && rustup target add wasm32-unknown-unknown \
    && cargo install wasm-pack

# Symlink nvm-managed binaries into /usr/local/bin so supervisord (no .bashrc)
# and the byobu login shell (which reads .bash_profile, not nvm.sh) can find
# them. `claude` especially: entrypoint.sh types it into the tmux pane, and a
# `claude: command not found` there is invisible until the pod never goes ready.
USER root
RUN . "$NVM_DIR/nvm.sh" \
    && ln -s "$(which node)" /usr/local/bin/node \
    && ln -s "$(which npm)"  /usr/local/bin/npm \
    && ln -s "$(which npx)"  /usr/local/bin/npx \
    && ln -s "$(which pnpm)" /usr/local/bin/pnpm \
    && ln -s "$(which claude)" /usr/local/bin/claude
RUN ln -s /home/ubuntu/.cargo/bin/cargo     /usr/local/bin/cargo \
    && ln -s /home/ubuntu/.cargo/bin/rustc  /usr/local/bin/rustc \
    && ln -s /home/ubuntu/.cargo/bin/rustup /usr/local/bin/rustup \
    && ln -s /home/ubuntu/.cargo/bin/wasm-pack /usr/local/bin/wasm-pack

# Playwright: the CLI/library (as ubuntu) plus the MCP server so Claude can drive
# a browser for testing, and the Chromium browser + its OS deps installed to a
# shared, container-wide path (as root) so every process can find them.
USER ubuntu
RUN . "$NVM_DIR/nvm.sh" \
    && npm install -g playwright @playwright/mcp
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN . "$NVM_DIR/nvm.sh" \
    && apt-get update \
    && playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

USER ubuntu

# Agent + bootstrap scripts. No API server here any more: session management
# lives in the dashboard image, and this pod only runs one workspace.
COPY --chown=ubuntu:ubuntu workspace/agent.js /home/ubuntu/agent/agent.js
COPY --chown=ubuntu:ubuntu workspace/bootstrap/ /home/ubuntu/bootstrap/
RUN chmod +x /home/ubuntu/bootstrap/*.sh

# Bootstrap state (stage markers, checkout path) -- uid-1000 owned, container
# layer only, deliberately not on the PVC.
RUN mkdir -p /home/ubuntu/.workspace-state

# /workspace is the PVC mount point; it needs root to create and uid 1000 to
# use (fsGroup 1000 takes over once the volume is attached).
USER root
RUN mkdir -p /workspace && chown ubuntu:ubuntu /workspace
USER ubuntu

# Pre-select the tmux backend and the ctrl-a escape mode so byobu's first-run
# "Configure Byobu's ctrl-a behavior..." prompt never appears on pod restart.
RUN mkdir -p /home/ubuntu/.byobu \
    && byobu-select-backend tmux \
    && BYOBU_BACKEND=tmux byobu-ctrl-a screen

RUN git config --global user.name "Edouard Kieffer" \
    && git config --global user.email "edkief@users.noreply.github.com"

# A login shell drops the user into the workspace checkout. The old
# ~/.claude-session 10-second-mtime attach hack is gone: ttyd now attaches
# directly to the single named byobu session (see supervisord.conf).
RUN printf '%s\n' \
    'if [ -f "$HOME/.workspace-state/dir" ]; then' \
    '  cd "$(cat "$HOME/.workspace-state/dir")" || true' \
    'fi' \
    >> /home/ubuntu/.bash_profile

USER root

# rclone backs claude-config-sync (single static binary, native S3).
RUN curl -fsSL -o /tmp/rclone.zip https://downloads.rclone.org/rclone-current-linux-amd64.zip \
    && unzip -q -j /tmp/rclone.zip '*/rclone' -d /usr/local/bin \
    && chmod +x /usr/local/bin/rclone \
    && rm -f /tmp/rclone.zip

COPY shared/claude-config-sync/claude-config-sync /usr/local/bin/claude-config-sync
COPY workspace/supervisord.conf /etc/supervisor/conf.d/workstation.conf
COPY workspace/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/claude-config-sync

USER ubuntu
WORKDIR /workspace

# 7681 ttyd (proxied by the dashboard), 7682 agent, 5432 scratch postgres.
EXPOSE 7681 7682 5432

CMD ["/usr/local/bin/entrypoint.sh"]
