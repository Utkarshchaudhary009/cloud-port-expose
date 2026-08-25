export interface TcpEchoHandle {
  port: number;
  hostname: string;
  stop: () => Promise<void>;
}

export function startTcpEcho(
  options: { port?: number; hostname?: string } = {},
): Promise<TcpEchoHandle> {
  const server = Bun.listen({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    socket: {
      data(socket, data) {
        socket.write(data);
      },
    },
  });
  return Promise.resolve({
    port: server.port,
    hostname: server.hostname,
    stop: async () => {
      server.stop(true);
    },
  });
}
