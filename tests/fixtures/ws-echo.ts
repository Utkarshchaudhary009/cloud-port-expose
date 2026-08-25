export interface WsEchoHandle {
  port: number;
  hostname: string;
  stop: () => Promise<void>;
}

interface EchoSocketData {
  name?: string;
}

export function startWsEcho(): Promise<WsEchoHandle> {
  const server = Bun.serve<EchoSocketData>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname !== "/ws") {
        return new Response("not found", { status: 404 });
      }
      if (server.upgrade(request, { data: { name: url.searchParams.get("name") ?? "anon" } })) {
        return undefined;
      }
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ event: "welcome", name: ws.data.name }));
      },
      message(ws, message) {
        if (typeof message === "string") {
          ws.send(message.replace("ws-client:", "ws-origin:"));
          return;
        }
        ws.send(message);
      },
      close() {
        // nothing to clean up
      },
    },
  });
  const { port, hostname } = server;
  if (port === undefined || hostname === undefined) {
    throw new Error("ws echo fixture did not report its address");
  }
  return Promise.resolve({
    port,
    hostname,
    stop: async () => {
      server.stop(true);
    },
  });
}
