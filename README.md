# cloud-port-expose

Securely expose local ports over the internet through an outbound tunnel.

## Status

Early development — the implementation plan in [`docs/plan.md`](docs/plan.md) is the source of
truth. Phases 1–4 are merged: outbound tunnels carry HTTP **and** WebSocket traffic with
heartbeat keepalive, plus workspace-scoped client credentials and optional session-gated
exposures. TLS termination and stable named domains arrive in later phases.

## Quickstart (dev, no auth/TLS yet)

```sh
# terminal 1 — start a relay on :8080
bun -e 'import { startRelay } from "./src/relay/index";
         const relay = await startRelay({ port: 8080 });
         console.log("agent endpoint:", relay.agentUrl);'

# terminal 2 — expose your local app (e.g. dev server on :3000)
bun src/cli/main.ts 3000 --relay ws://127.0.0.1:8080
# ✓ Port 3000 exposed
# http://<slug>.localhost:8080
```

Any process that can reach the relay can now open the printed URL (`*.localhost` resolves to
loopback in browsers; other machines need an `/etc/hosts` entry until real DNS lands in Phase 5).

## Requirements

- [Bun](https://bun.sh) >= 1.4.0

## Development

```sh
bun install
bun run typecheck   # tsc --noEmit
bun test            # unit tests
bun run lint        # biome check
```

## Layout

- `src/protocol/` — tunnel message types and JSON codec (agent ↔ relay wire protocol)
- `src/agent/`, `src/relay/`, `src/cli/` — consumers, implemented in later phases
- `tests/` — unit tests and local TCP/HTTP fixtures
- `docs/lifecycle.md` — connection lifecycle: connect, authenticate, expose, forward, close, reconnect
