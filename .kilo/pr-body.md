## Summary

This PR delivers **Phase 6 (CLI / Agent UX)** of `cloud-port-expose` and fixes a
test-helper regression that was leaving Phases 2 and 5 unverified.

### What changed

**1. Test-helper repair (prereq for green gates) — `7ad229c`**

- `tests/helpers/public-client.ts` waited for the raw `Bun.connect` socket's
  `close` callback, but `Bun.serve` keeps HTTP/1.1 connections open after the
  response is sent. Every test that round-tripped through a separate process
  hit the 5 s test timeout (helper killed with SIGTERM, exit 143).
  - Added `Content-Length` / `Transfer-Encoding: chunked` end-of-body
    detection and `socket.shutdown()` on response-complete.
  - Added a hard deadline as a final safety net.
  - Validated the port argument before dialing so filtered tests fail with a
    clear error instead of a `RangeError`.
- `tests/named.test.ts`: the TLS test was using the wildcard hostname in the
  URL, which `fetch` cannot resolve. Switched to connecting to `127.0.0.1` and
  overriding the `Host` header (matching how the HTTP tests already work).
- `tests/tunnel.test.ts`: gave the 504-timeout test 15 s instead of 5 s so the
  agent's prior `/slow` handler can drain on the shared origin.

**2. Phase 6: `cloud-expose` CLI — `cb2e73d` + `6b552ba`**

- `bin/cloud-expose` shebang wrapper → `src/cli/main.ts`.
- `cloud-expose --help` / `--version` / `<port>` / `login`.
- Flags: `--relay`, `--token`, `--name`, `--id`, `--mode`, `--ready-timeout`,
  `--detach`, `--json`, `--verbose`.
- Env vars: `CLOUD_EXPOSE_RELAY`, `CLOUD_EXPOSE_TOKEN`, `CLOUD_EXPOSE_CONFIG`.
- **Readiness gate**: `agent.expose()` resolves only after the relay sends
  `exposed`, wrapped in `withTimeout` for `--ready-timeout`. The public URL is
  never printed unless the relay has actually bound the hostname.
- **`--detach`**: parent re-execs the bin entry with
  `CLOUD_EXPOSE_DETACH_CHILD=1`, reads the child's JSON readiness line,
  unrefs, and returns. The child keeps running and serving traffic.
- **AI-agent-friendly errors**: every error exit prints a human line **and** a
  single `--json` object on stdout with `{ ok: false, error: { code, message,
  nextStep } }`. Every `nextStep` names the exact flag/env var to fix.
- **Machine-readable output**: `--json` emits exactly one stable-schema JSON
  object on stdout on both success and failure paths.
- `import.meta.main` guard so the module is usable both via the bin wrapper
  and via `bun run src/cli/main.ts …` (needed by `--detach`).
- `cloud-expose login` writes a self-generated credential to
  `~/.cloud-expose/auth.json`. This is explicitly documented as a local-mode
  interim — the control-plane flow lands in Phase 10.

### Verification (gates)

- `bun run typecheck` — passes (strict, no errors)
- `bun run lint` — passes (Biome, 2 informational warnings, 0 errors)
- `bun test` — **102 pass, 0 fail** across 8 files
  - +11 new CLI tests in `tests/cli.test.ts` covering: help, version, every
    `--json` failure path (invalid port, missing relay, invalid name, invalid
    mode, dead relay, login w/o relay), login round-trip, end-to-end expose
    + fetch through the tunnel, and `--detach` reachability.

### Plan sync

- `docs/plan.md`: Phase 2 and Phase 5 verification items flipped to
  verified (they were already `[x]` but had been red on disk; this PR makes
  them honest).
- `docs/plan.md`: Phase 6 checkboxes flipped to verified state. Status line
  updated to "Phases 1–6 done; Phase 5 public-infra items remain blocked on
  real infrastructure (see docs/deployment.md); next up: Phase 7."

### Out of scope (unchanged)

- Phase 5 public-infra items (wildcard DNS + trusted TLS via ACME DNS-01)
  remain blocked on a real domain and DNS API. `docs/deployment.md`
  documents the rollout steps; local TLS termination is verified with
  self-signed certs in `tests/named.test.ts`.
- The named-exposure CLI test (`cloud-expose 3773 --name example`) is
  covered by the `--name` flag in the unit tests but was not added as a
  dedicated end-to-end case in this PR. The plan checkbox is honestly
  left unchecked with a note.
- Phases 7–11 are untouched.

### Risk / reviewer notes

- `src/cli/main.ts` is a substantial rewrite; the previous version only
  handled `cloud-expose <port>` inline. The new version supports
  subcommands, env-var fallback, a detached child re-exec path, and a
  JSON-or-human output switch on every code path. The test suite
  exercises each branch.
- The `--detach` implementation re-execs the bin entry rather than
  forking in-process, so the detached child is a real separate process
  and survives the parent exiting. This is the tmate pattern.
- `cloud-expose login` does **not** contact a control plane yet — it
  stores a locally generated credential and tells the user so. The
  Phase 10 control-plane integration is the planned successor.
