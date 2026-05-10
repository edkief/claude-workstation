#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${IMAGE:-registry.kieffer.me/claude-workstation}"
TAG="${TAG:-latest}"

docker build -t "${IMAGE}:${TAG}" "${ROOT}"
docker push "${IMAGE}:${TAG}"
