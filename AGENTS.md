# Cloud Port Expose — Agent Instructions

## 0 · Golden Rules (read this first)

1. **Plan-as-code:** `docs/plan.md` is the single source of truth. Code follows the plan — the plan never silently follows code.
2. **Living document, not carved in stone:** the plan *can* change. But change happens only by editing `docs/plan.md` first, deliberately, before touching code. Nothing else (chat, TODOs, issue threads, agent memory) can authorize a deviation.
3. **Plan-first integration:** every new feature or integration starts as an amendment to `docs/plan.md` (goal → tasks → deliverable → verification criteria), then executes through the normal phase loop.
4. **Checkboxes are earned, not assumed:** `[x]` means "verification actually ran and passed." Never mark progress from reasoning alone.
5. **Ship the smallest viable change:** one phase at a time, with typecheck + tests green (the **gates**) before every commit.

## 1 · How We Work: Structured Vibe Coding

- `docs/plan.md` — *what* to build, in what order, and what counts as proof it works.

## 2 · Source-of-Truth Protocol (`docs/plan.md`)

Before writing any code:

1. Read `docs/plan.md`.
2. Identify the current incomplete phase (first phase with unchecked tasks).
3. Read that phase's goal, tasks, deliverable, and verification criteria.
4. Work only within that phase.

### Amending the plan (allowed — but plan-first)

`docs/plan.md` is our default roadmap: mutable, but only through the front door.

Amend the plan **before implementing** when:

- the architecture materially changes
- a phase needs splitting or reordering
- an important requirement is discovered
- a verification requirement changes
- a planned technology is replaced

Rules for amendments:

- A new integration becomes a new phase (or explicit tasks in an existing phase) written into the plan first.
- Write each amendment so a fresh agent can continue from the plan alone, with zero reliance on chat.
- Keep amendments atomic — do not bundle unrelated direction changes into one edit.

## 3 · The Phase Loop

Every phase runs the same five steps:

```text
Inspect → Implement → Verify → Sync → Commit
```

### 1. Inspect

- Read the entire current phase in `docs/plan.md`.
- Survey the existing repository before changing architecture; prefer existing project patterns over inventing parallel conventions.
- Check whether the work already exists in the plan before adding anything new.

### 2. Implement

- Build exactly the tasks listed for this phase. No speculative later-phase features (see YAGNI, §12).
- Keep the protocol and core abstractions T3-agnostic.
- Favor small, composable modules over one large service.
- Implement the smallest change that solves the task.

### 3. Verify (definition of done)

Code merely existing is **not** completion. A task is complete only when its corresponding verification has actually been run and passed (§4).

### 4. Sync the plan

Only after verified success:

- Flip completed tasks from `- [ ]` to `- [x]`; flip a verification item only if it passed.
- Never mark an entire phase complete while any task or verification item in it remains unchecked.
- The plan must stay synchronized with the actual repository state.

### 5. Commit

Follow the Git Workflow (§5).

## 4 · Verification Standards (evidence over optimism)

Minimum bar before declaring a phase complete:

- Type checker passes.
- Linter/formatter checks pass.
- Relevant automated tests pass.
- Phase-specific verification steps from `docs/plan.md` have been executed.
- Networking changes: a real end-to-end request through the tunnel — unit tests alone do not count.
- WebSocket changes: a real bidirectional WebSocket test.
- Security changes: both an authorized and an unauthorized path tested.

**Blocked-verification rule:** if something cannot run due to environmental limits, do not silently mark it complete. Record the limitation, leave the checkbox unchecked, and report exactly what remains unverified.

## 5 · Git Workflow (gates → review → stack → trunk)

1. Read the files the task needs.
2. Implement the smallest viable change.
3. **Gates:** typecheck + tests green before any commit. Red gates = no commit.
4. Run a local review subagent over the diff; fix everything it flags.
5. Commit + PR. Large sequential work → **stacked PRs** instead: one concern per layer, dependencies point downward, every layer passes the gates alone. Use `gh stack init/add/push/submit`; land via `gh stack merge` (plain `gh pr merge` fails on stacks).
6. After ~10 min, address GitHub bot reviews: fix in the **lowest layer owning the issue**, then `gh stack rebase --upstack` if stacked; re-run gates; commit.
7. Merge to `main` (trunk stays releasable).

Commit discipline — coherent commits tied to a phase or tightly related work; use the commit-pr-writing skill. Format:

```text
phase N: <short description>
```

Documentation-only progress updates may use:

```text
docs: update phase N progress
```

Never commit secrets, tokens, private keys, or local environment files.

## 6 · Architecture Rules

### Generic core, pluggable consumers

The core tunnel must not depend on T3 internals (ports-and-adapters layering):

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

The client/agent dials **out** to the relay. Never require:

- inbound router configuration
- manual firewall port forwarding
- a public IP on the client
- an exposed Docker host port for the agent itself

### Stable endpoint identity

A public URL belongs to a logical exposure/workspace — never to a transient container ID or process ID. A restarted container reconnects to the same logical exposure when authorized.

### HTTP and WebSocket are first-class

No HTTP-only designs. T3 and modern dev tooling require persistent WebSocket connections and streaming behavior.

## 7 · Security Rules (secrets hygiene)

Security is part of correctness.

- Never put long-lived credentials in public URLs.
- Never log raw access tokens, refresh tokens, or client secrets.
- Least privilege: scope credentials to the smallest possible resource.
- Prefer short-lived browser/session credentials.
- Validate workspace/exposure identity before routing traffic.
- Workspace isolation: one workspace can never reach another workspace's tunnel.
- Reject malformed hostnames and routing identifiers.
- Keep secrets out of source control and documentation examples.
- Treat all public traffic as untrusted input.

## 8 · Error Handling (fail loudly, leak nothing)

Do not hide infrastructure failures. Errors must:

- identify the failing subsystem
- contain a safe human-readable explanation
- avoid leaking credentials or internal secrets
- distinguish authentication, routing, connection, and upstream-service failures

CLI surfaces are consumed by humans *and* AI agents, so additionally:

- Every CLI error exit includes an actionable next step — the exact command, flag, or environment variable that fixes or unblocks the failure (e.g., "relay unreachable — pass `--relay ws://host:port` or set `CLOUD_EXPOSE_RELAY`").
- Every command accepts `--json`: exactly one stable-schema JSON object goes to stdout on both success and failure paths, so agents never scrape free text. Human-readable output stays the default.

For the CLI, errors should be concise enough to be useful in a terminal. For the relay, logs should carry enough context to trace a connection without recording secrets.

## 9 · Testing Strategy (test pyramid)

**Unit tests** — protocol serialization, authentication logic, routing decisions, token validation, state transitions, helper utilities.

**Integration tests** — client ↔ relay connections, HTTP forwarding, WebSocket forwarding, reconnect behavior, exposure lifecycle.

**End-to-end tests** — the highest-value check:

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

## 10 · Dependencies and Tooling

Use Bun and TypeScript unless the plan explicitly says otherwise.

Do not add a dependency merely because it is convenient — first consider whether behavior fits the current stack or a small focused package. Keep runtime dependencies separate from dev/test dependencies where the package manager supports it.

## 11 · Documentation Discipline

When behavior changes:

- Update `docs/plan.md` if the implementation plan changed.
- Update relevant user/developer documentation.
- Keep examples executable or clearly label them as pseudocode.
- Never let documentation describe an unimplemented feature as completed.

## 12 · Scope Control (YAGNI — you aren't gonna need it yet)

Do not build these before the plan reaches the relevant phase:

- multi-region relay infrastructure
- billing
- analytics dashboards
- a full SaaS control plane
- Kubernetes orchestration
- complex service discovery
- T3-specific abstractions in the core tunnel

First prove the smallest tunnel that works reliably.

## 13 · Completion Rule

Say a phase is complete only when **all** of these hold:

1. Every task in the phase is `[x]`.
2. Every verification item in the phase is `[x]`.
3. The implementation matches the phase deliverable.
4. The relevant tests/checks actually ran and passed.
5. `docs/plan.md` reflects the verified state.

When uncertain: **leave the checkbox unchecked** and report what remains unverified. An honest "not yet verified" beats an optimistic "done."
