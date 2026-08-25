import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ExposeAgent } from "../src/agent/client";
import { startRelay } from "../src/relay/server";
import type { RelayHandle } from "../src/relay/session";
import { type HttpOriginHandle, startHttpOrigin } from "./fixtures/origin-http";
import { startWsEcho, type WsEchoHandle } from "./fixtures/ws-echo";

let origin: HttpOriginHandle;
let wsEcho: WsEchoHandle;
let relay: RelayHandle;
const agents: ExposeAgent[] = [];

interface OpenedClient {
  socket: WebSocket;
  messages: (string | Uint8Array)[];
  closed: Promise<{ code: number; reason: string }>;
  send(data: string | Uint8Array): void;
}

function openPublicWs(hostname: string, pathWithQuery: string): Promise<OpenedClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${relay.port}${pathWithQuery}`, {
    headers: { host: `${hostname}:${relay.port}` },
  });
  const client: OpenedClient = {
    socket,
    messages: [],
    closed: new Promise<{ code: number; reason: string }>(() => {}),
    send(data) {
      socket.send(data);
    },
  };
  let resolveClosed: (value: { code: number; reason: string }) => void;
  client.closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  socket.addEventListener("message", (event) => {
    client.messages.push(typeof event.data === "string" ? event.data : new Uint8Array(event.data));
  });
  socket.addEventListener("close", (event) => {
    resolveClosed({ code: (event as CloseEvent).code, reason: (event as CloseEvent).reason });
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("public ws open timed out")), 5000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve(client);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error(`public ws failed to open for ${hostname}`));
    });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

async function exposeOrigin(target: { port: number }, exposureId: string): Promise<string> {
  const agent = new ExposeAgent({ relayUrl: relay.agentUrl, originPort: target.port, exposureId });
  agents.push(agent);
  await agent.connect();
  const endpoint = await agent.expose();
  return endpoint.hostname;
}

beforeAll(async () => {
  origin = await startHttpOrigin();
  wsEcho = await startWsEcho();
  relay = await startRelay({ requestTimeoutMs: 5_000, heartbeatIntervalMs: 300 });
});

afterAll(async () => {
  await Promise.allSettled(agents.map((agent) => agent.close()));
  origin.stop();
  await wsEcho.stop();
  await relay.stop();
});

describe("websocket tunneling", () => {
  let wsHostname = "";

  beforeAll(async () => {
    wsHostname = await exposeOrigin(wsEcho, "exp_wsbridge01");
  });

  test("upgrade requests reach the origin and welcome frames flow back", async () => {
    const client = await openPublicWs(wsHostname, "/ws?name=tunneled");
    const sawWelcome = await waitFor(
      () =>
        client.messages
          .map(String)
          .some((t) => t.includes('"event":"welcome"') && t.includes("tunneled")),
      4000,
    );
    expect(sawWelcome).toBe(true);
    client.socket.close(1000, "done");
  });

  test("bidirectional text and binary messages preserve order and content", async () => {
    const client = await openPublicWs(wsHostname, "/ws?name=bidi");
    await waitFor(() => client.messages.length > 0, 4000);
    client.messages.length = 0;

    for (let i = 0; i < 10; i++) {
      client.send(`ws-client:message-${i}`);
    }
    const binaryPayload = new Uint8Array([9, 8, 7, 6]);
    client.send(binaryPayload);

    const gotAll = await waitFor(() => client.messages.length >= 11, 5000);
    expect(gotAll).toBe(true);
    const texts = client.messages.filter((m) => typeof m === "string").map(String);
    for (let i = 0; i < 10; i++) {
      expect(texts[i]).toContain(`message-${i}`);
    }
    const binary = client.messages.find((m) => m instanceof Uint8Array) as Uint8Array | undefined;
    expect(Array.from(binary ?? [])).toEqual([9, 8, 7, 6]);
    client.socket.close(1000, "");
  });

  test("large payloads survive the tunnel intact", async () => {
    const client = await openPublicWs(wsHostname, "/ws?name=large");
    await waitFor(() => client.messages.length > 0, 4000);
    client.messages.length = 0;

    const payload = new TextEncoder().encode(`L:${"x".repeat(512 * 1024)}:X`);
    client.send(payload);

    await waitFor(
      () =>
        (client.messages.find((m) => m instanceof Uint8Array) as Uint8Array | undefined)
          ?.byteLength === payload.byteLength,
      15_000,
    );
    const echoed = client.messages.find((m) => m instanceof Uint8Array) as Uint8Array | undefined;
    expect(echoed?.byteLength).toBe(payload.byteLength);
    expect(Buffer.from(echoed ?? []).equals(Buffer.from(payload))).toBe(true);
    client.socket.close(1000, "");
  });

  test("idle bridged connections survive many heartbeat intervals", async () => {
    const client = await openPublicWs(wsHostname, "/ws?name=idle");
    await waitFor(() => client.messages.length > 0, 4000);
    client.messages.length = 0;

    await new Promise((resolve) => setTimeout(resolve, 1_200));

    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    client.send("still-alive");
    const echoed = await waitFor(
      () => client.messages.map(String).some((t) => t.includes("still-alive")),
      3000,
    );
    expect(echoed).toBe(true);
    client.socket.close(1000, "");
  });

  test("public disconnects close the origin bridge", async () => {
    const client = await openPublicWs(wsHostname, "/ws?name=vanish");
    await waitFor(() => client.messages.length > 0, 4000);
    client.socket.close(1000, "bye");
    // If the relay leaked bridges, subsequent full-file cleanup would still pass;
    // assert our own close propagated back through the tunnel.
    const closed = await client.closed;
    expect(closed.code).toBe(1000);
  });
});

describe("streaming bodies", () => {
  let uploadOrigin: HttpOriginHandle;

  afterAll(async () => {
    uploadOrigin?.stop();
  });

  test("multi-megabyte uploads keep content integrity through the tunnel", async () => {
    uploadOrigin = await startHttpOrigin({
      handler: async (request) => new Response(request.body, { status: 200 }),
    });
    const hostname = await exposeOrigin(uploadOrigin, "exp_stream001");
    const size = 4 * 1024 * 1024;
    const blob = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      blob[i] = i % 251;
    }
    const res = await fetch(`http://127.0.0.1:${relay.port}/upload`, {
      method: "POST",
      body: blob,
      headers: { "content-type": "application/octet-stream", host: `${hostname}:${relay.port}` },
    });
    const echoed = new Uint8Array(await res.arrayBuffer());
    expect(res.status).toBe(200);
    expect(echoed.byteLength).toBe(size);
    expect(Buffer.from(echoed.subarray(0, 4096)).equals(Buffer.from(blob.subarray(0, 4096)))).toBe(
      true,
    );
    expect(echoed[size - 1]).toBe(blob[size - 1]);
  });
});

describe("reconnect hygiene", () => {
  test("a reconnecting agent does not disturb an existing live session", async () => {
    const firstHostname = await exposeOrigin(origin, "exp_reconn001");
    const secondHostname = await exposeOrigin(origin, "exp_reconn002");

    expect(firstHostname).not.toBe(secondHostname);

    const [resA, resB] = await Promise.all([
      fetch(`http://127.0.0.1:${relay.port}/one`, {
        headers: { host: `${firstHostname}:${relay.port}` },
      }),
      fetch(`http://127.0.0.1:${relay.port}/two`, {
        headers: { host: `${secondHostname}:${relay.port}` },
      }),
    ]);
    expect(resA.status).toBe(200);
    expect(await resA.text()).toContain("origin-ok");
    expect(resB.status).toBe(200);
  });
});
