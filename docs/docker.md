# Running cloud-expose in Docker

> **Status:** Phase 7 work in progress. This guide describes the intended packaging and the
> patterns below are being exercised end-to-end right now; anything not yet confirmed against a
> live run is marked **unverified**. Do not treat this page as evidence of a completed phase —
> see `docs/plan.md` (Phase 7) for the authoritative checklist.

## Why there is no published agent port, ever

The agent dials **out** to the relay over one WebSocket connection and forwards traffic back
to your origin over that same connection. Nothing listens on the agent itself, so:

- No `ports:` entry is needed for the agent service in any compose file.
- No inbound firewall rule, router configuration, or public IP is required on the host.
- Publishing an agent port would actively violate the security model — don't.

```text
Browser ──> Relay ──<outbound tunnel>── Agent (in a container) ──> origin at 127.0.0.1:<port>
```

## Getting the agent image

Phase 7 packages a debian-slim-based agent image (compiled Bun binaries are glibc-linked and
cannot run from `scratch`). Build the local image from the repository root:

```sh
docker build -t cloud-expose:local .
```

All examples in [`examples/`](../examples/) reference this exact tag. Smoke-test the build:

```sh
docker run --rm cloud-expose:local --version
docker run --rm cloud-expose:local --help
```

## Pattern: agent sidecar sharing the application's network namespace

The current CLI exposes `<port>` on the agent's own loopback interface only
(`127.0.0.1:<port>`; see `DEFAULT_ORIGIN_HOSTNAME` in `src/agent/client.ts`). When the origin
is another container, share its network namespace so loopback is the *same* loopback:

```yaml
services:
  web:
    # your application container — NOT exposed publicly here
    ...

  cloud-expose:
    image: cloud-expose:local
    network_mode: "service:web"     # share `web`'s netns → same loopback
    depends_on: [web]
    restart: unless-stopped
    env_file: .env.cloud-expose     # copy from .env.example; gitignored
    command: ["3000", "--name", "my-app"]
```

Why this shape:

- `network_mode: "service:web"` joins the agent to the app's namespace, so the agent's hard
  `127.0.0.1:<port>` dial lands directly on your app.
- Neither service publishes a port; all traffic enters via the relay.
- With `--name`, the exposure re-binds to the same stable hostname when the container
  reconnects, because names belong to the workspace — not the container ID
  (see `docs/lifecycle.md`, identifier allocation and expose sections).

Netns-sharing caveats (real limitations, stated plainly):

- While the namespace-owner container (`web`) is down, the sidecar's networking is down too.
  Always restart them together (`docker compose restart web cloud-expose`).
- Exposing a service in a **different** container or on the Docker host is supported with
  `--origin-hostname` (e.g. `--origin-hostname app` for a compose-network DNS name, or
  `--origin-hostname host.docker.internal` to reach a host-port-published service). The value
  must be a bare hostname or IP — no scheme, port, or path — and is validated by the CLI
  (`CLOUD_EXPOSE_ORIGIN_HOSTNAME` sets the same thing via the environment).
- On the **Linux Docker engine** (the runtime this guide targets), `host.docker.internal` does
  not resolve by default — that DNS name only works out of the box on Docker Desktop
  (macOS/Windows). To make it work on Linux, add it to the cloud-expose service's hosts:

  ```yaml
  cloud-expose:
    image: cloud-expose:local
    extra_hosts:
      - "host.docker.internal:host-gateway"
    network_mode: "service:web"
    ...
  ```

  Without this, the agent fails the origin dial with `EAI_AGAIN` (DNS resolution error).

## Secret injection: env file, nothing else

Credentials reach the container exclusively through the environment variables the CLI already
reads: `CLOUD_EXPOSE_RELAY` and `CLOUD_EXPOSE_TOKEN`. Every example ships a committed
`.env.example` with placeholders; the real `.env.cloud-expose` is gitignored:

```sh
cp examples/http-server/.env.example examples/http-server/.env.cloud-expose
# edit: relay URL + client credential issued by your relay/control plane
```

Rules enforced across this repo:

| Method                        | Allowed | Why                                                              |
| ----------------------------- | ------- | ---------------------------------------------------------------- |
| Compose `env_file` (gitignored)| ✅      | Runtime-scoped, not baked into images or layers.                 |
| Build args (`ARG`/`ENV`)      | ❌      | Persist in image layers and history — recoverable long-term.     |
| Token in relay URL            | ❌      | URLs leak into logs, shell history, and analytics.               |
| Committed dotfiles             | ❌      | Only `*.example` placeholders belong in git.                     |

For plain `docker run`, pass `-e CLOUD_EXPOSE_TOKEN` (and `-e CLOUD_EXPOSE_RELAY`) directly. The
shipped image does not currently read Docker-secrets files; if you need that, wrap the entrypoint
in your own image rather than relying on the upstream one.

## Verify it yourself (host without inbound ports)

**unverified** — being executed by the Phase 7 end-to-end pass; results land here when done.

1. `docker compose up` one of the examples.
2. `docker ps` — confirm **neither** service has a `PORTS` mapping.
3. Open the printed public URL; confirm the response body matches the in-container origin.
4. `docker compose restart` both services and reload the URL — the `--name`-ed hostname
   should return without operator action.

## What this guide intentionally does not cover

- Public wildcard DNS + trusted TLS — blocked on real infrastructure, tracked in
  `docs/deployment.md`; local verification uses `*.localhost` / self-signed TLS relays.
- Deep T3 integration (auth flows, terminal, Git over the tunnel) — Phase 8. The
  `examples/t3-placeholder` is intentionally a thin stand-in on `:3773`.
