# Examples

Runnable Docker setups that expose an in-container service through `cloud-port-expose`.
Each follows one convention:

- **app + agent sidecar**: a `web`/origin service and a `cloud-expose` service sharing the
  app's **network namespace** (`network_mode: "service:<app>"`) so the agent's dial to
  `127.0.0.1:<port>` reaches the origin. Rationale in [`docs/docker.md`](../docs/docker.md).
- **no published ports**: no `ports:` entries anywhere; all traffic enters via the relay over
  the agent's outbound tunnel.
- **credentials via env_file**: each dir ships `.env.example` (committed, placeholders only).
  Copy it to `.env.cloud-expose`, fill it in — the real file is gitignored.

| Directory         | Origin                          | Port | Notes                                   |
| ----------------- | ------------------------------- | ---- | --------------------------------------- |
| `http-server/`    | Plain `node:http` demo          | 3000 | Simplest end-to-end check               |
| `nextjs/`         | Next.js dev server              | 3000 | Replace with your own project as needed |
| `vite/`           | Vite dev server                 | 5173 | Replace with your own project as needed |
| `t3-placeholder/` | Stand-in JSON server            | 3773 | Minimal plumbing test; real T3 = Phase 8 |

## Quickstart (any example)

```sh
# from the repository root — build the agent image once
docker build -t cloud-expose:local .

cd examples/http-server          # or nextjs/, vite/, t3-placeholder/
cp .env.example .env.cloud-expose   # then edit with your relay URL + token

docker compose up                # prints the stable public URL when ready
```

**unverified** — these examples are authored for the Phase 7 pass; until the end-to-end run
confirms them, treat this page as instructions rather than proof. Do not commit
`.env.cloud-expose`; placeholder-only `*.example` files are the committed ones.
