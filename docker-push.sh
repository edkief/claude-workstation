#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${IMAGE:-registry.kieffer.me/claude-workstation}"

GIT_HASH="$(git -C "${ROOT}" rev-parse --short HEAD)"
GIT_BRANCH="$(git -C "${ROOT}" rev-parse --abbrev-ref HEAD)"

TAG_HASH="git-${GIT_HASH}"
TAG_BRANCH="${GIT_BRANCH}-${GIT_HASH}"

docker build -t "${IMAGE}:${TAG_HASH}" -t "${IMAGE}:${TAG_BRANCH}" "${ROOT}"
docker push "${IMAGE}:${TAG_HASH}"
docker push "${IMAGE}:${TAG_BRANCH}"
