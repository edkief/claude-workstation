#!/bin/bash
# Make the S3-backed Claude skill directory visible to Codex without keeping a
# second copy. Existing Codex-only skills on older PVCs are migrated once.
set -uo pipefail

CLAUDE_SKILLS_DIR="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/skills"
CODEX_SKILLS_DIR="${CODEX_HOME:-${HOME}/.codex}/skills"

mkdir -p "$CLAUDE_SKILLS_DIR" "$(dirname "$CODEX_SKILLS_DIR")"

if [ -L "$CODEX_SKILLS_DIR" ]; then
    if [ "$(readlink "$CODEX_SKILLS_DIR")" = "$CLAUDE_SKILLS_DIR" ]; then
        exit 0
    fi
    echo "[entrypoint] WARN: $CODEX_SKILLS_DIR is already a symlink; leaving it unchanged" >&2
    exit 0
fi

if [ -d "$CODEX_SKILLS_DIR" ]; then
    # Preserve the S3/Claude copy on name collisions while carrying forward
    # skills that were installed directly into Codex on an older workspace.
    cp -a --update=none "$CODEX_SKILLS_DIR/." "$CLAUDE_SKILLS_DIR/" || {
        echo "[entrypoint] WARN: could not migrate existing Codex skills" >&2
        exit 1
    }
    rm -rf -- "$CODEX_SKILLS_DIR"
elif [ -e "$CODEX_SKILLS_DIR" ]; then
    echo "[entrypoint] WARN: $CODEX_SKILLS_DIR exists and is not a directory; leaving it unchanged" >&2
    exit 0
fi

ln -s "$CLAUDE_SKILLS_DIR" "$CODEX_SKILLS_DIR"
