import { afterAll, describe, expect, test } from "bun:test";
import { type HttpOriginHandle, startHttpOrigin } from "./fixtures/origin-http";
import { startTcpEcho, type TcpEchoHandle } from "./fixtures/tcp-echo";

let httpOrigin: HttpOriginHandle;
let echoServer: TcpEchoHandle;

afterAll(async () => {
  await httpOrigin?.stop();
  await echoServer?.stop();
});

describe("http origin fixture", () => {
  test("serves the default canned response", async () => {
    httpOrigin = await startHttpOrigin();
    const res = await fetch(httpOrigin.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-origin")).toBe("fixture");
    expect(await res.text()).toBe("origin-ok\n");
  });

  test("supports custom handlers and preserves request details", async () => {
    let seenPath = "";
    let seenQuery = "";
    let seenMethod = "";
    const origin = await startHttpOrigin({
      handler: (request) => {
        const url = new URL(request.url);
        seenPath = url.pathname;
        seenQuery = url.search;
        seenMethod = request.method;
        return new Response(`echo:${seenMethod}:${seenPath}${seenQuery}`);
      },
    });
    try {
      const res = await fetch(`${origin.url}/some/path?alpha=1&beta=2`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("echo:POST:/some/path?alpha=1&beta=2");
      expect(seenPath).toBe("/some/path");
      expect(seenQuery).toBe("?alpha=1&beta=2");
      expect(seenMethod).toBe("POST");
    } finally {
      origin.stop();
    }
  });
});

describe("tcp echo fixture", () => {
  test("echoes bytes back to the client", async () => {
    echoServer = await startTcpEcho();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const done = Promise.withResolvers<void>();
    const payload = new TextEncoder().encode("ping-through-tcp");
    const socket = await Bun.connect({
      hostname: echoServer.hostname,
      port: echoServer.port,
      socket: {
        data(_socket, data) {
          chunks.push(data);
          total += data.byteLength;
          if (total >= payload.byteLength) {
            done.resolve();
          }
        },
      },
    });
    socket.write(payload);
    await done.promise;
    socket.end();
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(new TextDecoder().decode(merged)).toBe("ping-through-tcp");
  });
});
