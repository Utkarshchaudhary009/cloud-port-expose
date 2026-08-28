import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ExposeAgent } from "../agent/client";
import { generateClientToken } from "../auth/identity";
import { CLI_DESCRIPTION, CLI_NAME } from ".";

const VERSION = "0.1.0";
const DEFAULT_CONFIG_DIR = join(homedir(), ".cloud-expose");
const DEFAULT_READINESS_TIMEOUT_MS = 10_000;

export const USAGE = `${CLI_NAME} — ${CLI_DESCRIPTION}

Usage:
  ${CLI_NAME} login [--relay <ws-url>] [--json] [--show-token]
  ${CLI_NAME} <port> [--relay <ws-url>] [--name <name>] [--token <tok>] [--json] [--detach]
  ${CLI_NAME} --version
  ${CLI_NAME} --help

Options:
  -r, --relay <url>     Relay websocket URL (or CLOUD_EXPOSE_RELAY)
  -t, --token <tok>     Client credential (or CLOUD_EXPOSE_TOKEN)
  -n, --name <name>     Stable name → https://<name>.<domain>
      --id <id>         Stable exposure id (default: random)
      --mode <mode>     Exposure access mode: open | session (default: open)
      --origin-hostname <host>
                        Host the agent dials for the origin (default: 127.0.0.1).
                        Use another container's DNS name (app) or the Docker host
                        (host.docker.internal) for container-to-host targeting.
                        IPv6 literals must be bracketed (e.g. [::1]).
      --ready-timeout   Seconds to wait for relay to confirm routable (default: 10)
      --detach          Spawn the agent in the background and return immediately
      --json            Emit exactly one JSON object on stdout
      --verbose         Structured debug logging on stderr
      --show-token      (login) include the issued client token in the JSON output
  -h, --help            Show this help
  -V, --version         Show version

Environment:
  CLOUD_EXPOSE_RELAY               Default relay WebSocket URL
  CLOUD_EXPOSE_TOKEN               Default client credential
  CLOUD_EXPOSE_ORIGIN_HOSTNAME     Default origin hostname (same as --origin-hostname)
  CLOUD_EXPOSE_CONFIG              Override config directory (default: ~/.cloud-expose)
  CLOUD_EXPOSE_LOAD_PERSISTED_TOKEN Set to 1 to auto-load the persisted login token.
                                   Off by default because Phase 6's local-mode
                                   login produces a token that is not registered
                                   with any relay's authStore.
`;

export interface ParsedArgs {
  subcommand: string | null;
  port: number | undefined;
  relay: string | undefined;
  token: string | undefined;
  exposureId: string | undefined;
  exposureName: string | undefined;
  originHostname: string | undefined;
  mode: "open" | "session" | string | undefined;
  json: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
  detach: boolean;
  showToken: boolean;
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
    originHostname: undefined,
    mode: undefined,
    json: false,
    verbose: false,
    help: false,
    version: false,
    detach: false,
    readyTimeoutMs: DEFAULT_READINESS_TIMEOUT_MS,
    showToken: false,
  };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === undefined) continue;
    // Normalize `--flag=value` to the equivalent two-arg form so the switch
    // below doesn't fall through to the default branch and silently drop the
    // value (regression: previously only `--flag value` worked).
    let inlineValue: string | null = null;
    if (arg.startsWith("--") && arg.includes("=")) {
      const eq = arg.indexOf("=");
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const takeValue = (): string => {
      if (inlineValue !== null) return inlineValue;
      const raw = argv[++i];
      if (raw === undefined) return "";
      return raw.startsWith("=") ? raw.slice(1) : raw;
    };
    switch (arg) {
      case "--relay":
      case "-r":
        parsed.relay = takeValue();
        break;
      case "--token":
      case "-t":
        parsed.token = takeValue();
        break;
      case "--id":
        parsed.exposureId = takeValue();
        break;
      case "--name":
      case "-n":
        parsed.exposureName = takeValue();
        break;
      case "--origin-hostname":
        parsed.originHostname = takeValue();
        break;
      case "--mode":
        parsed.mode = takeValue();
        break;
      case "--ready-timeout": {
        const raw = takeValue();
        if (raw === "") break;
        const seconds = Number.parseFloat(raw);
        if (Number.isFinite(seconds) && seconds > 0) {
          parsed.readyTimeoutMs = Math.floor(seconds * 1000);
        }
        break;
      }
      case "--json":
        parsed.json = true;
        break;
      case "--show-token":
        parsed.showToken = true;
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

/**
 * Bare hostname, IPv4 literal, or bracketed IPv6 literal only — no scheme,
 * path, port, whitespace, or control characters (§7: reject malformed hostnames
 * and routing identifiers). Allows RFC-1123 style labels plus the `_` character
 * found in Docker compose service DNS names.
 *
 * IPv6 must be written with brackets (`[::1]`, `[fe80::1]`) because the agent
 * dials the origin as `{scheme}://${host}:${port}`, which is valid for IPv6 only
 * in its bracketed form. Bare `::1` is therefore rejected.
 */
const MAX_IPV6_HEX_GROUPS = 8;
const IPV4_DOTTED_QUAD =
  /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isValidIpv6Group(group: string): boolean {
  return /^[0-9A-Fa-f]{1,4}$/.test(group);
}

function isValidIpv6Segment(segment: string): boolean {
  if (segment === "") return true;
  const parts = segment.split(":");
  // IPv4-mapped IPv6 (RFC 4291 §2.5.5.2): the last 32 bits are a dotted-quad.
  const last = parts[parts.length - 1];
  if (last !== undefined && IPV4_DOTTED_QUAD.test(last)) {
    const hexParts = parts.slice(0, -1);
    if (hexParts.length === 0) return true;
    return hexParts.every(isValidIpv6Group);
  }
  return parts.every(isValidIpv6Group);
}

function isBracketedIpv6(value: string): boolean {
  if (value.length < 3 || value[0] !== "[" || value[value.length - 1] !== "]") return false;
  const inner = value.slice(1, -1);
  if (inner === "" || !/^[0-9A-Fa-f:.]+$/.test(inner)) return false;
  const hasDouble = inner.includes("::");

  // "::" may appear exactly once.
  if (hasDouble && inner.indexOf("::", inner.indexOf("::") + 2) !== -1) return false;

  if (!hasDouble) {
    // Uncompressed form: exactly 8 hex groups, OR 6 hex groups + IPv4 tail.
    const parts = inner.split(":");
    const last = parts[parts.length - 1];
    if (last !== undefined && IPV4_DOTTED_QUAD.test(last)) {
      return parts.length === 7 && parts.slice(0, -1).every(isValidIpv6Group);
    }
    return parts.length === MAX_IPV6_HEX_GROUPS && parts.every(isValidIpv6Group);
  }

  // Compressed form: "::" stands for one or more runs of zeroes, so the written
  // groups left and right of it must sum to fewer than 8.
  const parts = inner.split("::");
  const left = parts[0] ?? "";
  const right = parts[1] ?? "";
  const writtenGroups = (segment: string): number => {
    if (segment === "") return 0;
    const segParts = segment.split(":");
    const last = segParts[segParts.length - 1];
    if (last !== undefined && IPV4_DOTTED_QUAD.test(last)) {
      // The dotted-quad counts as 2 IPv6 groups.
      return segParts.length + 1;
    }
    return segParts.length;
  };
  if (writtenGroups(left) + writtenGroups(right) >= MAX_IPV6_HEX_GROUPS) return false;
  // Each side must be a valid sequence of hex groups (or empty) and the IPv4
  // dotted-quad form is only allowed as the final right-side segment, never
  // embedded anywhere on the left (e.g. `[1:2:3:4:1.2.3.4::1]` is invalid).
  if (left.includes(".")) return false;
  if (!isValidIpv6Segment(left)) return false;
  if (!isValidIpv6Segment(right)) return false;
  return true;
}

export function isValidOriginHostname(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  if (value.includes(":")) return isBracketedIpv6(value);
  const label = /^[A-Za-z0-9]([A-Za-z0-9_-]{0,61}[A-Za-z0-9])?$/;
  return value.split(".").every((part) => label.test(part));
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
  mkdirSync(dirname(path), { recursive: true });
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
  const workspaceId = `wsp_${randomUUID()}`;

  // In a real deployment this would call the control plane to register the
  // workspace and return a signed credential. Until the public control plane
  // ships (Phase 10), the local flow stores a self-generated token. The user
  // is explicitly told what will happen and how to override it.
  writePersistedAuth({ clientToken, workspaceId });

  if (args.json) {
    const payload: Record<string, unknown> = {
      ok: true,
      command: "login",
      workspaceId,
      storedAt: authPath(),
      tokenEchoed: args.showToken,
      note:
        "Local-mode credential: usable for self-hosted relays that accept it. " +
        "For hosted relays, set CLOUD_EXPOSE_TOKEN with the credential issued by the control plane.",
    };
    if (args.showToken) {
      payload.clientToken = clientToken;
    } else {
      // Explicitly do NOT include the token in default JSON output. CI logs,
      // shell scrollback, and agent transcripts will pick up whatever the
      // CLI writes to stdout; the token must be opt-in.
      payload.clientTokenHint = `read from ${authPath()} (use --show-token to echo)`;
    }
    console.log(JSON.stringify(payload));
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

  const originHostname = args.originHostname ?? process.env.CLOUD_EXPOSE_ORIGIN_HOSTNAME;
  if (originHostname !== undefined && !isValidOriginHostname(originHostname)) {
    const fromEnv = args.originHostname === undefined;
    const source = fromEnv ? "CLOUD_EXPOSE_ORIGIN_HOSTNAME" : "--origin-hostname";
    return fail(
      args,
      "invalid-origin-hostname",
      `${source} must be a bare hostname, IPv4, or bracketed IPv6 literal (got "${originHostname}")`,
      "retry with --origin-hostname app (same compose network), --origin-hostname host.docker.internal, --origin-hostname [::1], or unset the env var for the default 127.0.0.1",
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
    originHostname,
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

function spawnDetached(
  args: ParsedArgs,
  relay: string,
  token: string | undefined,
): Promise<number> {
  // Pick the entry to re-exec for the detached child.
  //   - Source mode: `import.meta.dir` points at `bin/`, so the shim
  //     `bin/cloud-expose` is reachable via `../../bin/cloud-expose`. We
  //     invoke it under the current Bun runtime.
  //   - Compiled binary (e.g. inside the agent Docker image): the binary
  //     itself is the entry. The shim path does NOT exist in that image
  //     because only the compiled binary is copied into the runtime layer,
  //     so we re-exec `process.execPath` directly.
  const shimPath = join(import.meta.dir, "..", "..", "bin", "cloud-expose");
  const command = existsSync(shimPath) ? shimPath : process.execPath;
  const childArgs = [
    String(args.port),
    "--relay",
    relay,
    "--detach",
    ...(args.exposureId ? ["--id", args.exposureId] : []),
    ...(args.exposureName ? ["--name", args.exposureName] : []),
    ...(args.mode ? ["--mode", args.mode] : []),
    ...(args.originHostname ? ["--origin-hostname", args.originHostname] : []),
    ...(token ? ["--token", token] : []),
    ...(args.json ? ["--json"] : []),
    ...(args.verbose ? ["--verbose"] : []),
    "--ready-timeout",
    String(args.readyTimeoutMs / 1000),
  ];
  const child = spawn(command, childArgs, {
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
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(watchdog);
      clearInterval(checkReady);
    };
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(code);
    };
    const watchdog = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        fail(
          args,
          "detach-timeout",
          `detached child did not confirm readiness within ${args.readyTimeoutMs + 5_000}ms`,
          "re-run without --detach to see the failure inline, or increase --ready-timeout",
        ),
      );
    }, args.readyTimeoutMs + 5_000);
    watchdog.unref();

    const checkReady = setInterval(() => {
      const newlineAt = stdoutBuf.indexOf("\n");
      if (newlineAt < 0) return;
      const line = stdoutBuf.slice(0, newlineAt).trim();
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(line) as Record<string, unknown>;
      } catch {
        finish(
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
      try {
        child.unref();
      } catch {
        // already exited
      }
      if (args.json) {
        console.log(JSON.stringify({ ...payload, detached: true, pid: child.pid }));
      } else {
        if (stderrBuf.length > 0) process.stderr.write(stderrBuf);
        console.log(`✓ Detached: PID ${child.pid}`);
        console.log(`  ${(payload.url as string | undefined) ?? "(no url)"}`);
      }
      finish(0);
    }, 50);
    checkReady.unref();
  });
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
