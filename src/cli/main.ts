import { ExposeAgent } from "../agent/client";

interface ParsedArgs {
  port?: number;
  relay?: string | undefined;
  token?: string | undefined;
  exposureId?: string | undefined;
  mode?: "open" | "session" | undefined;
  json: boolean;
  verbose: boolean;
  help: boolean;
}

const USAGE = `cloud-expose — expose a local port through a relay

Usage:
  cloud-expose <port> --relay <ws-url>

Options:
  -r, --relay <url>   Relay websocket URL (or set CLOUD_EXPOSE_RELAY)
  -t, --token <tok>   Client credential (or set CLOUD_EXPOSE_TOKEN)
      --id <id>       Stable exposure id (default: random)
      --mode <mode>   Exposure access mode: open | session (default: open)
      --json          Emit exactly one JSON object on stdout (success or failure)
      --verbose       Structured debug logging on stderr
  -h, --help          Show this help
`;

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { json: false, verbose: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--relay":
      case "-r":
        parsed.relay = argv[i + 1];
        i++;
        break;
      case "--token":
      case "-t":
        parsed.token = argv[i + 1];
        i++;
        break;
      case "--id":
        parsed.exposureId = argv[i + 1];
        i++;
        break;
      case "--mode": {
        const value = argv[i + 1];
        if (value === "open" || value === "session") {
          parsed.mode = value;
        }
        i++;
        break;
      }
      case "--json":
        parsed.json = true;
        break;
      case "--verbose":
        parsed.verbose = true;
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      default: {
        if (arg !== undefined && /^\d+$/.test(arg)) {
          parsed.port = Number.parseInt(arg, 10);
        }
      }
    }
  }
  return parsed;
}

async function run(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const emitJson = (payload: Record<string, unknown>): void => {
    if (args.json) {
      console.log(JSON.stringify(payload));
    }
  };
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  if (args.port === undefined || args.port < 1 || args.port > 65535) {
    console.error("✗ error: <port> must be an integer between 1 and 65535");
    console.error(
      "  next step: run `cloud-expose 3000 --relay ws://<relay-host>:<port>` with your local service's port",
    );
    emitJson({
      ok: false,
      error: {
        code: "invalid-port",
        message: "<port> must be an integer between 1 and 65535",
        nextStep:
          "run `cloud-expose 3000 --relay ws://<relay-host>:<port>` with your local service's port",
      },
    });
    return 1;
  }

  const relayUrl = args.relay ?? process.env.CLOUD_EXPOSE_RELAY;
  if (!relayUrl) {
    console.error("✗ error: no relay URL given");
    console.error(
      "  next step: pass --relay ws://<relay-host>:<port> or set the CLOUD_EXPOSE_RELAY environment variable",
    );
    emitJson({
      ok: false,
      error: {
        code: "missing-relay",
        message: "no relay URL given",
        nextStep:
          "pass --relay ws://<relay-host>:<port> or set the CLOUD_EXPOSE_RELAY environment variable",
      },
    });
    return 1;
  }

  const clientToken = args.token ?? process.env.CLOUD_EXPOSE_TOKEN ?? undefined;
  if (clientToken === undefined && process.env.CLOUD_EXPOSE_REQUIRE_AUTH === "1") {
    console.error("✗ error: this relay requires a client credential");
    console.error(
      "  next step: pass --token <cpx_...> or set CLOUD_EXPOSE_TOKEN with your workspace credential",
    );
    return 1;
  }
  const agent = new ExposeAgent({
    relayUrl,
    originPort: args.port,
    clientToken,
    exposureId: args.exposureId,
    accessMode: args.mode,
    logLevel: args.verbose ? "debug" : "info",
  });
  try {
    await agent.connect();
    const endpoint = await agent.expose();
    if (args.json) {
      console.log(
        JSON.stringify({
          ok: true,
          command: "expose",
          port: args.port,
          sessionId: endpoint.sessionId,
          exposureId: endpoint.exposureId,
          hostname: endpoint.hostname,
          url: endpoint.url,
        }),
      );
    } else {
      console.log(`✓ Port ${args.port} exposed`);
      console.log(endpoint.url);
    }
  } catch (error) {
    await agent.close().catch(() => {});
    const message = (error as Error).message ?? "unknown failure";
    const nextStep =
      "confirm the relay is running and reachable, then retry with --relay ws://<relay-host>:<port>";
    console.error(`✗ ${message}`);
    console.error(`  next step: ${nextStep}`);
    emitJson({ ok: false, error: { code: "expose-failed", message, nextStep } });
    return 1;
  }

  const shutdown = (): void => {
    void agent.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise<void>(() => {});
  return 0;
}

process.exitCode = await run();
