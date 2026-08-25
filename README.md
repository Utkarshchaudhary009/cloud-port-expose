# cloud-port-expose

Securely expose local ports over the internet through an outbound tunnel.

## Status

Early development — the implementation plan in [`docs/plan.md`](docs/plan.md) is the source of
truth. Current phase: **Phase 1 — Repository Foundation & Protocol Skeleton** (protocol types
only; no runtime networking service yet).

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
