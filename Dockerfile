FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV NVM_DIR=/home/ubuntu/.nvm

RUN apt-get update && apt-get install -y \
    curl htop \
    git \
    build-essential \
    ca-certificates \
    sudo \
    vim \
    byobu \
    supervisor \
    openssh-client \
    unzip \
    python3 python3-venv \
    openjdk-21-jdk  \
    && rm -rf /var/lib/apt/lists/*

RUN curl -Lo /tmp/gradle.zip https://services.gradle.org/distributions/gradle-8.14.5-bin.zip \
    && mkdir -p /opt/gradle \
    && unzip /tmp/gradle.zip -d /opt/gradle \
    && rm /tmp/gradle.zip \
    && ln -s /opt/gradle/gradle-8.14.5/bin/gradle /usr/local/bin/gradle

RUN curl -Lo /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 \
    && chmod +x /usr/local/bin/ttyd

RUN echo "ubuntu ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

USER ubuntu

RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash \
    && . "$NVM_DIR/nvm.sh" \
    && nvm install 24 \
    && nvm alias default 24 \
    && nvm use default \
    && npm install -g pnpm @anthropic-ai/claude-code

# Symlink nvm-managed binaries into /usr/local/bin so supervisord (no .bashrc) can find them
USER root
RUN . "$NVM_DIR/nvm.sh" \
    && ln -s "$(which node)" /usr/local/bin/node \
    && ln -s "$(which npm)"  /usr/local/bin/npm \
    && ln -s "$(which npx)"  /usr/local/bin/npx \
    && ln -s "$(which pnpm)" /usr/local/bin/pnpm

USER ubuntu
WORKDIR /home/ubuntu/api
COPY --chown=ubuntu:ubuntu api/package.json ./
RUN npm install --omit=dev
COPY --chown=ubuntu:ubuntu api/ ./

RUN mkdir -p /home/ubuntu/workspace /home/ubuntu/.claude-sessions \
    && echo '[]' > /home/ubuntu/.claude-sessions/state.json

# Pre-configure byobu to use tmux-style keybindings (ctrl+b) so the first-run
# "screen or tmux?" prompt never appears on pod restart.
RUN mkdir -p /home/ubuntu/.byobu \
    && ln -sf /usr/share/byobu/keybindings/tmux-screen-keys.conf

RUN git config --global user.name "Edouard Kieffer" \
    && git config --global user.email "edkief@users.noreply.github.com"

# On login, attach to the byobu session named in ~/.claude-session if written within the last 10s
RUN printf '%s\n' \
    'if [ -f "$HOME/.claude-session" ]; then' \
    '  _age=$(( $(date +%s) - $(date -r "$HOME/.claude-session" +%s) ))' \
    '  if [ "$_age" -le 10 ]; then' \
    '    _target=$(node -e "process.stdout.write(JSON.parse(require(\"fs\").readFileSync(process.env.HOME+\"/.claude-session\",\"utf8\")).byobuSession)")' \
    '    rm -f "$HOME/.claude-session"' \
    '    exec byobu attach-session -t "$_target"' \
    '  fi' \
    '  rm -f "$HOME/.claude-session"' \
    'fi' \
    >> /home/ubuntu/.bash_profile

USER root
COPY supervisord.conf /etc/supervisor/conf.d/workstation.conf
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER ubuntu
WORKDIR /home/ubuntu/workspace

EXPOSE 7681 3000

CMD ["/usr/local/bin/entrypoint.sh"]
