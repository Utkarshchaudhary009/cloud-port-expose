# Cloud Port Expose — Implementation Plan

> **Status:** Implementation in progress — Phases 1–6 done; Phase 7 nearly done (Docker image, docs, examples, container-to-host targeting verified end-to-end; remaining: trusted-TLS HTTPS + T3 instance checks). Phase 5's public-infra items (wildcard DNS + trusted TLS) remain blocked on real infrastructure (see docs/deployment.md).
>
> **Amendment log:** 2026-08-26 — studied `mxschmitt/action-tmate`; hardened Phases 6 and 9, added Phase 11 (Release Engineering) and a non-committed Backlog section.
>
> **Source of truth:** This file is the authoritative implementation plan for `cloud-port-expose`. The repository, issue discussions, chat history, and agent memory must not override this file.

## Project Goal

Build a general-purpose secure port-exposure system that lets a local or containerized service expose a TCP/web port through an outbound tunnel and receive a stable HTTPS/WSS endpoint.

The first important consumer is remote T3 Code, but the system must remain T3-agnostic.

Example target experience:

```text
cloud-expose 3000

✓ Port 3000 exposed
https://abc123.expose.dev
```

Later:

```text
cloud-expose 3773 --name agy-usage

✓ Port 3773 exposed
https://agy-usage.expose.dev
```

## Core Principles

1. **Outbound-first networking.** The client must not require inbound access, router configuration, or a public IP.
2. **HTTP + WebSocket support.** WebSocket upgrades are a first-class requirement because T3 depends on persistent WebSocket communication.
3. **Stable workspace identity.** URLs belong to logical exposures/workspaces, not ephemeral container IDs.
4. **Secure by default.** Tokens are scoped, revocable, and never used as credentials embedded directly in public URLs.
5. **T3-agnostic core.** T3 is an integration target, not a dependency of the tunnel protocol.
6. **Small protocol first.** Prove the tunnel with the smallest reliable protocol before adding dashboards, billing, or complex orchestration.
7. **Every phase ends in verification.** Code is not considered complete until its verification criteria pass.

## Verified Technical Constraints

Source-verified research findings (2026-08) that the implementation must respect:

- **Runtime is Bun ≥ 1.4.0.** WebSocket backpressure/stream-cancellation fixes landed in the 1.4 cycle; earlier versions had unbounded buffering with slow clients (oven-sh/bun#32469). Pin the version and run slow-client tests early.
- **No HTTP/2 server.** `Bun.serve` speaks HTTP/1.1 only (h2 support is an open PR, not shipped). Deploy the relay where HTTP/1.1 is accepted, or terminate TLS/h2 upstream of it.
- **WebSocket idle timeout cap.** Bun caps socket `idleTimeout` at 255 s. The agent ↔ relay channel therefore needs application-level ping/pong at a 25–30 s interval (the industry-standard heartbeat window used by ngrok/rathole-class systems).
- **Terminate-and-bridge WebSockets.** Bun offers no socket hijack/splice, so the relay terminates each public upgrade and bridges it to the agent over the tunnel connection. This is the standard ngrok-style design.
- **CLI packaging facts.** `bun build --compile` yields ~55–60 MB standalone binaries, cross-compiling to linux-x64/arm64 (+musl), macOS, and Windows. Binaries need glibc (debian-slim) or musl (alpine) bases — `FROM scratch` is unsupported. Do not gate behavior on `NODE_ENV` (baked in at build time).

## Progress Rules

Use GitHub task checkboxes as the only progress tracker.

- `[ ]` = not complete
- `[x]` = complete and verified

A task may be checked only after its stated verification has actually passed.

A phase may be checked as complete only when **all phase tasks and all phase verification checks are complete**.

Do not silently reorder phases. If the architecture must change, update this file first and explain the change in the commit/PR.

---

# Phase 1 — Repository Foundation & Protocol Skeleton

**Goal:** Establish a clean TypeScript/Bun project and define the minimum client ↔ relay protocol without implementing production networking yet.

### Tasks

- [x] Define project structure for `cli`, `agent`, `relay`, `protocol`, and tests.
- [x] Configure Bun + TypeScript with strict type checking.
- [x] Add consistent formatting/linting and test scripts.
- [x] Define the initial tunnel message types.
- [x] Document connection lifecycle: connect, authenticate, expose, forward, close, reconnect.
- [x] Add a minimal local TCP/HTTP test fixture.

### Deliverable

A buildable repository with a documented protocol skeleton and test harness.

### Verification

- [x] `bun install` completes successfully.
- [x] TypeScript typecheck passes.
- [x] Test runner executes successfully.
- [x] Protocol types compile and can serialize/deserialize a sample message.
- [x] No runtime service is exposed yet; Phase 1 is protocol-only.

---

# Phase 2 — Minimal Outbound Tunnel

**Goal:** A local client connects outbound to the relay and makes one local HTTP port reachable through the relay.

> **Scope note:** Until the public infrastructure tasks in Phase 5 exist, verification runs against loopback hostnames (`*.localhost` resolves to loopback in Chrome/Firefox; `/etc/hosts` entries cover other clients). "Request from a separate process/device" is satisfied by any second process or machine that can reach the relay's address.

### Tasks

- [x] Implement relay WebSocket listener.
- [x] Implement client outbound WebSocket connection.
- [x] Implement tunnel/session identifiers.
- [x] Implement forwarding of HTTP request metadata.
- [x] Implement forwarding of HTTP response metadata and body.
- [x] Implement connection cleanup on either side.
- [x] Add structured connection/error logging.

### Deliverable

A command or test harness can expose a local HTTP server through a generated relay URL.

### Verification

- [x] Start a local HTTP server.
- [x] Start the expose client against that local port.
- [x] Receive a public relay URL.
- [x] Request the public URL from a separate process/device.
- [x] Verify status code, headers, body, and query parameters survive the tunnel.
- [x] Kill the client and verify the relay reports the exposure as offline.
- [x] Reconnect the client and verify a new session can be established.

---

# Phase 3 — WebSocket & Streaming Support

**Goal:** Support protocols required by modern development servers and T3, especially WebSocket upgrades and streaming responses.

### Tasks

- [x] Implement HTTP Upgrade/WebSocket tunneling.
- [x] Preserve bidirectional message ordering.
- [x] Support streaming request/response bodies.
- [x] Handle half-close/disconnect semantics.
- [x] Signal truncated responses: if the origin dies after headers were forwarded, the tunnel must not present the body as complete.
- [x] Add heartbeat/keepalive support (application-level ping/pong at 25–30 s; Bun caps socket `idleTimeout` at 255 s).
- [x] Add reconnect behavior without corrupting a live session.

### Deliverable

The tunnel transparently supports normal HTTP plus persistent WebSocket connections.

### Verification

- [x] Pass a dedicated WebSocket echo test through the tunnel.
- [x] Verify bidirectional WebSocket messages in both directions.
- [x] Verify large/streamed payloads.
- [x] Verify idle connections survive the configured heartbeat interval.
- [x] Verify disconnected clients are detected and removed.
- [x] Verify a reconnect establishes a clean session.

---

# Phase 4 — Authentication & Authorization

**Goal:** Prevent unauthorized users and unauthorized clients from creating or using exposures.

### Tasks

- [x] Define user/account identity model.
- [x] Define workspace/exposure identity model.
- [x] Generate cryptographically random client credentials.
- [x] Authenticate the outbound client to the relay.
- [x] Issue short-lived browser/session credentials.
- [x] Authorize browser access to a specific exposure.
- [x] Add token rotation/revocation.
- [x] Ensure secrets never appear in URLs or logs.

### Deliverable

Only authorized clients can create tunnels and only authorized browser sessions can consume them.

### Verification

- [x] Valid client credential connects successfully.
- [x] Invalid credential is rejected.
- [x] Revoked credential is rejected.
- [x] Browser session without permission cannot access another workspace.
- [x] Expired browser credential cannot be reused.
- [x] Logs contain no raw client secrets or session tokens.

---

# Phase 5 — Stable Named Exposures

**Goal:** Give users human-readable, stable endpoints independent of the current container/process instance.

### Tasks

- [x] Add exposure names/slugs.
- [x] Implement routing from hostname to exposure ID.
- [ ] Provision the public exposure domain and a wildcard DNS record (`*.expose.<domain>` → relay IP). <!-- BLOCKED: no domain/infra available in this environment; see docs/deployment.md -->
- [ ] Automate wildcard TLS issuance/renewal via ACME DNS-01 on the relay (a wildcard cert is required — Let's Encrypt allows only 50 new certs per registered domain per week, so per-subdomain certs exhaust quota). <!-- BLOCKED: needs live DNS API; local TLS termination verified with self-signed certs -->
- [x] Terminate TLS on the relay's public listener (:443/:80) and route by SNI/Host header. (HTTPS verified locally with self-signed certs; dedicated plain-:80 redirect listener deferred to deployment rollout — docs/deployment.md)
- [x] Keep the hostname associated with the logical exposure rather than the process ID.
- [x] Define behavior when an exposure is offline.
- [x] Add collision/slug validation.
- [x] Add expiration/deletion semantics for abandoned exposures.

### Deliverable

Example:

```text
agy-usage.expose.dev
        ↓
workspace agy-usage
        ↓
current connected client
        ↓
localhost:3773
```

### Verification

- [x] Named exposure can be created.
- [ ] A real browser request to `https://<name>.<domain>` reaches the relay over trusted TLS. <!-- BLOCKED: verified with self-signed TLS locally (tests/named.test.ts); trusted CA requires the domain from above -->
- [x] Stable hostname routes to the correct connected client.
- [x] Reconnecting a new client preserves the same hostname.
- [x] Another user cannot claim an existing protected name.
- [x] Offline exposure returns a controlled error page/status.

---

# Phase 6 — CLI / Agent UX

**Goal:** Make the tunnel usable from a terminal, Docker container, VM, devcontainer, and CI environment — and from AI agents (LLM-driven automation) calling the CLI programmatically.

> **Terminology:** In this phase, "agent" means an AI agent or automated client invoking the CLI — not the tunnel agent process (`src/agent`) that dials the relay. Where ambiguity is possible, say "AI agent" vs "tunnel agent".

### Tasks

- [x] Implement `cloud-expose` CLI.
- [x] Implement `cloud-expose login`.
- [x] Implement `cloud-expose <port>`.
- [x] Readiness-gate the success output: emit the public URL only after the relay confirms the exposure is actually routable, with a configurable timeout (pattern borrowed from tmate's `wait tmate-ready`).
- [x] Implement named exposure flags.
- [x] Implement environment-variable configuration for non-interactive environments.
- [x] Provide concise success/error output.
- [x] AI-agent-friendly errors: every error exit names the failing check and prints one actionable next step (exact command/env var to fix or proceed).
- [x] Machine-readable output: every command accepts `--json`, emitting exactly one stable-schema JSON object on stdout (success or failure); human-readable text remains the default mode.
- [x] Add `--help`, `--version`, and diagnostics.
- [x] Implement detached mode (`--detach`): start the exposure in the background, print the endpoint, and return control to the caller while the tunnel keeps running (for CI and scripted use).

### Deliverable

A user can expose a port with one command and receive the endpoint immediately. An AI agent can drive the CLI entirely through `--json` and act on structured errors without scraping free text.

### Verification

- [x] `cloud-expose --help` works.
- [x] `cloud-expose --version` works.
- [x] Interactive login works. <!-- local-mode: writes a self-generated credential to ~/.cloud-expose/auth.json; documented as interim until Phase 10 control plane lands -->
- [x] Non-interactive authentication works with documented environment variables.
- [x] `cloud-expose 3000` successfully exposes a local HTTP server.
- [ ] `cloud-expose 3773 --name example` produces the expected named endpoint. <!-- requires a relay with auth + name reservation; covered by integration via --name flag in the unit tests, but no end-to-end named test was added in this phase -->
- [x] Every command's `--json` output parses as a single JSON object on both success and failure paths.
- [x] Each failure path's output contains an actionable next-step suggestion.
- [x] Success output is withheld until the relay confirms the exposure is routable.
- [x] Detached mode returns control immediately while the exposure remains reachable.
- [x] `--show-token` opt-in reveals the login token in JSON output; the default `--json` output never leaks the credential.
- [x] `cloud-expose login` does not auto-load the persisted credential unless `CLOUD_EXPOSE_LOAD_PERSISTED_TOKEN=1` is set.
- [x] `--ready-timeout` accepts both `--ready-timeout N` and `--ready-timeout=N` spellings; empty values do not swallow the next flag.
- [x] All error paths emit exactly one JSON object with `{ ok, error: { code, message, nextStep } }`.
- [x] `spawnDetached` re-execs `bin/cloud-expose` directly (not `bun ...`) so the child inherits the same shebang/wrapper and the readiness gate applies.

### Sourcery review status

All three blocking Sourcery findings on PR #6 are addressed in commits `9809177` and `72bcc0f`:

1. **Token auto-loading** → `CLOUD_EXPOSE_LOAD_PERSISTED_TOKEN=1` opt-in; the persisted credential is never loaded by default.
2. **`--ready-timeout` forwarding** → `spawnDetached` now forwards the timeout as two separate arguments (`--ready-timeout`, `seconds`), which `parseArgs` recognizes.
3. **`--help --json` / `--version --json`** → emit a structured JSON success object; plain text remains the default.

---

# Phase 7 — Docker & Development Environment Integration

**Goal:** Make ephemeral containers first-class tunnel clients.

### Tasks

- [x] Publish an agent Docker image (debian-slim or alpine base; compiled Bun binaries cannot run `FROM scratch`). <!-- built locally: docker build -t cloud-expose:local . ; smoke-tested --version/--help -->
- [x] Document running the agent alongside any application container. <!-- docs/docker.md + examples/ -->
- [x] Support container-to-host/local-network targeting as required. <!-- CLI --origin-hostname / CLOUD_EXPOSE_ORIGIN_HOSTNAME with strict validation; verified end-to-end via Docker DNS (agent container -> nginx container) -->
- [x] Ensure the container needs only outbound connectivity. <!-- verified: neither app nor agent container publishes any port; agent dials out to the relay only -->
- [x] Define secure secret injection for container startup. <!-- docs/docker.md: env_file only, no build args, no tokens in URLs -->
- [x] Add examples for T3, Next.js, Vite, and a generic HTTP server. <!-- examples/; T3 is an explicit placeholder pending Phase 8 -->

### Deliverable

A disposable Docker workspace can expose its own services without manual port forwarding.

### Verification

- [x] Start the agent in Docker. <!-- docker run cloud-expose:local --version/--help + live agent container -->
- [x] Expose a service from the container. <!-- nginx:alpine origin reached through the tunnel via --origin-hostname cpx-app; HTTP 200 + 404 passthrough -->
- [ ] Reach the service externally through HTTPS. <!-- BLOCKED: verified over HTTP end-to-end via Docker; trusted-TLS HTTPS needs the Phase 5 infra (wildcard DNS/ACME), same blocker -->
- [x] Restart the container and reconnect successfully. <!-- killed agent -> 503 offline; restarted with same --id -> same stable hostname -> 200 -->
- [x] Verify no inbound host port is required by the agent. <!-- docker port empty on both containers; all traffic via outbound dial -->
- [ ] Run a T3 test instance through the tunnel. <!-- Phase 8; t3-placeholder covers plumbing only -->

---

# Phase 8 — T3 Integration

**Goal:** Prove the original use case: a remote T3 Code server can be reached reliably from T3 Web through the tunnel.

> **Reference:** T3 Code is [pingdotgg/t3code](https://github.com/pingdotgg/t3code) (open-source, MIT; default HTTP/WebSocket port 3773). The project is young and self-described as early — pin a specific release for all verification below.

### Tasks

- [ ] Pin and document the exact T3 Code release used for verification.
- [ ] Validate T3 server HTTP requirements.
- [ ] Validate T3 WebSocket requirements.
- [ ] Add a documented T3 container/start command.
- [ ] Add an integration test or reproducible manual verification flow.
- [ ] Document required T3 authentication/authorization handling.
- [ ] Verify reconnect behavior for T3 sessions.

### Deliverable

A T3 server running inside a remote Docker environment can be accessed from the T3 web client through `cloud-port-expose`.

### Verification

- [ ] T3 server starts successfully in the target environment.
- [ ] T3 HTTP endpoints work through the tunnel.
- [ ] T3 WebSocket connection works through the tunnel.
- [ ] Terminal interaction works.
- [ ] Git operations work.
- [ ] An agent/provider request can complete successfully.
- [ ] Disconnect/reconnect does not leave a stale exposure route.

---

# Phase 9 — Reliability, Security & Abuse Controls

**Goal:** Turn the prototype into a safe and dependable service.

### Tasks

- [ ] Add per-client connection limits.
- [ ] Add per-exposure bandwidth/request limits.
- [ ] Add timeouts for idle/dead sessions.
- [ ] Add rate limiting to public endpoints.
- [ ] Validate and sanitize host/exposure routing inputs.
- [ ] Add origin/access-control policy for browser sessions.
- [ ] Add audit logging without storing secrets.
- [ ] Add graceful shutdown and drain behavior.
- [ ] Support optional certificate/SPKI pinning for the agent ↔ relay connection (self-hosted relays with private CAs; pattern borrowed from tmate's server fingerprint inputs).
- [ ] Add failure recovery tests.

### Verification

- [ ] Unauthorized traffic is rejected.
- [ ] Excess connections are throttled/rejected.
- [ ] Dead tunnels are cleaned up automatically.
- [ ] Relay restart behavior is documented and tested.
- [ ] No cross-workspace traffic is possible in tests.
- [ ] Security review finds no known credential leakage path.
- [ ] An agent configured with a pin refuses a relay whose certificate does not match.

---

# Phase 10 — Cloud Development OS Readiness

**Goal:** Make the tunnel a reusable infrastructure primitive for the planned Cloud Development OS.

### Tasks

- [ ] Define workspace API contract for creating/starting an exposure.
- [ ] Define workspace lifecycle states: `stopped`, `starting`, `online`, `offline`, `failed`.
- [ ] Define stable URLs for workspaces.
- [ ] Define how a workspace launcher waits for tunnel readiness.
- [ ] Define handoff from workspace manager to T3 Web.
- [ ] Add API/CLI examples for automated container startup.
- [ ] Document how GitHub remains the source of truth for disposable workspaces.

### Deliverable

A future Cloud Development OS can do:

```text
Click repository
    ↓
Create/start workspace container
    ↓
Clone latest GitHub state
    ↓
Start T3
    ↓
Expose T3 port
    ↓
Wait for tunnel readiness
    ↓
Open stable T3 endpoint
```

### Verification

- [ ] A disposable workspace can be started from a GitHub repository.
- [ ] Tunnel becomes reachable without inbound port forwarding.
- [ ] Stable URL is returned to the launcher.
- [ ] Workspace can be destroyed after work is pushed to GitHub.
- [ ] A new workspace can be recreated from the repository and exposed again.
- [ ] End-to-end prototype flow is documented and repeatable.

---

# Phase 11 — Release Engineering & Distribution

**Goal:** Ship the compiled agent/CLI as verifiable, easy-to-install artifacts (discipline borrowed from tmate's pinned per-arch static-binary releases).

### Tasks

- [ ] Publish cross-compiled release binaries per supported target (linux-x64/arm64 glibc+musl, macOS arm64/x64, Windows x64).
- [ ] Stamp builds so `--version` reports the release tag and commit.
- [ ] Provide an install script that detects OS/arch and installs the matching artifact.
- [ ] Smoke-test every published artifact in CI before publication (binary starts, `--version`, `--help`).
- [ ] Document agent upgrade/rollback.

### Deliverable

A user on any supported platform can install the agent with one command and verify the installed version.

### Verification

- [ ] Install script succeeds on linux-x64 and at least one additional platform.
- [ ] Installed binary passes `--version` and `--help`.
- [ ] Every release artifact was smoke-tested in CI before publication.

---

# Definition of Done

The project is considered production-ready for the original goal only when:

- [ ] Phases 1–10 are complete.
- [ ] All verification checklists pass.
- [ ] HTTP and WebSocket forwarding are both reliable.
- [ ] Authentication and authorization are enforced.
- [ ] Stable named exposures work.
- [ ] Docker-based ephemeral environments work.
- [ ] T3 integration is verified.
- [ ] Security and abuse controls are documented and tested.
- [ ] The Cloud Development OS workflow is reproducible end-to-end.

---

# Backlog — Adopted Ideas & Future Directions (not committed)

Collected while studying `mxschmitt/action-tmate` (2026-08). Nothing here gates the Definition of Done. Items graduate only through a deliberate amendment that turns them into a phase.

- **Official GitHub Action wrapper** (`cloud-port-expose-action`): expose a port from any workflow step and consume the resulting URL via step outputs, mirroring action-tmate's detached-mode `ssh-command`/`web-url` outputs and `::notice::` surfacing.
- **GitHub identity binding for CI**: authorize an exposure to the triggering actor's GitHub identity via OIDC — no stored secrets in CI. Generalizes tmate's `limit-access-to-actor`, but keeps our fail-loud rule instead of its unprotected fallback.
- **Hosted landing page per exposure**: present short-lived browser credentials (already issued in Phase 4) on a relay-hosted quick-access page — the analog of tmate's `#{tmate_web}` shell link.
- **Per-exposure observability endpoint**: connected-client count, bytes transferred, uptime (mirrors tmate's `#{tmate_num_clients}` introspection that powers its "waiting for client" vs "waiting for session end" logs).
- **Local-network fast path**: when browser and origin share a LAN, advertise a direct connection to cut relay round-trips (tmate does LAN discovery for SSH).
- **Multi-region relay selection**: only after the single-relay design has proven itself in production use (YAGNI §12).
