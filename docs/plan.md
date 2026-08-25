# Cloud Port Expose — Implementation Plan

> **Status:** Implementation in progress — Phases 1–2 done; next up: Phase 3.
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

- [ ] Implement HTTP Upgrade/WebSocket tunneling.
- [ ] Preserve bidirectional message ordering.
- [ ] Support streaming request/response bodies.
- [ ] Handle half-close/disconnect semantics.
- [ ] Signal truncated responses: if the origin dies after headers were forwarded, the tunnel must not present the body as complete.
- [ ] Add heartbeat/keepalive support (application-level ping/pong at 25–30 s; Bun caps socket `idleTimeout` at 255 s).
- [ ] Add reconnect behavior without corrupting a live session.

### Deliverable

The tunnel transparently supports normal HTTP plus persistent WebSocket connections.

### Verification

- [ ] Pass a dedicated WebSocket echo test through the tunnel.
- [ ] Verify bidirectional WebSocket messages in both directions.
- [ ] Verify large/streamed payloads.
- [ ] Verify idle connections survive the configured heartbeat interval.
- [ ] Verify disconnected clients are detected and removed.
- [ ] Verify a reconnect establishes a clean session.

---

# Phase 4 — Authentication & Authorization

**Goal:** Prevent unauthorized users and unauthorized clients from creating or using exposures.

### Tasks

- [ ] Define user/account identity model.
- [ ] Define workspace/exposure identity model.
- [ ] Generate cryptographically random client credentials.
- [ ] Authenticate the outbound client to the relay.
- [ ] Issue short-lived browser/session credentials.
- [ ] Authorize browser access to a specific exposure.
- [ ] Add token rotation/revocation.
- [ ] Ensure secrets never appear in URLs or logs.

### Deliverable

Only authorized clients can create tunnels and only authorized browser sessions can consume them.

### Verification

- [ ] Valid client credential connects successfully.
- [ ] Invalid credential is rejected.
- [ ] Revoked credential is rejected.
- [ ] Browser session without permission cannot access another workspace.
- [ ] Expired browser credential cannot be reused.
- [ ] Logs contain no raw client secrets or session tokens.

---

# Phase 5 — Stable Named Exposures

**Goal:** Give users human-readable, stable endpoints independent of the current container/process instance.

### Tasks

- [ ] Add exposure names/slugs.
- [ ] Implement routing from hostname to exposure ID.
- [ ] Provision the public exposure domain and a wildcard DNS record (`*.expose.<domain>` → relay IP).
- [ ] Automate wildcard TLS issuance/renewal via ACME DNS-01 on the relay (a wildcard cert is required — Let's Encrypt allows only 50 new certs per registered domain per week, so per-subdomain certs exhaust quota).
- [ ] Terminate TLS on the relay's public listener (:443/:80) and route by SNI/Host header.
- [ ] Keep the hostname associated with the logical exposure rather than the process ID.
- [ ] Define behavior when an exposure is offline.
- [ ] Add collision/slug validation.
- [ ] Add expiration/deletion semantics for abandoned exposures.

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

- [ ] Named exposure can be created.
- [ ] A real browser request to `https://<name>.<domain>` reaches the relay over trusted TLS.
- [ ] Stable hostname routes to the correct connected client.
- [ ] Reconnecting a new client preserves the same hostname.
- [ ] Another user cannot claim an existing protected name.
- [ ] Offline exposure returns a controlled error page/status.

---

# Phase 6 — CLI / Agent UX

**Goal:** Make the tunnel usable from a terminal, Docker container, VM, devcontainer, and CI environment — and from AI agents (LLM-driven automation) calling the CLI programmatically.

> **Terminology:** In this phase, "agent" means an AI agent or automated client invoking the CLI — not the tunnel agent process (`src/agent`) that dials the relay. Where ambiguity is possible, say "AI agent" vs "tunnel agent".

### Tasks

- [ ] Implement `cloud-expose` CLI.
- [ ] Implement `cloud-expose login`.
- [ ] Implement `cloud-expose <port>`.
- [ ] Implement named exposure flags.
- [ ] Implement environment-variable configuration for non-interactive environments.
- [ ] Provide concise success/error output.
- [ ] AI-agent-friendly errors: every error exit names the failing check and prints one actionable next step (exact command/env var to fix or proceed).
- [ ] Machine-readable output: every command accepts `--json`, emitting exactly one stable-schema JSON object on stdout (success or failure); human-readable text remains the default mode.
- [ ] Add `--help`, `--version`, and diagnostics.

### Deliverable

A user can expose a port with one command and receive the endpoint immediately. An AI agent can drive the CLI entirely through `--json` and act on structured errors without scraping free text.

### Verification

- [ ] `cloud-expose --help` works.
- [ ] `cloud-expose --version` works.
- [ ] Interactive login works.
- [ ] Non-interactive authentication works with documented environment variables.
- [ ] `cloud-expose 3000` successfully exposes a local HTTP server.
- [ ] `cloud-expose 3773 --name example` produces the expected named endpoint.
- [ ] Every command's `--json` output parses as a single JSON object on both success and failure paths.
- [ ] Each failure path's output contains an actionable next-step suggestion.

---

# Phase 7 — Docker & Development Environment Integration

**Goal:** Make ephemeral containers first-class tunnel clients.

### Tasks

- [ ] Publish an agent Docker image (debian-slim or alpine base; compiled Bun binaries cannot run `FROM scratch`).
- [ ] Document running the agent alongside any application container.
- [ ] Support container-to-host/local-network targeting as required.
- [ ] Ensure the container needs only outbound connectivity.
- [ ] Define secure secret injection for container startup.
- [ ] Add examples for T3, Next.js, Vite, and a generic HTTP server.

### Deliverable

A disposable Docker workspace can expose its own services without manual port forwarding.

### Verification

- [ ] Start the agent in Docker.
- [ ] Expose a service from the container.
- [ ] Reach the service externally through HTTPS.
- [ ] Restart the container and reconnect successfully.
- [ ] Verify no inbound host port is required by the agent.
- [ ] Run a T3 test instance through the tunnel.

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
- [ ] Add failure recovery tests.

### Verification

- [ ] Unauthorized traffic is rejected.
- [ ] Excess connections are throttled/rejected.
- [ ] Dead tunnels are cleaned up automatically.
- [ ] Relay restart behavior is documented and tested.
- [ ] No cross-workspace traffic is possible in tests.
- [ ] Security review finds no known credential leakage path.

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
