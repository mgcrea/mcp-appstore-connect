#!/usr/bin/env bash
# Build the mcp-appstore-connect Docker image, baking in real git commit info via
# build args (the .git dir isn't COPY'd into the build context, so tsdown
# can't resolve it from inside the builder stage).
#
# Modes (BUILDER env var):
#   build  — single-arch local image (default)
#   buildx — multi-arch (linux/amd64,linux/arm64); pass --push to publish.
#
# Extra args after the script name are forwarded to docker, e.g.:
#   scripts/docker-build.sh --push
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION=$(node -p "require('./package.json').version")
GIT_COMMIT=$(git rev-parse --short HEAD)
GIT_COMMIT_DATE=$(git log -1 --format=%cI)
IMAGE="mgcrea/mcp-appstore-connect"

case "${BUILDER:-build}" in
  build)  cmd=(docker build) ;;
  buildx) cmd=(docker buildx build --platform linux/amd64,linux/arm64) ;;
  *) echo "scripts/docker-build.sh: unknown BUILDER=${BUILDER}" >&2; exit 1 ;;
esac

exec "${cmd[@]}" \
  --build-arg "GIT_COMMIT=$GIT_COMMIT" \
  --build-arg "GIT_COMMIT_DATE=$GIT_COMMIT_DATE" \
  -t "$IMAGE:latest" \
  -t "$IMAGE:$VERSION" \
  "$@" \
  .
