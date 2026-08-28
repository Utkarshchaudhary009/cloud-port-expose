# cloud-port-expose agent image
#
# Multi-stage build:
#   Stage 1 (builder): oven/bun — runs `bun install --frozen-lockfile` and
#     `bun build --compile` to produce a standalone `cloud-expose` binary.
#   Stage 2 (runtime): debian-slim — compiled Bun binaries are dynamically
#     linked against glibc, so the minimal base MUST match the libc of the
#     compiled output (glibc here). FROM scratch is unsupported.
#
# Security posture:
#   - Runs as non-root user.
#   - No ports published: the agent dials OUT to the relay (outbound-first).
#   - No secrets baked in: CLOUD_EXPOSE_RELAY / CLOUD_EXPOSE_TOKEN and their
#     flag equivalents are supplied at RUNTIME (`docker run -e ...`),
#     never as build args or ENV defaults here.

FROM oven/bun:1@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6 AS builder
WORKDIR /build

# Copy only what `bun install` needs first so lockfile installs cache well.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Compile the standalone agent binary from the bin/ entrypoint.
#
# NOTE: bun build --compile must be given a .ts entrypoint. Compiling the
# extensionless `bin/cloud-expose` shim directly makes Bun treat it as an
# opaque module — it bundles 0 imports (observed "bundle 1 modules") and the
# result is a silent no-op binary (exit 0, no stdout/stderr). Copying the
# shim to `bin/cloud-expose.ts` keeps its relative `../src/cli/main` import
# intact and produces a correct 12-module bundle.
COPY bin bin
COPY src src
COPY tsconfig.json ./
RUN cp bin/cloud-expose bin/cloud-expose.ts \
    && bun build --compile --outfile /build/cloud-expose ./bin/cloud-expose.ts


FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS runtime
WORKDIR /app

# Install `ca-certificates` so the system CA store is available for any tool
# that opts in via `NODE_USE_SYSTEM_CA=1` (Bun's default TLS path uses its own
# bundled Mozilla store, so the image is not strictly required for `wss://`
# relay dials against public CAs — but missing CA store still surfaces as
# opaque errors if a custom CA, a corporate proxy, or a self-hosted relay
# chain is involved). The package is unpinned intentionally: the base image's
# /etc/apt/sources.list still points at the live Debian mirror, so any
# reproducibility guarantee must come from the digest-pinned base, not from
# pinning individual apt packages. For tighter supply-chain control, swap
# `apt-get install` for a vendored tarball or an internal mirror in CI.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Non-root user with a stable UID/GID and a writable home directory.
# `/app` is both the WORKDIR and the home dir: the CLI persists auth tokens
# under ~/.cloud-expose/auth.json, so the user must own the directory or
# `login` crashes with EACCES.
RUN groupadd --system --gid 10001 cloud-expose \
    && useradd --system --uid 10001 --gid 10001 --home-dir /app --shell /usr/sbin/nologin cloud-expose \
    && chown cloud-expose:cloud-expose /app

COPY --from=builder /build/cloud-expose /usr/local/bin/cloud-expose
RUN chmod 0555 /usr/local/bin/cloud-expose

USER cloud-expose

# No EXPOSE directives by design — outbound-only connectivity; the agent never
# accepts inbound connections and never requires port forwarding.

ENTRYPOINT ["cloud-expose"]
