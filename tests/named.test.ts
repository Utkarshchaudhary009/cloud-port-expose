import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExposeAgent } from "../src/agent/client";
import { InMemoryAuthStore } from "../src/auth/tokens";
import { startRelay } from "../src/relay/server";
import type { RelayHandle } from "../src/relay/session";
import { type HttpOriginHandle, startHttpOrigin } from "./fixtures/origin-http";

let origin: HttpOriginHandle;
let relay: RelayHandle;
let authStore: InMemoryAuthStore;
const agents: ExposeAgent[] = [];

function newAgent(
  options: Partial<ConstructorParameters<typeof ExposeAgent>[0]> = {},
): ExposeAgent {
  const agent = new ExposeAgent({
    relayUrl: relay.agentUrl,
    originPort: origin.port,
    ...options,
  });
  agents.push(agent);
  return agent;
}

beforeAll(async () => {
  origin = await startHttpOrigin();
  authStore = new InMemoryAuthStore();
  relay = await startRelay({ authStore, nameReservationTtlMs: 300 });
});

afterAll(async () => {
  await Promise.allSettled(agents.map((agent) => agent.close()));
  origin.stop();
  await relay.stop();
});

describe("named exposures", () => {
  test("a named exposure binds to <name>.<domain> and routes", async () => {
    const { clientToken } = authStore.createWorkspace();
    const agent = newAgent({ clientToken, exposureId: "exp_named0001", exposureName: "agy-usage" });
    await agent.connect();
    const endpoint = await agent.expose();

    expect(endpoint.hostname).toBe(`agy-usage.${relay.domain}`);
    expect(endpoint.url).toBe(`http://agy-usage.${relay.domain}:${relay.port}`);

    const res = await fetch(`http://127.0.0.1:${relay.port}/`, {
      headers: { host: `${endpoint.hostname}:${relay.port}` },
    });
    expect(res.status).toBe(200);
  });

  test("reconnecting with the same workspace credential preserves the hostname", async () => {
    const ws = authStore.createWorkspace();
    const first = newAgent({
      clientToken: ws.clientToken,
      exposureId: "exp_named0002",
      exposureName: "stable-app",
    });
    await first.connect();
    const firstEndpoint = await first.expose();
    expect(firstEndpoint.hostname).toBe(`stable-app.${relay.domain}`);
    await first.close();

    // same workspace credential, brand-new session + exposure id
    const second = newAgent({
      clientToken: ws.clientToken,
      exposureId: "exp_named002b",
      exposureName: "stable-app",
    });
    await second.connect();
    const secondEndpoint = await second.expose();
    expect(secondEndpoint.hostname).toBe(firstEndpoint.hostname);
    expect(secondEndpoint.sessionId).not.toBe(firstEndpoint.sessionId);
    await second.close();
  });

  test("another workspace cannot claim an existing protected name", async () => {
    const ownerWs = authStore.createWorkspace();
    const owner = newAgent({
      clientToken: ownerWs.clientToken,
      exposureId: "exp_named0005",
      exposureName: "protected-name",
    });
    await owner.connect();
    await owner.expose();

    const attackerWs = authStore.createWorkspace();
    const attacker = newAgent({
      clientToken: attackerWs.clientToken,
      exposureId: "exp_named0006",
      exposureName: "protected-name",
    });
    await attacker.connect();
    await expect(attacker.expose()).rejects.toThrow(/another workspace/);

    const res = await fetch(`http://127.0.0.1:${relay.port}/`, {
      headers: { host: `protected-name.${relay.domain}:${relay.port}` },
    });
    expect(res.status).toBe(200);
    await owner.close();
  });

  test("invalid slugs are rejected with bad-request", async () => {
    const invalids = [
      "ab",
      "-leading",
      "trailing-",
      "has_underscore",
      "UPPER-case",
      "a".repeat(64),
    ];
    for (const [index, bad] of invalids.entries()) {
      const agent = newAgent({
        clientToken: authStore.createWorkspace().clientToken,
        exposureId: `exp_badname00${index}`,
        exposureName: bad,
      });
      await agent.connect();
      await expect(agent.expose()).rejects.toThrow(/bad-request/);
    }
  });

  test("offline named exposures return a controlled error page", async () => {
    const resJson = await fetch(`http://127.0.0.1:${relay.port}/x`, {
      headers: { host: `never-existed.${relay.domain}:${relay.port}` },
    });
    expect(resJson.status).toBe(503);
    expect(await resJson.json()).toEqual({ error: "offline" });
  });

  test("abandoned name reservations expire so names can be reclaimed", async () => {
    const wsA = authStore.createWorkspace();
    const holder = newAgent({
      clientToken: wsA.clientToken,
      exposureId: "exp_named0007",
      exposureName: "recyclable",
    });
    await holder.connect();
    await holder.expose();
    await holder.close();

    await new Promise((resolve) => setTimeout(resolve, 700));

    const wsB = authStore.createWorkspace();
    const claimer = newAgent({
      clientToken: wsB.clientToken,
      exposureId: "exp_named0008",
      exposureName: "recyclable",
    });
    await claimer.connect();
    const endpoint = await claimer.expose();
    expect(endpoint.hostname).toBe(`recyclable.${relay.domain}`);
  }, 10_000);
});

describe("tls termination (self-signed)", () => {
  let tlsRelay: RelayHandle;
  let tlsOrigin: HttpOriginHandle;
  let certPem = "";
  let keyPem = "";

  beforeAll(async () => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    const dir = mkdtempSync(join(tmpdir(), "cpx-tls-"));
    const certPath = join(dir, "cert.pem");
    const keyPath = join(dir, "key.pem");
    const gen = Bun.spawnSync([
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "2",
      "-nodes",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,DNS:*.localhost,IP:127.0.0.1",
    ]);
    if (gen.exitCode !== 0) {
      throw new Error(`openssl failed: ${new TextDecoder().decode(gen.stderr)}`);
    }
    certPem = readFileSync(certPath, "utf8");
    keyPem = readFileSync(keyPath, "utf8");

    tlsOrigin = await startHttpOrigin();
    tlsRelay = await startRelay({
      tls: { cert: certPem, key: keyPem },
      port: 0,
    });
  });

  let previousTlsReject: string | undefined;

  beforeAll(() => {
    previousTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  });

  afterAll(async () => {
    if (previousTlsReject === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsReject;
    }
    await tlsRelay.stop();
    tlsOrigin.stop();
  });

  test("https requests terminate TLS on the relay and route through the tunnel", async () => {
    const agent = new ExposeAgent({
      relayUrl: tlsRelay.agentUrl,
      originPort: tlsOrigin.port,
      exposureId: "exp_tls00001",
    });
    agents.push(agent);
    await agent.connect();
    const endpoint = await agent.expose();
    expect(endpoint.url.startsWith("https://")).toBe(true);

    const res = await fetch(`https://127.0.0.1:${tlsRelay.port}/`, {
      headers: { host: `${endpoint.hostname}:${tlsRelay.port}` },
      tls: { rejectUnauthorized: false },
    } as RequestInit);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("origin-ok");
  }, 15_000);
});
