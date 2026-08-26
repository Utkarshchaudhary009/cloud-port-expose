interface Args {
  host: string;
  port: number;
  pathWithQuery: string;
  method: string;
  body: string | undefined;
  headers: [string, string][];
}

function parseArgs(argv: readonly string[]): Args {
  let host = "";
  let port = 0;
  let pathWithQuery = "/";
  let method = "GET";
  let body: string | undefined;
  const headers: [string, string][] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--method") {
      method = argv[i + 1] ?? "GET";
      i++;
    } else if (arg === "--body") {
      body = argv[i + 1] ?? "";
      i++;
    } else if (arg === "--header") {
      const raw = argv[i + 1] ?? "";
      const sep = raw.indexOf(":");
      if (sep > 0) {
        headers.push([raw.slice(0, sep).trim(), raw.slice(sep + 1).trim()]);
      }
      i++;
    } else if (!host) {
      host = arg ?? "";
    } else if (port === 0) {
      port = Number.parseInt(arg ?? "", 10);
    } else if (arg?.startsWith("/")) {
      pathWithQuery = arg;
    }
  }
  return { host, port, pathWithQuery, method, body, headers };
}

function findResponseEnd(buf: Buffer, headerEnd: number): { bodyEnd: number; isChunked: boolean } {
  const head = buf.subarray(0, headerEnd).toString("latin1");
  const headerLines = head.split("\r\n");
  const isChunked = headerLines.some(
    (l) => l.toLowerCase().startsWith("transfer-encoding:") && l.toLowerCase().includes("chunked"),
  );
  const contentLengthLine = headerLines.find((l) => l.toLowerCase().startsWith("content-length:"));
  if (contentLengthLine) {
    const len = Number.parseInt(contentLengthLine.slice("content-length:".length).trim(), 10);
    if (Number.isFinite(len)) {
      return { bodyEnd: headerEnd + 4 + len, isChunked: false };
    }
  }
  if (isChunked) {
    let cursor = headerEnd + 4;
    for (;;) {
      const lineEnd = buf.indexOf("\r\n", cursor);
      if (lineEnd < 0) return { bodyEnd: -1, isChunked: true };
      const sizeLine = buf.subarray(cursor, lineEnd).toString("latin1").trim();
      const size = Number.parseInt(sizeLine, 16);
      if (!Number.isFinite(size)) return { bodyEnd: -1, isChunked: true };
      const chunkStart = lineEnd + 2;
      const chunkEnd = chunkStart + size;
      if (size === 0) {
        return { bodyEnd: chunkEnd + 2, isChunked: true };
      }
      if (buf.byteLength < chunkEnd + 2) return { bodyEnd: -1, isChunked: true };
      cursor = chunkEnd + 2;
    }
  }
  return { bodyEnd: -1, isChunked: false };
}

async function request(args: Args): Promise<string> {
  if (!Number.isInteger(args.port) || args.port <= 0) {
    throw new Error(`invalid port: ${args.port}`);
  }
  const bodyBytes = args.body === undefined ? undefined : new TextEncoder().encode(args.body);
  const lines = [
    `${args.method} ${args.pathWithQuery} HTTP/1.1`,
    `Host: ${args.host}`,
    "Connection: close",
    ...args.headers.map(([name, value]) => `${name}: ${value}`),
  ];
  if (bodyBytes !== undefined) {
    lines.push(`Content-Length: ${bodyBytes.byteLength}`);
  }
  const head = `${lines.join("\r\n")}\r\n\r\n`;
  const headBytes = new TextEncoder().encode(head);

  const received: Uint8Array[] = [];
  let totalLen = 0;
  let responseComplete = false;
  const closed = Promise.withResolvers<void>();
  const socket = await Bun.connect({
    hostname:
      args.host === "localhost" || args.host.endsWith(".localhost") ? "127.0.0.1" : args.host,
    port: args.port,
    socket: {
      data(_socket, data) {
        received.push(data);
        totalLen += data.byteLength;
        const buf = Buffer.concat(received.map((c) => Buffer.from(c)));
        const headerEnd = buf.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const { bodyEnd } = findResponseEnd(buf, headerEnd);
        if (bodyEnd > 0 && totalLen >= bodyEnd) {
          responseComplete = true;
          try {
            socket.shutdown();
          } catch {
            // already closed
          }
          closed.resolve();
        }
      },
      close() {
        closed.resolve();
      },
      error() {
        closed.resolve();
      },
    },
  });
  socket.write(headBytes);
  if (bodyBytes !== undefined) {
    socket.write(bodyBytes);
  }
  // Generous absolute deadline: 3s under normal operation, but the test
  // runner can still SIGTERM us if the parent test times out.
  const absolute = new Promise<void>((resolve) => setTimeout(resolve, 3_000));
  await Promise.race([closed.promise, absolute]);
  if (!responseComplete) {
    try {
      socket.shutdown();
    } catch {
      // already closed
    }
    await Promise.race([closed.promise, new Promise<void>((resolve) => setTimeout(resolve, 200))]);
  }
  return Buffer.concat(received.map((c) => Buffer.from(c))).toString("latin1");
}

function parseResponse(raw: string): object {
  const headerEnd = raw.indexOf("\r\n\r\n");
  const headText = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
  const body = headerEnd === -1 ? "" : raw.slice(headerEnd + 4);
  const [statusLine = "", ...headerLines] = headText.split("\r\n");
  const status = Number.parseInt(statusLine.split(" ")[1] ?? "0", 10);
  const headers: [string, string][] = [];
  for (const line of headerLines) {
    const sep = line.indexOf(":");
    if (sep > 0) {
      headers.push([line.slice(0, sep).trim().toLowerCase(), line.slice(sep + 1).trim()]);
    }
  }
  return { statusLine, status, headers, body };
}

const args = parseArgs(Bun.argv.slice(2));
try {
  const rawResponse = await request(args);
  process.stdout.write(`${JSON.stringify(parseResponse(rawResponse))}\n`);
} catch (error) {
  process.stderr.write(`${(error as Error).stack ?? (error as Error).message}\n`);
  process.exit(2);
}

export {};
