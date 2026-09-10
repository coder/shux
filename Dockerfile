# Xum server Docker image
# Multi-stage build with esbuild bundling for minimal runtime image
#
# Build:   docker build -t xum-server .
# Run:     docker run -p 3000:3000 -v ~/.xum:/root/.mux xum-server
#
# /root/.mux remains the container volume target so existing images and compose
# volumes can upgrade and downgrade against the same data.
#
# See docker-compose.yml for easier orchestration

# ==============================================================================
# Stage 1: Build
# ==============================================================================
FROM node:22-slim AS builder

WORKDIR /app

# Optional release tag passed by CI to stamp src/version.ts in Docker builds.
ARG RELEASE_TAG

# Install bun (used for package management and build tooling)
RUN npm install -g bun@1.2

# Install git (needed for version generation) and build tools for native modules
# bzip2 is required for lzma-native to extract its bundled xz source tarball
# Intentionally keep packages unpinned so Debian security updates flow in without manual version churn.
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ bzip2 && rm -rf /var/lib/apt/lists/*

# Copy package files first for better layer caching
COPY package.json bun.lock bunfig.toml ./

# Copy dependency patches referenced by package.json patchedDependencies
# (bun install fails without them).
COPY patches/ patches/

# Copy postinstall script (needed by bun install)
COPY scripts/postinstall.sh scripts/

# Install dependencies and create Makefile sentinel so build targets don't reinstall.
# tsgo typechecks electron-importing sources, so the optional electron package must
# install even though the server image never runs it. Its binary download can fail
# transiently, and bun then silently drops the package instead of failing the install.
# Skip the unused download, and Electron-ABI native rebuilds via XUM_HEADLESS.
# Keep MUX_HEADLESS set for older postinstall tooling in cached dependency layers.
RUN XUM_HEADLESS=1 MUX_HEADLESS=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 bun install --frozen-lockfile && \
    touch node_modules/.installed

# Copy build orchestration files used by Make targets.
COPY Makefile fmt.mk ./

# Copy source files needed for build
COPY src/ src/
COPY tsconfig.json tsconfig.main.json ./
COPY scripts/generate-version.sh scripts/generate-builtin-agents.sh scripts/generate-builtin-skills.sh scripts/
COPY scripts/gen_builtin_skills.ts scripts/gen_workflow_runtime_sources.ts scripts/
COPY docs/ docs/
COPY index.html terminal.html desktop.html vite.config.ts ./
COPY public/ public/
COPY static/ static/

# Remove test files (they import from tests/ which is outside rootDir)
RUN find src -name '*.test.ts' -delete

# Initialize git for version script (uses placeholder if not a real repo)
RUN git init && \
    git config user.email "docker@build" && \
    git config user.name "Docker Build" && \
    git add -A && \
    (git commit -m "docker build" --allow-empty || true)

# Build Docker runtime artifacts through Makefile so local/CI/Docker share one pipeline.
# This runs version generation, builtin content generation, main+renderer builds,
# server bundle creation, worker bundle creation, and runtime artifact assertions.
# Thread RELEASE_TAG through to scripts/generate-version.sh when CI provides it.
RUN RELEASE_TAG="${RELEASE_TAG}" make verify-docker-runtime-artifacts

# ==============================================================================
# Stage 2: Runtime
# ==============================================================================
FROM node:22-slim

# OCI image metadata — allows registries (GHCR, Docker Hub) to link the image
# back to the source repository and display version/description.
ARG VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/coder/mux"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.description="Xum server — parallel AI agent workflows"
LABEL org.opencontainers.image.licenses="AGPL-3.0"

WORKDIR /app

# Install runtime dependencies
# - git: required for workspace operations (clone, worktree, etc.)
# - openssh-client: required for SSH runtime support
# - ca-certificates: required for HTTPS (git clone, API calls, etc.)
# Intentionally keep packages unpinned so Debian security updates flow in without manual version churn.
# hadolint ignore=DL3008
RUN apt-get update && \
    apt-get install -y --no-install-recommends git openssh-client ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Copy runtime dependencies first so app-code changes don't invalidate these layers.
# - @lydell/node-pty: native module for terminal support
# - ssh2 + deps: externalized to avoid .node addon bundling issues
COPY --from=builder /app/node_modules/@lydell ./node_modules/@lydell
COPY --from=builder /app/node_modules/ssh2 ./node_modules/ssh2
COPY --from=builder /app/node_modules/asn1 ./node_modules/asn1
COPY --from=builder /app/node_modules/safer-buffer ./node_modules/safer-buffer
COPY --from=builder /app/node_modules/bcrypt-pbkdf ./node_modules/bcrypt-pbkdf
COPY --from=builder /app/node_modules/tweetnacl ./node_modules/tweetnacl
# - sharp + runtime deps: externalized for attach_file raster resizing in bundled server mode
COPY --from=builder /app/node_modules/sharp ./node_modules/sharp
COPY --from=builder /app/node_modules/@img ./node_modules/@img
COPY --from=builder /app/node_modules/detect-libc ./node_modules/detect-libc
COPY --from=builder /app/node_modules/semver ./node_modules/semver

# Copy frontend/static assets from least to most volatile for better cache reuse.
# Vite outputs JS/CSS/HTML directly to dist/ (assetsDir: ".").
COPY --from=builder /app/dist/static ./dist/static
COPY --from=builder /app/dist/*.html ./dist/
COPY --from=builder /app/dist/*.css ./dist/
COPY --from=builder /app/dist/*.js ./dist/

# Copy TypeScript lib files used by the bundled PTC validator at server startup.
COPY --from=builder /app/dist/typescript-lib ./dist/typescript-lib

# Copy runtime bundles last (most volatile layer during backend iteration).
COPY --from=builder /app/dist/runtime ./dist/runtime

# Keep the established container data path for existing volumes and downgraded images.
RUN mkdir -p /root/.mux

# XUM_ROOT is canonical; MUX_ROOT keeps older image entry points on the same volume.
ENV NODE_ENV=production
ENV XUM_ROOT=/root/.mux
ENV MUX_ROOT=/root/.mux

# Expose server port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Run bundled xum server
# --host 0.0.0.0: bind to all interfaces (required for Docker networking)
# --port 3000: default port (can be remapped via docker run -p)
ENTRYPOINT ["node", "dist/runtime/server-bundle.js"]
CMD ["--host", "0.0.0.0", "--port", "3000"]
