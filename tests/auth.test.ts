import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ExposeAgent } from "../src/agent/client";
import type { AuthStore } from "../src/auth";
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
  relay = await startRelay({ authStore });
});

afterAll(async () => {
  await Promise.allSettled(agents.map((agent) => agent.close()));
  origin.stop();
  await relay.stop();
});

describe("client credential authentication", () => {
  test("valid credential connects and authenticates", async () => {
    const { workspaceId, clientToken } = authStore.createWorkspace();
    const agent = newAgent({ clientToken });
    await agent.connect();
    const endpoint = await agent.expose();
    expect(endpoint.workspaceId).toBe(workspaceId);
    await agent.close();
  });

  test("invalid credential is rejected before expose", async () => {
    const agent = newAgent({ clientToken: "cpx_definitely-not-valid" });
    await expect(agent.connect()).rejects.toThrow(/invalid-token|rejected/);
  });

  test("revoked credential is rejected", async () => {
    const { clientToken } = authStore.createWorkspace();
    expect(authStore.revokeClientToken(clientToken)).toBe(true);
    const agent = newAgent({ clientToken });
    await expect(agent.connect()).rejects.toThrow();
  });

  test("rotation invalidates the old token and issues a working new one", async () => {
    const { workspaceId, clientToken } = authStore.createWorkspace();
    const rotated = authStore.rotateClientToken(clientToken);
    expect(rotated).not.toBeNull();

    const oldAgent = newAgent({ clientToken });
    await expect(oldAgent.connect()).rejects.toThrow();

    const newAgentInstance = newAgent({ clientToken: rotated?.clientToken });
    await newAgentInstance.connect();
    const endpoint = await newAgentInstance.expose();
    expect(endpoint.workspaceId).toBe(workspaceId);
    await newAgentInstance.close();
  });

  test("agents without credentials cannot expose when auth is enabled", async () => {
    const agent = newAgent({});
    await expect(
      (async () => {
        await agent.connect();
        await agent.expose();
      })(),
    ).rejects.toThrow(/authenticate/);
  });

  test("a workspace cannot claim an exposure id owned by another workspace", async () => {
    const wsA = authStore.createWorkspace();
    const wsB = authStore.createWorkspace();
    const agentA = newAgent({ clientToken: wsA.clientToken });
    await agentA.connect();
    await agentA.expose(); // registers its random exposureId

    const squatter = new ExposeAgent({
      relayUrl: relay.agentUrl,
      originPort: origin.port,
      clientToken: wsB.clientToken,
      exposureId: "exp_wsquatter1",
    });
    agents.push(squatter);

    const owner = new ExposeAgent({
      relayUrl: relay.agentUrl,
      originPort: origin.port,
      clientToken: wsA.clientToken,
      exposureId: "exp_wsquatter1",
    });
    agents.push(owner);
    await owner.connect();
    await owner.expose();

    await squatter.connect();
    await expect(squatter.expose()).rejects.toThrow(/session-conflict/);
    await agentA.close();
    await owner.close();
  });
});

describe("browser session authorization", () => {
  let sessionHostname = "";
  let openHostname = "";
  let gatedExposureId = "";
  let ownerClientToken = "";

  beforeAll(async () => {
    const workspace = authStore.createWorkspace();
    ownerClientToken = workspace.clientToken;
    const gatedId = "exp_gated00001";
    const gated = newAgent({
      clientToken: ownerClientToken,
      exposureId: gatedId,
      accessMode: "session",
    });
    await gated.connect();
    const endpoint = await gated.expose();
    sessionHostname = endpoint.hostname;
    gatedExposureId = endpoint.exposureId;

    const opener = newAgent({ clientToken: ownerClientToken, accessMode: "open" });
    await opener.connect();
    openHostname = (await opener.expose()).hostname;
  });

  test("session-gated exposure rejects requests without a browser token", async () => {
    const res = await fetch(`http://127.0.0.1:${relay.port}/x`, {
      headers: { host: `${sessionHostname}:${relay.port}` },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("x-relay-error")).toBe("unauthorized");
  });

  test("valid session token grants access to its own exposure", async () => {
    const mint = await fetch(`http://127.0.0.1:${relay.port}/__auth/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerClientToken}`, "content-type": "application/json" },
      body: JSON.stringify({ exposureId: gatedExposureId }),
    });
    expect(mint.status).toBe(200);
    const { sessionToken } = (await mint.json()) as { sessionToken: string };

    const mintedForWrongExposure = await fetch(`http://127.0.0.1:${relay.port}/__auth/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerClientToken}`, "content-type": "application/json" },
      body: JSON.stringify({ exposureId: "not-my-exposure" }),
    });
    expect(mintedForWrongExposure.status).toBe(404);

    const authorized = await fetch(`http://127.0.0.1:${relay.port}/`, {
      headers: {
        host: `${sessionHostname}:${relay.port}`,
        cookie: `cpx_session=${encodeURIComponent(sessionToken)}`,
      },
    });
    expect(authorized.status).toBe(200);
  });

  test("expired or foreign session tokens are rejected", async () => {
    const shortLived = authStore.createBrowserSession("__none__", "__ws__", 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(authStore.verifyBrowserSession(shortLived, "__none__")).toBe(false);
    expect(authStore.createBrowserSession("__n2__", "__ws__", Number.NaN)).toBeTruthy();
    expect(authStore.createBrowserSession("__n3__", "__ws__", -5000)).toBeTruthy();

    const otherToken = authStore.createBrowserSession("other-exposure-id", "__ws2__");
    expect(authStore.verifyBrowserSession(otherToken, "target-exposure")).toBe(false);
    expect(authStore.revokeBrowserSession(otherToken)).toBe(true);
    expect(authStore.verifyBrowserSession(otherToken, "other-exposure-id")).toBe(false);
  });

  test("open exposures remain reachable without any token", async () => {
    const res = await fetch(`http://127.0.0.1:${relay.port}/`, {
      headers: { host: `${openHostname}:${relay.port}` },
    });
    expect(res.status).toBe(200);
  });

  test("session endpoint requires a valid client credential", async () => {
    const noAuth = await fetch(`http://127.0.0.1:${relay.port}/__auth/sessions`, {
      method: "POST",
    });
    expect(noAuth.status).toBe(401);

    const badAuth = await fetch(`http://127.0.0.1:${relay.port}/__auth/sessions`, {
      method: "POST",
      headers: { authorization: "Bearer cpx_bogus" },
    });
    expect(badAuth.status).toBe(401);
  });
});

describe("secrets hygiene", () => {
  test("auth store never stores plaintext tokens", () => {
    const store: AuthStore = new InMemoryAuthStore();
    const { clientToken } = store.createWorkspace();
    const serialized = JSON.stringify(store);
    expect(serialized).not.toContain(clientToken);
  });

  test("logger redacts credential-shaped keys", async () => {
    const lines: string[] = [];
    const { createLogger } = await import("../src/util/logger");
    const log = createLogger({ subsystem: "test", sink: (line) => lines.push(line) });
    log.info("auth attempt", { clientToken: "cpx_super_secret_value", authorization: "Bearer x" });
    const all = lines.join("\n");
    expect(all).not.toContain("cpx_super_secret_value");
    expect(all).not.toContain("Bearer x");
  });
});
