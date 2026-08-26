import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ExposeAgent } from "../agent/client";
import { generateClientToken } from "../auth/identity";
import { CLI_DESCRIPTION, CLI_NAME } from ".";

const VERSION = "0.1.0";
const DEFAULT_CONFIG_DIR = join(homedir(), ".cloud-expose");
const DEFAULT_READINESS_TIMEOUT_MS = 10_000;

export const USAGE = `${CLI_NAME} — ${CLI_DESCRIPTION}

Usage:
  ${CLI_NAME} login [--relay <ws-url>] [--json]
  ${CLI_NAME} <port> [--relay <ws-url>] [--name <name>] [--token <tok>] [--json] [--detach]
  ${CLI_NAME} --version
  ${CLI_NAME} --help

Options:
  -r, --relay <url>     Relay websocket URL (or CLOUD_EXPOSE_RELAY)
  -t, --token <tok>     Client credential (or CLOUD_EXPOSE_TOKEN)
  -n, --name <name>     Stable name → https://<name>.<domain>
      --id <id>         Stable exposure id (default: random)
      --mode <mode>     Exposure access mode: open | session (default: open)
      --ready-timeout   Seconds to wait for relay to confirm routable (default: 10)
      --detach          Spawn the agent in the background and return immediately
      --json            Emit exactly one JSON object on stdout
      --verbose         Structured debug logging on stderr
  -h, --help            Show this help
  -V, --version         Show version

Environment:
  CLOUD_EXPOSE_RELAY    Default relay WebSocket URL
  CLOUD_EXPOSE_TOKEN    Default client credential
  CLOUD_EXPOSE_CONFIG   Override config directory (default: ~/.cloud-expose)
`;

export interface ParsedArgs {
  subcommand: string | null;
  port: number | undefined;
  relay: string | undefined;
  token: string | undefined;
  exposureId: string | undefined;
  exposureName: string | undefined;
  mode: "open" | "session" | string | undefined;
  json: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
  detach: boolean;
  readyTimeoutMs: number;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    subcommand: null,
    port: undefined,
    relay: undefined,
    token: undefined,
    exposureId: undefined,
    exposureName: undefined,
    mode: undefined,
    json: false,
    verbose: false,
    help: false,
    version: false,
    detach: false,
    readyTimeoutMs: DEFAULT_READINESS_TIMEOUT_MS,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "--relay":
      case "-r":
        parsed.relay = argv[++i];
        break;
      case "--token":
      case "-t":
        parsed.token = argv[++i];
        break;
      case "--id":
        parsed.exposureId = argv[++i];
        break;
      case "--name":
      case "-n":
        parsed.exposureName = argv[++i];
        break;
      case "--mode":
        parsed.mode = argv[++i];
        break;
      case "--ready-timeout": {
        let raw: string | undefined = argv[++i];
        raw = raw?.startsWith("=") ? raw.slice(1) : raw;
        if (raw === undefined || raw === "") raw = argv[++i];
        const seconds = raw === undefined ? NaN : Number.parseFloat(raw);
        if (Number.isFinite(seconds) && seconds > 0) {
          parsed.readyTimeoutMs = Math.floor(seconds * 1000);
        }
        break;
      }
      case "--json":
        parsed.json = true;
        break;
      case "--verbose":
        parsed.verbose = true;
        break;
      case "--detach":
        parsed.detach = true;
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--version":
      case "-V":
        parsed.version = true;
        break;
      default: {
        if (parsed.port === undefined && /^\d+$/.test(arg)) {
          parsed.port = Number.parseInt(arg, 10);
        } else if (parsed.subcommand === null && !arg.startsWith("-")) {
          parsed.subcommand = arg;
        } else if (!arg.startsWith("-")) {
          parsed.port = Number.NaN;
        }
      }
    }
  }
  return parsed;
}

function fail(args: ParsedArgs, code: string, message: string, nextStep: string): number {
  console.error(`✗ ${message}`);
  console.error(`  next step: ${nextStep}`);
  if (args.json) {
    console.log(JSON.stringify({ ok: false, error: { code, message, nextStep } }));
  }
  return 1;
}

function authPath(): string {
  const dir = process.env.CLOUD_EXPOSE_CONFIG ?? DEFAULT_CONFIG_DIR;
  return join(dir, "auth.json");
}

function readPersistedAuth(): { clientToken?: string; workspaceId?: string } {
  try {
    const path = authPath();
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8")) as {
      clientToken?: string;
      workspaceId?: string;
    };
  } catch {
    return {};
  }
}

function writePersistedAuth(data: { clientToken: string; workspaceId: string }): void {
  const path = authPath();
  mkdirSync(path.replace(/\/[^/]+$/, ""), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
}

async function runLogin(args: ParsedArgs): Promise<number> {
  const relay = args.relay ?? process.env.CLOUD_EXPOSE_RELAY;
  if (!relay) {
    return fail(
      args,
      "missing-relay",
      "login needs a relay URL to obtain credentials from",
      "pass --relay wss://<relay-host> or set CLOUD_EXPOSE_RELAY",
    );
  }
  const clientToken = generateClientToken();
  const workspaceId = `wsp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  // In a real deployment this would call the control plane to register the
  // workspace and return a signed credential. Until the public control plane
  // ships (Phase 10), the local flow stores a self-generated token. The user
  // is explicitly told what will happen and how to override it.
  writePersistedAuth({ clientToken, workspaceId });

  if (args.json) {
    console.log(
      JSON.stringify({
        ok: true,
        command: "login",
        workspaceId,
        clientToken,
        storedAt: authPath(),
        note:
          "Local-mode credential: usable for self-hosted relays that accept it. " +
          "For hosted relays, set CLOUD_EXPOSE_TOKEN with the credential issued by the control plane.",
      }),
    );
  } else {
    console.log(`✓ Logged in (local-mode)`);
    console.log(`  workspace: ${workspaceId}`);
    console.log(`  token stored at: ${authPath()}`);
    console.log(
      `  note: local-mode credential works for self-hosted relays. For hosted relays, run with CLOUD_EXPOSE_TOKEN=<token> instead.`,
    );
  }
  return 0;
}

async function runExpose(args: ParsedArgs, isChild: boolean): Promise<number> {
  if (
    args.port === undefined ||
    !Number.isFinite(args.port) ||
    args.port < 1 ||
    args.port > 65535
  ) {
    return fail(
      args,
      "invalid-port",
      "<port> must be an integer between 1 and 65535",
      "run `cloud-expose 3000 --relay ws://<relay-host>:<port>` with your local service's port",
    );
  }

  if (
    args.exposureName !== undefined &&
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(args.exposureName)
  ) {
    return fail(
      args,
      "invalid-name",
      "--name must be 3-63 chars: a-z0-9 with inner dashes",
      "retry with a name like 'my-app' or 'agy-usage'",
    );
  }

  if (args.mode !== undefined && args.mode !== "open" && args.mode !== "session") {
    return fail(
      args,
      "invalid-mode",
      "--mode must be 'open' or 'session'",
      "retry with --mode open (public) or --mode session (requires a browser token)",
    );
  }

  const relay = args.relay ?? process.env.CLOUD_EXPOSE_RELAY;
  if (!relay) {
    return fail(
      args,
      "missing-relay",
      "no relay URL given",
      "pass --relay ws://<relay-host>:<port> or set CLOUD_EXPOSE_RELAY",
    );
  }

  const persisted = readPersistedAuth();
  // The persisted credential is only auto-loaded when CLOUD_EXPOSE_LOAD_PERSISTED_TOKEN=1.
  // Local-mode login (Phase 6) generates a token that is NOT registered in any
  // relay's authStore, so silently reusing it against an authenticated relay
  // would fail with `invalid-token`. Phase 10's control-plane login will flip
  // the default. Until then, callers must explicitly opt in.
  const autoLoad = process.env.CLOUD_EXPOSE_LOAD_PERSISTED_TOKEN === "1";
  const token =
    args.token ?? process.env.CLOUD_EXPOSE_TOKEN ?? (autoLoad ? persisted.clientToken : undefined);

  if (args.detach && !isChild) {
    return spawnDetached(args, relay, token);
  }

  const agent = new ExposeAgent({
    relayUrl: relay,
    originPort: args.port,
    clientToken: token,
    exposureId: args.exposureId,
    exposureName: args.exposureName,
    accessMode: args.mode,
    logLevel: args.verbose ? "debug" : "info",
  });

  let endpoint: { sessionId: string; exposureId: string; hostname: string; url: string };
  try {
    await agent.connect();
    endpoint = await withTimeout(
      agent.expose(),
      args.readyTimeoutMs,
      `relay did not confirm exposure within ${args.readyTimeoutMs}ms`,
    );
  } catch (error) {
    await agent.close().catch(() => {});
    const message = (error as Error).message ?? "unknown failure";
    const code = (error as Error & { code?: string }).code ?? "expose-failed";
    return fail(
      args,
      code,
      message,
      "confirm the relay is running and reachable, then retry with --relay ws://<relay-host>:<port>",
    );
  }

  if (args.json) {
    console.log(
      JSON.stringify({
        ok: true,
        command: "expose",
        detached: args.detach && isChild,
        port: args.port,
        sessionId: endpoint.sessionId,
        exposureId: endpoint.exposureId,
        hostname: endpoint.hostname,
        url: endpoint.url,
        ...(args.detach && isChild ? { pid: process.pid } : {}),
      }),
    );
  } else {
    if (args.detach && isChild) {
      console.log(`✓ Detached: PID ${process.pid}`);
      console.log(`  ${endpoint.url}`);
    } else {
      console.log(`✓ Port ${args.port} exposed`);
      console.log(endpoint.url);
    }
  }

  const shutdown = (): void => {
    void agent.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise<void>(() => {});
  return 0;
}

function spawnDetached(args: ParsedArgs, relay: string, token: string | undefined): number {
  // Re-exec through the bin entry so the child gets the same shebang/wrapper
  // and the import.meta.main guard isn't required.
  const binPath = join(import.meta.dir, "..", "..", "bin", "cloud-expose");
  const childArgs = [
    binPath,
    String(args.port),
    "--relay",
    relay,
    "--detach",
    ...(args.exposureId ? ["--id", args.exposureId] : []),
    ...(args.exposureName ? ["--name", args.exposureName] : []),
    ...(args.mode ? ["--mode", args.mode] : []),
    ...(token ? ["--token", token] : []),
    ...(args.json ? ["--json"] : []),
    ...(args.verbose ? ["--verbose"] : []),
    "--ready-timeout",
    String(args.readyTimeoutMs / 1000),
  ];
  const child = spawn("bun", childArgs, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CLOUD_EXPOSE_DETACH_CHILD: "1" },
  });
  let stdoutBuf = "";
  let stderrBuf = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf8");
  });

  // We do NOT await the child. The child runs forever (until the tunnel is
  // closed). We only wait until the child has emitted its first JSON line so
  // we can relay the readiness confirmation to our caller.
  return new Promise<number>((resolve) => {
    const watchdog = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(
        fail(
          args,
          "detach-timeout",
          `detached child did not confirm readiness within ${args.readyTimeoutMs + 2_000}ms`,
          "re-run without --detach to see the failure inline, or increase --ready-timeout",
        ),
      );
    }, args.readyTimeoutMs + 5_000);

    const checkReady = setInterval(() => {
      const newlineAt = stdoutBuf.indexOf("\n");
      if (newlineAt >= 0) {
        clearInterval(checkReady);
        clearTimeout(watchdog);
        const line = stdoutBuf.slice(0, newlineAt).trim();
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(line) as Record<string, unknown>;
        } catch {
          resolve(
            fail(
              args,
              "detach-bad-output",
              `detached child emitted unparseable output: ${line.slice(0, 200)}`,
              "re-run without --detach for the full error",
            ),
          );
          return;
        }
        // The child is now confirmed ready and running. Detach it from us so
        // it survives our exit.
        child.unref();
        if (args.json) {
          console.log(JSON.stringify({ ...payload, detached: true, pid: child.pid }));
        } else {
          if (stderrBuf.length > 0) process.stderr.write(stderrBuf);
          console.log(`✓ Detached: PID ${child.pid}`);
          console.log(`  ${(payload.url as string | undefined) ?? "(no url)"}`);
        }
        resolve(0);
      }
    }, 50);
  }) as unknown as number;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function run(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.help) {
    if (args.json) {
      console.log(
        JSON.stringify({
          ok: true,
          command: "help",
          name: CLI_NAME,
          version: VERSION,
          description: CLI_DESCRIPTION,
          usage: USAGE,
        }),
      );
    } else {
      console.log(USAGE);
    }
    return 0;
  }
  if (args.version) {
    if (args.json) {
      console.log(
        JSON.stringify({ ok: true, command: "version", name: CLI_NAME, version: VERSION }),
      );
    } else {
      console.log(`${CLI_NAME} ${VERSION}`);
    }
    return 0;
  }

  if (args.subcommand === "login") {
    return runLogin(args);
  }

  if (args.subcommand !== null && args.subcommand !== undefined) {
    // First non-flag arg wasn't a digit (port) and isn't a known subcommand.
    // The most common cause is a typo or a forgotten <port>.
    return fail(
      args,
      "invalid-port",
      `<port> must be an integer between 1 and 65535 (got "${args.subcommand}")`,
      `run \`${CLI_NAME} 3000\` with your local service's port`,
    );
  }

  const isChild = process.env.CLOUD_EXPOSE_DETACH_CHILD === "1";
  return runExpose(args, isChild);
}

// Allow this module to be executed directly (`bun run src/cli/main.ts ...`)
// as well as imported and driven by the `bin/cloud-expose` wrapper.
const isDirectInvocation =
  import.meta.main &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("src/cli/main.ts") || process.argv[1].endsWith("src/cli/main"));
if (isDirectInvocation) {
  process.exitCode = await run(process.argv.slice(2));
}
