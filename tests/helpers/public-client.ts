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
    } else if (arg !== undefined) {
      pathWithQuery = arg;
    }
  }
  return { host, port, pathWithQuery, method, body, headers };
}

async function request(args: Args): Promise<string> {
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
  const closed = Promise.withResolvers<void>();
  const socket = await Bun.connect({
    hostname:
      args.host === "localhost" || args.host.endsWith(".localhost") ? "127.0.0.1" : args.host,
    port: args.port,
    socket: {
      data(_socket, data) {
        received.push(data);
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
  await closed.promise;
  try {
    socket.end();
  } catch {
    // already closed
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
const rawResponse = await request(args);
console.log(JSON.stringify(parseResponse(rawResponse)));

export {};
