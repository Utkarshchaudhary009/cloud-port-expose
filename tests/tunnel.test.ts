import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ExposeAgent } from "../src/agent/client";
import { startRelay } from "../src/relay/server";
import type { RelayHandle } from "../src/relay/session";
import { type HttpOriginHandle, startHttpOrigin } from "./fixtures/origin-http";

interface PublicResponse {
  status: number;
  headers: [string, string][];
  body: string;
}

let origin: HttpOriginHandle;
let relay: RelayHandle;
let firstAgent: ExposeAgent | undefined;
let firstExposureId = "";
let firstSessionId = "";
let firstHostname = "";
const agents: ExposeAgent[] = [];

function headerValue(res: PublicResponse, name: string): string | undefined {
  const found = res.headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1];
}

async function requestViaSeparateProcess(
  hostname: string,
  pathWithQuery: string,
  options: { method?: string; body?: string; headers?: [string, string][] } = {},
  relayPort = relay.port,
): Promise<PublicResponse> {
  const args = [
    "tests/helpers/public-client.ts",
    hostname,
    String(relayPort),
    pathWithQuery,
    ...(options.method ? ["--method", options.method] : []),
    ...(options.body !== undefined ? ["--body", options.body] : []),
    ...(options.headers ?? []).flatMap(([name, value]) => ["--header", `${name}:${value}`]),
  ];
  const proc = Bun.spawn(["bun", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(
      `public client failed (${exitCode}): ${await new Response(proc.stderr).text()}`,
    );
  }
  return JSON.parse(stdout.trim()) as PublicResponse;
}

beforeAll(async () => {
  origin = await startHttpOrigin({
    handler: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/created") {
        const headers = new Headers({ "x-custom": "yes" });
        headers.append("set-cookie", "session=abc");
        headers.append("set-cookie", "prefs=xyz");
        return new Response("made-it", { status: 201, headers });
      }
      if (url.pathname === "/slow") {
        await new Promise((resolve) => setTimeout(resolve, 1_200));
      }
      if (url.pathname === "/slow-then-409") {
        await new Promise((resolve) => setTimeout(resolve, 900));
        return new Response("conflicted", { status: 409 });
      }
      const body = request.body === null ? "" : await request.text();
      return Response.json({
        method: request.method,
        path: url.pathname,
        query: url.search.replace(/^\?/, ""),
        probe: request.headers.get("x-probe"),
        bodyEcho: body,
      });
    },
  });
  relay = await startRelay({ requestTimeoutMs: 800 });
});

afterAll(async () => {
  await Promise.allSettled(agents.map((agent) => agent.close()));
  origin.stop();
  await relay.stop();
});

describe("minimal outbound tunnel", () => {
  test("exposing yields a generated public relay URL", async () => {
    const agent = new ExposeAgent({ relayUrl: relay.agentUrl, originPort: origin.port });
    agents.push(agent);
    await agent.connect();
    const endpoint = await agent.expose();
    firstAgent = agent;
    firstExposureId = endpoint.exposureId;
    firstSessionId = endpoint.sessionId;
    firstHostname = endpoint.hostname;
    expect(endpoint.hostname).toMatch(/^[a-z0-9]{8}\.localhost$/);
    expect(endpoint.url).toBe(`http://${firstHostname}:${relay.port}`);
    expect(endpoint.sessionId).toMatch(/^sess_/);
  });

  test("GET from a separate process preserves status, body, query, and headers", async () => {
    const res = await requestViaSeparateProcess(firstHostname, `/hello?alpha=1&beta=two+spaces`, {
      headers: [["x-probe", "probe-value"]],
    });
    expect(res.status).toBe(200);
    expect(headerValue(res, "content-type")).toContain("application/json");
    const echoed = JSON.parse(res.body) as Record<string, string>;
    expect(echoed.method).toBe("GET");
    expect(echoed.path).toBe("/hello");
    expect(echoed.query).toBe("alpha=1&beta=two+spaces");
    expect(echoed.probe).toBe("probe-value");
  });

  test("POST bodies survive the tunnel", async () => {
    const res = await requestViaSeparateProcess(firstHostname, "/submit", {
      method: "POST",
      body: "raw-body-payload",
    });
    expect(res.status).toBe(200);
    const echoed = JSON.parse(res.body) as Record<string, string>;
    expect(echoed.method).toBe("POST");
    expect(echoed.bodyEcho).toBe("raw-body-payload");
  });

  test("custom status codes and response headers survive the tunnel", async () => {
    const res = await requestViaSeparateProcess(firstHostname, "/created");
    expect(res.status).toBe(201);
    expect(headerValue(res, "x-custom")).toBe("yes");
    const cookies = res.headers.filter(([name]) => name === "set-cookie").map(([, value]) => value);
    expect(cookies).toEqual(["session=abc", "prefs=xyz"]);
    expect(res.body).toBe("made-it");
  });

  test("concurrent requests do not cross streams", async () => {
    const paths = ["/c1", "/c2", "/c3", "/c4", "/c5"];
    const responses = await Promise.all(
      paths.map((p) => requestViaSeparateProcess(firstHostname, p)),
    );
    responses.forEach((res, index) => {
      expect(JSON.parse(res.body).path).toBe(paths[index]);
    });
  });

  test("killing the client makes the relay report the exposure offline", async () => {
    if (!firstAgent) {
      throw new Error("first agent was not created");
    }
    await firstAgent.close();
    let lastStatus = 0;
    let lastCode = "";
    for (let attempt = 0; attempt < 20; attempt++) {
      const res = await requestViaSeparateProcess(firstHostname, "/");
      lastStatus = res.status;
      lastCode = headerValue(res, "x-relay-error") ?? "";
      if (lastStatus === 503 && lastCode === "offline") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(lastStatus).toBe(503);
    expect(lastCode).toBe("offline");
  });

  test("reconnecting re-establishes a session on the same stable hostname", async () => {
    const reconnect = new ExposeAgent({
      relayUrl: relay.agentUrl,
      originPort: origin.port,
      exposureId: firstExposureId,
    });
    agents.push(reconnect);
    await reconnect.connect();
    const endpoint = await reconnect.expose();
    expect(endpoint.hostname).toBe(firstHostname);
    expect(endpoint.sessionId).not.toBe(firstSessionId);

    const res = await requestViaSeparateProcess(firstHostname, "/back-online");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).path).toBe("/back-online");
  });

  test("a second live session cannot claim the same exposure id", async () => {
    const squatter = new ExposeAgent({
      relayUrl: relay.agentUrl,
      originPort: origin.port,
      exposureId: firstExposureId,
    });
    agents.push(squatter);
    await squatter.connect();
    await expect(squatter.expose()).rejects.toThrow(/session-conflict/);
  });

  test("requests outside the exposure domain are rejected with no-route", async () => {
    const res = await fetch(`http://127.0.0.1:${relay.port}/anything`);
    expect(res.status).toBe(404);
    expect(res.headers.get("x-relay-error")).toBe("no-route");
  });

  test("agents sending malformed frames are disconnected with protocol violation", async () => {
    const closed = Promise.withResolvers<number>();
    const ws = new WebSocket(relay.agentUrl);
    ws.addEventListener("open", () => {
      ws.send("this is not json{{{");
    });
    ws.addEventListener("close", (event) => {
      closed.resolve((event as CloseEvent).code);
    });
    ws.addEventListener("error", () => {
      closed.resolve(-1);
    });
    const code = await Promise.race([
      closed.promise,
      new Promise<number>((resolve) => setTimeout(() => resolve(-2), 3_000)),
    ]);
    expect(code).toBe(1002);
  });

  test("exposure ids are unique per agent instance when not supplied", () => {
    const a = new ExposeAgent({ relayUrl: "ws://127.0.0.1:1", originPort: 1 });
    const b = new ExposeAgent({ relayUrl: "ws://127.0.0.1:1", originPort: 1 });
    expect(a.exposureId).not.toBe(b.exposureId);
    expect(a.exposureId).toMatch(/^exp_[0-9a-f]{16}$/);
  });

  test("abruptly disconnected public clients free the exchange", async () => {
    const clientProc = Bun.spawn(
      ["bun", "tests/helpers/public-client.ts", firstHostname, String(relay.port), "/slow"],
      { stdout: "pipe", stderr: "pipe" },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    clientProc.kill("SIGKILL");

    const followUp = await requestViaSeparateProcess(firstHostname, "/after-abort");
    expect(followUp.status).toBe(200);
    expect(JSON.parse(followUp.body).path).toBe("/after-abort");
  });

  test("origin responses slower than the relay timeout return 504 without killing the session", async () => {
    const timedOut = await requestViaSeparateProcess(firstHostname, "/slow");
    expect(timedOut.status).toBe(504);
    expect(headerValue(timedOut, "x-relay-error")).toBe("timeout");

    const stillAlive = await requestViaSeparateProcess(firstHostname, "/still-here");
    expect(stillAlive.status).toBe(200);
    expect(JSON.parse(stillAlive.body).path).toBe("/still-here");
  });
});

describe("abrupt agent death (separate process, SIGKILL)", () => {
  let killRelay!: RelayHandle;
  let killOrigin!: HttpOriginHandle;
  const exposureId = "exp_killtest01";
  const idempotentExposureId = "exp_idempotent1";

  function readFirstLine(proc: ReturnType<typeof Bun.spawn>): Promise<string> {
    return (async () => {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
        const newline = buffer.indexOf("\n");
        if (newline >= 0) {
          return buffer.slice(0, newline);
        }
      }
      return buffer;
    })();
  }

  function spawnMiniAgent(): ReturnType<typeof Bun.spawn> {
    return Bun.spawn(
      [
        "bun",
        "tests/helpers/mini-agent.ts",
        killRelay.agentUrl,
        String(killOrigin.port),
        exposureId,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
  }

  beforeAll(async () => {
    killOrigin = await startHttpOrigin();
    killRelay = await startRelay({ requestTimeoutMs: 5_000 });
  });

  afterAll(async () => {
    killOrigin.stop();
    await killRelay.stop();
  });

  test("killed agent's hostname goes offline, then re-binds on reconnect", async () => {
    const firstProc = spawnMiniAgent();
    const first = JSON.parse(await readFirstLine(firstProc)) as {
      hostname: string;
      sessionId: string;
    };

    const alive = await requestViaSeparateProcess(first.hostname, "/one", {}, killRelay.port);
    expect(alive.status).toBe(200);

    firstProc.kill("SIGKILL");

    let offlineSeen = false;
    for (let attempt = 0; attempt < 40 && !offlineSeen; attempt++) {
      try {
        const probe = await requestViaSeparateProcess(first.hostname, "/", {}, killRelay.port);
        offlineSeen =
          probe.status === 503 &&
          probe.headers.some(([name, value]) => name === "x-relay-error" && value === "offline");
      } catch {
        // connection refused mid-teardown: keep polling
      }
      if (!offlineSeen) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(offlineSeen).toBe(true);

    // Re-bind with the same exposureId. The reconnection is verified in-process:
    // bun test's child-process handling makes long-lived spawned WebSockets flaky,
    // but the relay-side rebinding behavior is what this test actually verifies.
    const reborn = new ExposeAgent({
      relayUrl: killRelay.agentUrl,
      originPort: killOrigin.port,
      exposureId,
    });
    await reborn.connect();
    const endpoint = await reborn.expose();
    expect(endpoint.hostname).toBe(first.hostname);
    expect(endpoint.sessionId).not.toBe(first.sessionId);

    const back = await requestViaSeparateProcess(first.hostname, "/two", {}, killRelay.port);
    expect(back.status).toBe(200);
    await reborn.close();
  }, 20_000);

  test("re-exposing the same exposureId on one session is idempotent", async () => {
    const agent = new ExposeAgent({
      relayUrl: killRelay.agentUrl,
      originPort: killOrigin.port,
      exposureId: idempotentExposureId,
    });
    agents.push(agent);
    await agent.connect();
    const first = await agent.expose();
    const second = await agent.expose();
    expect(second.hostname).toBe(first.hostname);
    expect(second.url).toBe(first.url);
  });
});
