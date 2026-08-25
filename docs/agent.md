# Cloud Port Expose — Agent Instructions

## Project Identity

`cloud-port-expose` is a general-purpose secure port-exposure system. Its first important integration is remote T3 Code, but the core tunnel must remain T3-agnostic.

The project is intended to support local machines, Docker containers, development VMs, devcontainers, CI environments, and eventually the Cloud Development OS.

## Source of Truth

**`docs/plan.md` is the single source of truth.**

Before changing code:

1. Read `docs/plan.md`.
2. Identify the current incomplete phase.
3. Read that phase's goal, tasks, deliverable, and verification criteria.
4. Work only on that phase unless `docs/plan.md` is deliberately updated first.

Do not treat chat history, TODO comments, issue discussions, or agent memory as authoritative over `docs/plan.md`.

## Phase Discipline

Every phase follows this workflow:

### 1. Inspect

- Read the entire current phase in `docs/plan.md`.
- Inspect the existing repository before changing architecture.
- Prefer existing project patterns over inventing parallel conventions.
- Check whether the task already exists in the plan before adding new work.

### 2. Implement

- Implement the tasks listed for the current phase.
- Keep the implementation focused on that phase.
- Do not build speculative later-phase features early.
- Keep the protocol and core abstractions T3-agnostic.
- Favor small, composable modules over a single large service.

### 3. Verify

A task is **not complete** when the code merely exists.

A task is complete only when its corresponding verification has actually passed.

Run the relevant tests, type checks, linting, integration tests, and manual verification described by the phase.

Do not mark a verification checkbox `[x]` based on reasoning alone.

### 4. Update the Plan

After successful verification:

- Change the completed task from `- [ ]` to `- [x]` in `docs/plan.md`.
- Change the corresponding verification item to `[x]` only when it has passed.
- Never mark an entire phase complete while any task or verification item in that phase remains unchecked.

The plan must stay synchronized with the repository state.

### 5. Commit Discipline

Prefer commits that correspond to coherent phases or tightly related work.

Recommended format:

```text
phase N: <short description>
```

Documentation-only progress updates may use:

```text
docs: update phase N progress
```

Do not commit secrets, tokens, private keys, or local environment files.

## Verification Standards

At minimum, before declaring a phase complete:

- Run the project's type checker.
- Run the project's linter/formatter checks.
- Run relevant automated tests.
- Run the phase-specific verification steps from `docs/plan.md`.
- For networking changes, perform a real end-to-end request through the tunnel rather than relying only on unit tests.
- For WebSocket changes, perform a real bidirectional WebSocket test.
- For security changes, test both an authorized and unauthorized path.

If a verification cannot be run because of an environmental limitation, do not silently mark it complete. Record the limitation and keep the checkbox unchecked until the requirement is genuinely verified.

## Architecture Rules

### Keep the tunnel generic

The core tunnel must not depend on T3 internals.

The intended layering is:

```text
CLI / Agent
    ↓
Tunnel Protocol
    ↓
Relay
    ↓
Public HTTP / WebSocket endpoint
```

T3 is a consumer of that layer:

```text
T3 Server :3773
      ↓
cloud-port-expose
      ↓
Relay
      ↓
T3 Web
```

### Outbound-first networking

The client/agent should establish an outbound connection to the relay.

Do not require:

- inbound router configuration
- manual firewall port forwarding
- a public IP on the client
- an exposed Docker host port for the agent itself

### Stable endpoint identity

A public URL belongs to a logical exposure/workspace, not to a transient container ID or process ID.

A restarted container should be able to reconnect to the same logical exposure when authorized.

### HTTP and WebSocket are first-class

Do not design a solution that works only for ordinary HTTP requests. T3 and modern development tooling require persistent WebSocket connections and streaming behavior.

## Security Rules

Security is part of correctness.

- Never put long-lived credentials in public URLs.
- Never log raw access tokens, refresh tokens, or client secrets.
- Scope credentials to the smallest possible resource.
- Use short-lived browser/session credentials where possible.
- Validate the workspace/exposure identity before routing traffic.
- Prevent one workspace from accessing another workspace's tunnel.
- Reject malformed hostnames and routing identifiers.
- Keep secrets out of source control and documentation examples.
- Treat all public traffic as untrusted input.

## Error Handling

Do not hide infrastructure failures.

Errors should:

- identify the failing subsystem
- contain a safe human-readable explanation
- avoid leaking credentials or internal secrets
- distinguish authentication, routing, connection, and upstream-service failures

For the CLI, errors should be concise enough to be useful in a terminal.

For the relay, logs should contain enough context to trace a connection without recording secrets.

## Testing Strategy

Use multiple layers of tests:

### Unit tests

Use them for:

- protocol serialization
- authentication logic
- routing decisions
- token validation
- state transitions
- helper utilities

### Integration tests

Use them for:

- client ↔ relay connections
- HTTP forwarding
- WebSocket forwarding
- reconnect behavior
- exposure lifecycle

### End-to-end tests

The highest-value test is:

```text
start local service
    ↓
start expose agent
    ↓
obtain public URL
    ↓
request public URL
    ↓
verify local service response
```

For the original product goal, also verify:

```text
start T3
    ↓
expose T3 port
    ↓
open T3 Web
    ↓
verify HTTP + WebSocket functionality
```

## Dependencies and Tooling

Use Bun and TypeScript unless the plan is explicitly changed.

Do not add a dependency merely because it is convenient. First consider whether the behavior can be implemented with the current stack or a small focused package.

Keep runtime dependencies separate from development/test dependencies where the package manager supports that distinction.

## Documentation Discipline

When behavior changes:

- Update `docs/plan.md` if the implementation plan changes.
- Update relevant user/developer documentation.
- Keep examples executable or clearly label them as pseudocode.
- Never allow documentation to describe an unimplemented feature as completed.

## Scope Control

Avoid building these before the plan reaches the relevant phase:

- multi-region relay infrastructure
- billing
- analytics dashboards
- a full SaaS control plane
- Kubernetes orchestration
- complex service discovery
- T3-specific abstractions in the core tunnel

First prove the smallest tunnel that works reliably.

## When the Plan Must Change

Update `docs/plan.md` before implementing a change when:

- the architecture materially changes
- a phase needs to be split or reordered
- an important requirement is discovered
- a verification requirement changes
- a planned technology is replaced

The plan should explain the new direction clearly enough that a fresh agent can continue from it without relying on conversation history.

## Completion Rule

Never say a phase is complete unless:

1. Every task in the phase is `[x]`.
2. Every verification item in the phase is `[x]`.
3. The implementation matches the phase deliverable.
4. The relevant tests/checks actually passed.
5. `docs/plan.md` has been updated to reflect the verified state.

When uncertain, **leave the checkbox unchecked** and report what remains unverified.
