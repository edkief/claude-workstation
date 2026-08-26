#!/bin/bash
# Clone or refresh the branch checkout inside the repo's PVC.
#
# Every input arrives as an environment variable and is passed as a separate
# argv element -- no shell string is ever built from user input. The `--` before
# $REPO_URL blocks --upload-pack= style argument injection.
set -euo pipefail

: "${REPO_URL:?REPO_URL is required}"
: "${BRANCH_SLUG:?BRANCH_SLUG is required}"
: "${BRANCH:?BRANCH is required}"
GIT_REF="${GIT_REF:-$BRANCH}"

DIR="/workspace/${BRANCH_SLUG}"

if [ -d "$DIR/.git" ]; then
    # Warm restart: this branch is already checked out on the PVC. Never
    # destroy work here -- resetting is opt-in via FORCE_RESET.
    echo "[clone] reusing existing checkout at $DIR"
    git -C "$DIR" remote set-url origin "$REPO_URL"
    git -C "$DIR" fetch --quiet origin || echo "[clone] WARN: fetch failed, working offline"
    if [ "${FORCE_RESET:-false}" = "true" ]; then
        echo "[clone] FORCE_RESET: hard-resetting to origin/${BRANCH}"
        git -C "$DIR" reset --hard "origin/${BRANCH}"
    fi
else
    echo "[clone] cloning ${REPO_URL} (${GIT_REF}) into $DIR"
    mkdir -p /workspace
    git clone --branch "$GIT_REF" -- "$REPO_URL" "$DIR"
    if [ -n "${NEW_BRANCH:-}" ]; then
        echo "[clone] creating branch ${NEW_BRANCH}"
        git -C "$DIR" checkout -b "$NEW_BRANCH"
    fi
fi

echo "$DIR" > "${WORKSPACE_STATE_DIR:-/home/ubuntu/.workspace-state}/dir"
echo "[clone] ready: $DIR"
