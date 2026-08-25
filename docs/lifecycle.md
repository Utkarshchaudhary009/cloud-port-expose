# Tunnel Connection Lifecycle

This document describes the client (agent) ↔ relay protocol lifecycle for `cloud-port-expose`.
Message types referenced here are defined in `src/protocol/messages.ts`; wire format rules are in
`src/protocol/codec.ts`.

## Wire Format

- The tunnel is a single outbound WebSocket connection from the agent to the relay.
- Each message is one JSON object in one WebSocket text frame: `{"t": "<type>", ...fields}`.
- Binary payloads (HTTP bodies, WebSocket frames) are carried as base64 strings inside JSON.
  Text WebSocket payloads use `"encoding": "utf8"`; binary uses `"encoding": "base64"`.
- HTTP/WebSocket header fields travel as ordered `[name, value]` pair lists, preserving order
  and repeated fields (e.g. multiple `Set-Cookie`).
- Unknown message types, unknown fields (including within `error.context`), wrong field types,
  and control characters (`\r`, `\n`, NUL, other C0 except HTAB, plus DEL) in header names/values
  are rejected at decode time (`ProtocolError`). Forward compatibility is handled by the protocol
  version, not silent leniency.
- Some frame types flow in both directions: `ping`/`pong` (either peer initiates),
  `abort` (either side cancels a stream), and `ws-data`/`ws-close` (bridged WebSockets carry
  payloads and closes both ways). Direction is determined by session state, not by the type.

## Identifier Allocation

| Identifier   | Allocated by | Scope            | Notes                                                        |
| ------------ | ------------ | ---------------- | ------------------------------------------------------------ |
| `sessionId`  | relay        | tunnel session   | New value on every reconnect.                                 |
| `exposureId` | agent        | exposure         | Client-generated UUID; stable across reconnects. Format is enforced by the session layer, not by the codec. |
| `streamId`   | relay        | HTTP exchange    | Monotonic per session.                                        |
| `connId`     | relay        | bridged WebSocket| Monotonic per session.                                        |

A public URL belongs to the logical exposure (`exposureId` / name), never to a session,
process, or container ID.

## 1. Connect

```text
Agent                          Relay
  |-- hello {version} ---------->|
  |<---------- welcome {sessionId} --|
```

- Agent opens the outbound connection first; no inbound ports are ever required.
- If `version` does not match the relay's supported major version, the relay replies with
  `error {code: "protocol-violation"}` and closes.

## 2. Authenticate

```text
  |-- auth {token} -------------->|
  |<---------- auth-ok {workspaceId} |
  |<---------- auth-error {code, message} (on failure)
```

- Credentials are sent only inside this frame — never in URLs, query strings, or logs.
- Failure codes: `invalid-token`, `revoked-token`, `expired-token`, `malformed`.
- All subsequent control messages require successful authentication.
- **Phasing note:** enforcement lands in Phase 4. Until then relays accept unauthenticated
  sessions and agents skip this step entirely.

## 3. Expose

```text
  |-- expose {exposureId, name?} ->|
  |<---------- exposed {exposureId, hostname, url}
```

- A session may hold multiple exposures at once.
- Relay rejects with `error`: `session-conflict` (id/name already bound elsewhere),
  `unknown-exposure` (unexpose of unknown id), `bad-request` (invalid slug).
- `unexpose {exposureId}` → `unexposed {exposureId}` releases the endpoint.

## 4. Forward HTTP (public request → local origin)

```text
Browser --> Relay                         Agent --> Origin server
            |-- req-head {streamId,...} ---->|
            |-- req-body {data,final}* ------>|
            |<---------- res-head {status,...} ---|
            |<---------- res-body {data,final}* --|
```

Rules:

- Body chunks are base64; the sender MUST end every body with exactly one terminal chunk
  (`final: true`, possibly zero-length). A request with no body still gets one empty terminal
  `req-body`.
- Frames for one stream are ordered; independent streams may interleave freely.
- Either side cancels with `abort {streamId, reason}`; both sides then release the stream.
- An agent `abort` sent after its `res-head` signals a truncated origin response: the relay
  answers the public client with `502 upstream-aborted` instead of a short-but-valid body.
- Hop-by-hop headers (`connection`, `keep-alive`, `transfer-encoding`, ...) are stripped by the
  endpoints before framing.

## 5. Bridge WebSocket

```text
Browser --> Relay                         Agent --> Origin server
            |-- ws-open {connId,...} ------->|
            |<---------- ws-data {connId,...} ----|
            |-- ws-data {connId,...} -------->|
            |-- ws-close / <-- ws-close ----->|
```

- The relay terminates each public upgrade (no socket splice in Bun) and re-originates a
  connection to the agent's local server; upgrade metadata travels in `ws-open` headers.
- Message ordering per connection is preserved end-to-end.
- Either side closes with `ws-close {connId, code, reason}`; the other side mirrors it upstream:

```text
  |-- ws-close {connId,...} ------>|   (or the mirror image)
  |<---------- ws-close {connId,...} --|
```

## 6. Heartbeat

- Both peers send `ping {nonce}` every 25–30 s (Bun caps socket `idleTimeout` at 255 s).
- The receiving peer answers `pong {nonce}` immediately.
- Any incoming frame refreshes the peer-liveness clock.
- A peer that sees no traffic for more than 2.5 intervals closes the tunnel as dead
  (`close(4000, "heartbeat timeout")`).

## 7. Close

- Either side closing the WebSocket tears down all streams, bridges, and exposures of that
  session. Public requests to a dead exposure receive a controlled offline error response
  (exact page/status defined with stable named exposures, Phase 5).

## 8. Reconnect

- The agent dials out again and receives a fresh `sessionId` (old state is gone).
- It re-sends `expose` with the same `exposureId`/`name`, so the stable hostname binds back to
  the new session. Until persistent stable naming lands in Phase 5, the relay remembers
  generated slugs per `exposureId` in a bounded in-memory cache (oldest evicted first): a
  reconnecting agent re-binds to its previous hostname while the relay process stays up; a
  restarted relay forgets slugs.
- In-flight streams from the dead session are not recoverable; clients retry at the HTTP layer.
- Retired streams (e.g., timed out at the relay) tolerate late frames from the agent: late
  `res-*` frames for retired streams are dropped instead of killing the session. The relay
  notifies the agent with an `abort` frame when it retires a stream or sees the public client
  disconnect.
