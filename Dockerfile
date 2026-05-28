# syntax=docker/dockerfile:1.7
#
# ATC Lambda container image (per-agent layer).
#
# Two-stage build:
#
#   Stage 1 ("build"): compile catalogit + agent-runtime + agent-atc in
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
# decision (base lives in `agent-infra/`, this file is the thin
# per-agent layer).
#
# Build (from the agentic-development/ aggregation root):
#
#   # First build the shared base (idempotent — caches after first run).
#   bash agent-infra/scripts/build-base.sh
#
#   # Then build this agent on top.
#   docker build -f agent-atc/Dockerfile -t atc-lambda:rehearsal .
#
# The npm scripts `npm run lambda:build` (in agent-atc/) wrap both
# steps in one command.

# ----------------------- Stage 1: build -----------------------------
FROM node:24-bullseye-slim AS build

WORKDIR /src

# Bring in the three sibling packages. The `file:` deps in
# agent-runtime + agent-atc resolve against these sibling paths.
COPY catalogit/package.json catalogit/package.json
COPY agent-runtime/package.json agent-runtime/package.json
COPY agent-atc/package.json agent-atc/package.json
# tsconfig + npm lockfiles travel with their packages.
COPY catalogit/tsconfig*.json catalogit/
COPY agent-runtime/tsconfig*.json agent-runtime/
COPY agent-atc/tsconfig*.json agent-atc/

# Copy source + skills + descriptor BEFORE installing, because
# `--install-links` copies the file:.. dependency contents at install
# time. We need each upstream package to be fully built (dist/
# present) before the downstream package's install can snapshot it.
COPY catalogit/src catalogit/src
COPY catalogit/test catalogit/test
COPY agent-runtime/src agent-runtime/src
COPY agent-runtime/skills agent-runtime/skills
COPY agent-runtime/test agent-runtime/test
COPY agent-atc/src agent-atc/src
COPY agent-atc/skills agent-atc/skills
COPY agent-atc/agent.yaml agent-atc/agent.yaml
COPY agent-atc/test agent-atc/test

# Install + build each package in dependency order:
#
#   catalogit            ← no leanish deps
#   agent-runtime        ← depends on catalogit (`file:../catalogit`)
#   agent-atc            ← depends on agent-runtime (`file:../agent-runtime`)
#
# `--install-links` is load-bearing on the agent-runtime + agent-atc
# installs: it forces npm to install `file:..` deps as fully-copied
# node_modules directories instead of symlinks. Symlinks would break
# the runtime stage — `COPY --from=build .../agent-atc/node_modules`
# would copy the symlink, the symlink target wouldn't exist in the
# runtime image, and Node's ESM resolver would throw
# `Cannot find package '@leanish/agent-runtime'`.
#
# Install-then-build per package is required (not install-all then
# build-all): `--install-links` snapshots file:.. content at install
# time, so upstream must be built before downstream installs.
RUN --mount=type=cache,target=/root/.npm \
    cd /src/catalogit && npm install --no-audit --no-fund && npm run build \
 && cd /src/agent-runtime && npm install --no-audit --no-fund --install-links && npm run build \
 && cd /src/agent-atc && npm install --no-audit --no-fund --install-links && npm run build

# Prune to production-only dependencies inside each package.
RUN cd /src/catalogit && npm prune --omit=dev \
 && cd /src/agent-runtime && npm prune --omit=dev --install-links \
 && cd /src/agent-atc && npm prune --omit=dev --install-links

# ----------------------- Stage 2: runtime ---------------------------
# The shared base carries Lambda Node 24 + the two coding-agent CLIs.
# See `agent-infra/Dockerfile.base`. The `:latest` alias is built
# alongside the versioned tag by `agent-infra/scripts/build-base.sh`.
FROM leanish/agent-runtime-base:latest AS runtime

# Copy the built agent-atc package + its skills + node_modules onto the
# shared base. WORKDIR is already /var/task (set by the base image).
# `skills/` carries agent-atc's entry-point + agent-specific support
# skills (per ADR-0001); the runtime's bundled `skills/` (already
# inside the FROM-image's installed @leanish/agent-runtime) is the
# fallback for shared support skills.
COPY --from=build /src/agent-atc/dist         /var/task/dist
COPY --from=build /src/agent-atc/skills       /var/task/skills
COPY --from=build /src/agent-atc/agent.yaml   /var/task/agent.yaml
COPY --from=build /src/agent-atc/node_modules /var/task/node_modules

# Lambda expects the handler as `<jsFilePath>.<exportName>`. The compiled
# handler lives at /var/task/dist/lambda.js and exports `atcLambdaHandler`
# (per agent-atc/src/lambda.ts).
CMD ["dist/lambda.atcLambdaHandler"]

LABEL leanish.role=agent
LABEL leanish.agent=atc
