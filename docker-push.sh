#!/usr/bin/env bash
# Build and push the dashboard and/or workspace images.
#
#   ./docker-push.sh                 both images
#   ./docker-push.sh dashboard       one
#   ./docker-push.sh --rollout       both, then restart the dashboard
#
# CI builds come from .k8s-build.yaml (Tekton); this script is for local and
# out-of-band builds. Both produce <registry>/<repo>/<name> and both tag
# :latest only from the default branch, so they are interchangeable.
#
# `latest` is only tagged on the default branch with a clean tree. The old
# script never pushed :latest at all while the manifests pinned it, so
# `kubectl apply` deployed whatever :latest happened to be rather than the
# build that had just run.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGISTRY="${REGISTRY:-registry.kieffer.me}"
# Mirrors the cluster's Tekton convention (<registry>/<repo>/<name>) so a local
# build and a pipeline build produce byte-identical image references. See
# .k8s-build.yaml -- keep the two in sync.
REPO_NAME="${REPO_NAME:-claude-workstation}"
NAMESPACE="${K8S_NAMESPACE:-dev}"
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"

TARGETS=()
ROLLOUT=false
for arg in "$@"; do
    case "$arg" in
        --rollout) ROLLOUT=true ;;
        dashboard|workspace) TARGETS+=("$arg") ;;
        *) echo "usage: $0 [dashboard|workspace] [--rollout]" >&2; exit 2 ;;
    esac
done
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=(dashboard workspace)

GIT_HASH="$(git -C "$ROOT" rev-parse --short HEAD)"
GIT_BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
CLEAN=true
[ -n "$(git -C "$ROOT" status --porcelain)" ] && CLEAN=false

TAG_HASH="git-${GIT_HASH}"
TAG_BRANCH="${GIT_BRANCH//\//-}-${GIT_HASH}"

TAG_LATEST=false
if [ "$GIT_BRANCH" = "$DEFAULT_BRANCH" ] && [ "$CLEAN" = true ]; then
    TAG_LATEST=true
else
    echo "note: not tagging :latest (branch=${GIT_BRANCH}, clean=${CLEAN})"
    echo "      pin the manifest to ${TAG_BRANCH} to deploy this build"
fi

for target in "${TARGETS[@]}"; do
    IMAGE="${REGISTRY}/${REPO_NAME}/${target}"
    echo
    echo "==> building ${IMAGE}"

    args=(-t "${IMAGE}:${TAG_HASH}" -t "${IMAGE}:${TAG_BRANCH}")
    [ "$TAG_LATEST" = true ] && args+=(-t "${IMAGE}:latest")

    # Context is the repo root so both images can COPY shared/claude-config-sync.
    docker build -f "${ROOT}/${target}/Dockerfile" "${args[@]}" "$ROOT"

    docker push "${IMAGE}:${TAG_HASH}"
    docker push "${IMAGE}:${TAG_BRANCH}"
    [ "$TAG_LATEST" = true ] && docker push "${IMAGE}:latest"
done

if [ "$ROLLOUT" = true ]; then
    echo
    echo "==> restarting the dashboard"
    # Only the dashboard: never restart a live workspace out from under an
    # agent. Workspaces pick up a new image on their next create.
    kubectl rollout restart deployment/claude-dashboard -n "$NAMESPACE"
    kubectl rollout status deployment/claude-dashboard -n "$NAMESPACE" --timeout=120s
fi
