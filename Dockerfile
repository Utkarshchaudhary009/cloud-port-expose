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

# The system trust store: the agent dials `wss://...` relays, so Bun must be
# able to validate real CA-signed certs. `debian:bookworm-slim` ships without
# it, which otherwise surfaces as an opaque connection error (§8 fail-loud).
# Base image is digest-pinned, so the apt-visible packages come from the Debian
# snapshot baked into that digest rather than drifting upstream.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Non-root user with a stable UID/GID.
RUN groupadd --system --gid 10001 cloud-expose \
    && useradd --system --uid 10001 --gid 10001 --home-dir /app --shell /usr/sbin/nologin cloud-expose

COPY --from=builder /build/cloud-expose /usr/local/bin/cloud-expose
RUN chmod 0555 /usr/local/bin/cloud-expose

USER cloud-expose

# No EXPOSE directives by design — outbound-only connectivity; the agent never
# accepts inbound connections and never requires port forwarding.

ENTRYPOINT ["cloud-expose"]
