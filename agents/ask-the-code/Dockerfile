# syntax=docker/dockerfile:1.7
#
# ATC Lambda container image (per-agent layer).
#
# Two-stage build:
#
#   Stage 1 ("build"): compile catalogit + agent-runtime + ask-the-code in
#   dependency order using a plain Node 24 image. `--install-links` on
#   downstream installs so `file:..` deps copy into node_modules rather
#   than symlink (symlinks would break the runtime stage's COPY).
#
#   Stage 2 ("runtime"): `FROM` the shared `leanish/agent-runtime-base`
#   image (which already carries the Lambda Node base + `claude` +
#   `codex` CLIs). Adds only this agent's `dist/`, `agent.yaml`, and
#   production `node_modules`. ~17 MB on top of the shared base.
#
# See ATC ADR-0008 § Multi-agent Dockerfile shape for the owning
# decision (base lives in `core/runtime/`, this file is the
# thin per-agent layer).
#
# Build (from the monorepo root):
#
#   # First build the shared base (idempotent — caches after first run).
#   bash core/runtime/scripts/build-base.sh
#
#   # Then build this agent on top (build context = monorepo root).
#   docker build -f agents/ask-the-code/Dockerfile -t atc-lambda:rehearsal .
#
# The npm scripts `npm run lambda:build` (in agents/ask-the-code/) wrap
# both steps in one command.

# ----------------------- Stage 1: build -----------------------------
FROM node:24-bullseye-slim AS build

WORKDIR /src

# Bring in the packages, mirroring the monorepo layout under /src. The
# `file:` deps resolve against these relative paths.
COPY core/catalog-it/package.json core/catalog-it/package.json
COPY core/runtime/package.json core/runtime/package.json
COPY agents/ask-the-code/package.json agents/ask-the-code/package.json
# tsconfig travels with each package.
COPY core/catalog-it/tsconfig*.json core/catalog-it/
COPY core/runtime/tsconfig*.json core/runtime/
COPY agents/ask-the-code/tsconfig*.json agents/ask-the-code/

# Copy source + skills + descriptor BEFORE installing, because
# `--install-links` copies the file:.. dependency contents at install
# time. We need each upstream package to be fully built (dist/
# present) before the downstream package's install can snapshot it.
COPY core/catalog-it/src core/catalog-it/src
COPY core/catalog-it/test core/catalog-it/test
COPY core/runtime/src core/runtime/src
COPY core/runtime/skills core/runtime/skills
COPY core/runtime/test core/runtime/test
COPY agents/ask-the-code/src agents/ask-the-code/src
COPY agents/ask-the-code/skills agents/ask-the-code/skills
COPY agents/ask-the-code/agent.yaml agents/ask-the-code/agent.yaml
COPY agents/ask-the-code/test agents/ask-the-code/test

# Install + build each package in dependency order:
#
#   catalogit       ← no leanish deps
#   agent-runtime   ← depends on catalogit (`file:../catalog-it`)
#   ask-the-code    ← depends on agent-runtime (`file:../../core/runtime`)
#
# `--install-links` is load-bearing on the agent-runtime + ask-the-code
# installs: it forces npm to install `file:..` deps as fully-copied
# node_modules directories instead of symlinks. Symlinks would break
# the runtime stage — `COPY --from=build .../node_modules` would copy
# the symlink, the target wouldn't exist in the runtime image, and
# Node's ESM resolver would throw `Cannot find package '@leanish/runtime'`.
#
# Install-then-build per package is required (not install-all then
# build-all): `--install-links` snapshots file:.. content at install
# time, so upstream must be built before downstream installs.
RUN --mount=type=cache,target=/root/.npm \
    cd /src/core/catalog-it && npm install --no-audit --no-fund && npm run build \
 && cd /src/core/runtime && npm install --no-audit --no-fund --install-links && npm run build \
 && cd /src/agents/ask-the-code && npm install --no-audit --no-fund --install-links && npm run build

# Prune to production-only dependencies inside each package.
RUN cd /src/core/catalog-it && npm prune --omit=dev \
 && cd /src/core/runtime && npm prune --omit=dev --install-links \
 && cd /src/agents/ask-the-code && npm prune --omit=dev --install-links

# ----------------------- Stage 2: runtime ---------------------------
# The shared base carries Lambda Node 24 + the two coding-agent CLIs.
# See `core/runtime/Dockerfile.base`. The `:latest` alias is
# built alongside the versioned tag by `build-base.sh`.
FROM leanish/agent-runtime-base:latest AS runtime

# Copy the built ask-the-code package + its skills + node_modules onto the
# shared base. WORKDIR is already /var/task (set by the base image).
# `skills/` carries the entry-point + agent-specific support skills (per
# ADR-0001); the runtime's bundled `skills/` (inside the installed
# @leanish/runtime) is the fallback for shared support skills.
COPY --from=build /src/agents/ask-the-code/dist         /var/task/dist
COPY --from=build /src/agents/ask-the-code/skills       /var/task/skills
COPY --from=build /src/agents/ask-the-code/agent.yaml   /var/task/agent.yaml
COPY --from=build /src/agents/ask-the-code/node_modules /var/task/node_modules

# Lambda expects the handler as `<jsFilePath>.<exportName>`. The compiled
# handler lives at /var/task/dist/lambda.js and exports `atcLambdaHandler`
# (per agents/ask-the-code/src/lambda.ts).
CMD ["dist/lambda.atcLambdaHandler"]

LABEL leanish.role=agent
LABEL leanish.agent=ask-the-code
