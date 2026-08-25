import { ExposeAgent } from "../agent/client";

interface ParsedArgs {
  port?: number;
  relay?: string | undefined;
  verbose: boolean;
  help: boolean;
}

const USAGE = `cloud-expose — expose a local port through a relay

Usage:
  cloud-expose <port> --relay <ws-url>

Options:
  -r, --relay <url>   Relay websocket URL (or set CLOUD_EXPOSE_RELAY)
      --verbose       Structured debug logging on stderr
  -h, --help          Show this help
`;

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { verbose: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--relay":
      case "-r":
        parsed.relay = argv[i + 1];
        i++;
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
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  if (args.port === undefined || args.port < 1 || args.port > 65535) {
    console.error("✗ error: <port> must be an integer between 1 and 65535");
    console.error(
      "  next step: run `cloud-expose 3000 --relay ws://<relay-host>:<port>` with your local service's port",
    );
    return 1;
  }
  if (!args.relay) {
    console.error("✗ error: no relay URL given");
    console.error(
      "  next step: pass --relay ws://<relay-host>:<port> or set the CLOUD_EXPOSE_RELAY environment variable",
    );
    return 1;
  }

  const agent = new ExposeAgent({
    relayUrl: args.relay,
    originPort: args.port,
    logLevel: args.verbose ? "debug" : "info",
  });
  try {
    await agent.connect();
    const endpoint = await agent.expose();
    console.log(`✓ Port ${args.port} exposed`);
    console.log(endpoint.url);
  } catch (error) {
    await agent.close().catch(() => {});
    console.error(`✗ ${(error as Error).message}`);
    console.error(
      "  next step: confirm the relay is running and reachable, then retry with --relay ws://<relay-host>:<port>",
    );
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
