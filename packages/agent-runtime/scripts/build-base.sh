#!/usr/bin/env bash
# Build the shared `leanish/agent-runtime-base` image. Per-agent
# Dockerfiles `FROM` this image; see `agent-runtime/Dockerfile.base` for
# what's bundled and ATC ADR-0008 for the multi-agent shape rationale.
#
# Run from anywhere — the script resolves its paths relative to its own
# location so it works whether you invoke it from the aggregation root,
# from agent-runtime/, or from any agent package.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="$(dirname "$SCRIPT_DIR")"

# CLI versions — bump these when upgrading. The Dockerfile.base defaults
# match these values; we pass them explicitly so the canonical tag
# embeds the actual version pins.
CLAUDE_VERSION="${CLAUDE_VERSION:-2.1.150}"
CODEX_VERSION="${CODEX_VERSION:-0.133.0}"
NODE_MAJOR="${NODE_MAJOR:-24}"

# Tag scheme: leanish/agent-runtime-base:<node-major>-cc<claude>-codex<codex>
# Plus a `:latest` alias so per-agent Dockerfiles can default to it
# while phase-1+ work pins to the versioned tag.
VERSIONED_TAG="leanish/agent-runtime-base:${NODE_MAJOR}-cc${CLAUDE_VERSION}-codex${CODEX_VERSION}"
LATEST_TAG="leanish/agent-runtime-base:latest"

echo "Building $VERSIONED_TAG"
echo "  + alias $LATEST_TAG"

docker build \
  -f "${RUNTIME_DIR}/Dockerfile.base" \
  --build-arg "CLAUDE_VERSION=${CLAUDE_VERSION}" \
  --build-arg "CODEX_VERSION=${CODEX_VERSION}" \
  -t "$VERSIONED_TAG" \
  -t "$LATEST_TAG" \
  "$RUNTIME_DIR"

echo "✔ Built $VERSIONED_TAG (+ :latest alias)"
docker image inspect "$LATEST_TAG" --format 'Image size: {{.Size}} bytes' \
  | awk '{ printf "  %s (%.0f MB)\n", $0, $3 / 1024 / 1024 }'
