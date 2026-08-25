export interface HttpOriginOptions {
  port?: number;
  handler?: (request: Request) => Response | Promise<Response>;
}

export interface HttpOriginHandle {
  port: number;
  hostname: string;
  url: string;
  stop: () => Promise<void>;
}

const DEFAULT_HANDLER = (): Response =>
  new Response("origin-ok\n", {
    status: 200,
    headers: { "x-origin": "fixture" },
  });

export function startHttpOrigin(options: HttpOriginOptions = {}): Promise<HttpOriginHandle> {
  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    fetch: options.handler ?? DEFAULT_HANDLER,
  });
  const { port, hostname } = server;
  if (port === undefined || hostname === undefined) {
    server.stop(true);
    throw new Error("fixture server did not report a listen address");
  }
  return Promise.resolve({
    port,
    hostname,
    url: server.url.origin,
    stop: async () => {
      server.stop(true);
    },
  });
}
