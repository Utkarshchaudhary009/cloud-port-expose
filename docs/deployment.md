# Deployment Guide (Public Infrastructure)

> **Status:** guidance only — the steps below require infrastructure that this repository does
> not yet have. They are documented so a fresh operator can complete Phase 5's public rollout.
> Items marked **unverified** have never been exercised against real infrastructure.

## 1. Domain & wildcard DNS

1. Register/choose a domain (e.g. `expose.example.com`).
2. Create an `A` record `*.expose.example.com → <relay public IP>`.
3. Relay must be started with `domain: "expose.example.com"` so hostnames become
   `<slug>.expose.example.com`.

**unverified** — no domain is attached to this repository yet.

## 2. Wildcard TLS via ACME DNS-01

Let's Encrypt allows only 50 new certificates per registered domain per week, so per-subdomain
certificates will exhaust the quota. Use ONE wildcard certificate:

1. Pick an ACME client with DNS-01 support (e.g. `certbot` with the appropriate DNS plugin,
   or `acme.sh`).
2. Issue: `*.expose.example.com` (wildcard requires DNS-01).
3. Mount cert+key on the relay host and pass them to `startRelay({ tls: { cert, key } })`
   (PEM contents). Renewal: re-run issuance ≤30 days before expiry and restart/reload the relay.
4. Automate renewal via cron/systemd timer.

**unverified** — needs live DNS API credentials. Local TLS termination itself IS verified with
self-signed certificates (see `tests/named.test.ts`, "tls termination" describe).

## 3. Listener layout

- `:443` — TLS public listener (`Bun.serve({ tls })`), routes by Host header.
- `:80` — optional HTTP redirect to HTTPS (not implemented yet; add a tiny redirect server).

## 4. Operational notes

- Set `CLOUD_EXPOSE_TOKEN`-style credentials per workspace via the auth store bootstrap;
  never share long-lived client tokens in URLs.
- Monitor `x-relay-error` responses: `offline` (no agent), `timeout` (origin too slow),
  `upstream-disconnected`.
