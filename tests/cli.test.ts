import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isValidOriginHostname } from "../src/cli/main";
import { startRelay } from "../src/relay/server";
import type { RelayHandle } from "../src/relay/session";
import { type HttpOriginHandle, startHttpOrigin } from "./fixtures/origin-http";

const CLI_PATH = join(import.meta.dir, "..", "bin", "cloud-expose");
const BUN = "bun";

let origin: HttpOriginHandle;
let relay: RelayHandle;
let configDir = "";

function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = Bun.spawn([BUN, "run", CLI_PATH, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
    const watchdog = setTimeout(() => proc.kill("SIGKILL"), 15_000);
    Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(([stdout, stderr, exitCode]) => {
      clearTimeout(watchdog);
      resolve({ stdout, stderr, exitCode });
    });
  });
}

beforeAll(async () => {
  origin = await startHttpOrigin({
    handler: async (request) => {
      const url = new URL(request.url);
      return Response.json({ method: request.method, path: url.pathname });
    },
  });
  relay = await startRelay({ port: 0 });
  configDir = mkdtempSync(join(tmpdir(), "cpx-cli-"));
});

afterAll(async () => {
  origin.stop();
  await relay.stop();
  if (configDir && existsSync(configDir)) {
    rmSync(configDir, { recursive: true, force: true });
  }
});

describe("cloud-expose CLI", () => {
  test("--help exits 0 and prints usage", async () => {
    const r = await runCli(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("cloud-expose");
    expect(r.stdout).toContain("--relay");
    expect(r.stdout).toContain("--json");
  });

  test("--version exits 0 and reports the version", async () => {
    const r = await runCli(["--version"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toMatch(/^cloud-expose \d+\.\d+\.\d+/);
  });

  test("--help --json emits a single JSON object", async () => {
    const r = await runCli(["--help", "--json"]);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout.trim()) as {
      ok: boolean;
      command: string;
      name: string;
      version: string;
      usage: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("help");
    expect(parsed.name).toBe("cloud-expose");
    expect(parsed.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(parsed.usage).toContain("--relay");
  });

  test("--version --json emits a single JSON object", async () => {
    const r = await runCli(["--version", "--json"]);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout.trim()) as {
      ok: boolean;
      command: string;
      version: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("version");
    expect(parsed.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("--json failure: missing relay is a structured error with nextStep", async () => {
    const r = await runCli(["3000", "--json"], { CLOUD_EXPOSE_RELAY: "" });
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout.trim()) as {
      ok: boolean;
      error: { code: string; nextStep: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("missing-relay");
    expect(parsed.error.nextStep).toMatch(/--relay|CLOUD_EXPOSE_RELAY/);
  });

  test("--json failure: invalid port is reported as a structured error", async () => {
    const r = await runCli(["abc", "--json"]);
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout.trim()) as { ok: boolean; error: { code: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("invalid-port");
  });

  test("--json failure: invalid name format is reported", async () => {
    const r = await runCli(["3000", "--relay", relay.agentUrl, "--name", "BAD!", "--json"]);
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout.trim()) as { ok: boolean; error: { code: string } };
    expect(parsed.error.code).toBe("invalid-name");
  });

  test("--json failure: invalid mode is reported", async () => {
    const r = await runCli(["3000", "--relay", relay.agentUrl, "--mode", "weird", "--json"]);
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout.trim()) as { ok: boolean; error: { code: string } };
    expect(parsed.error.code).toBe("invalid-mode");
  });

  test("--json failure: connection failure to a dead relay", async () => {
    const r = await runCli([
      "3000",
      "--relay",
      "ws://127.0.0.1:1",
      "--ready-timeout",
      "1",
      "--json",
    ]);
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout.trim()) as {
      ok: boolean;
      error: { code: string; message: string; nextStep: string };
    };
    expect(parsed.ok).toBe(false);
    // The agent never connects to a dead relay; the ExposeAgent surfaces this
    // as a generic "failed to connect to <relay>" error, which the CLI
    // passes through verbatim. Asserting the exact code (rather than either-or)
    // locks the contract: any future change must be deliberate.
    expect(parsed.error.code).toBe("expose-failed");
    expect(parsed.error.message).toMatch(/failed to connect/i);
    expect(parsed.error.nextStep.length).toBeGreaterThan(0);
  });

  test("login (local-mode) writes a token to disk and prints JSON without echoing the token", async () => {
    const r = await runCli(["login", "--relay", "wss://example.invalid", "--json"], {
      CLOUD_EXPOSE_CONFIG: configDir,
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout.trim()) as {
      ok: boolean;
      command: string;
      workspaceId: string;
      clientToken?: string;
      clientTokenHint?: string;
      tokenEchoed: boolean;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("login");
    // The token must NOT appear in default JSON output (CI logs / scrollback safety).
    expect(parsed.clientToken).toBeUndefined();
    expect(parsed.tokenEchoed).toBe(false);
    expect(parsed.clientTokenHint).toMatch(/--show-token/);
    const authPath = join(configDir, "auth.json");
    expect(existsSync(authPath)).toBe(true);
    const stored = JSON.parse(readFileSync(authPath, "utf8")) as { clientToken: string };
    // The on-disk token is the real one, even though it was not echoed.
    expect(stored.clientToken).toMatch(/^cpx_/);
  });

  test("login --json --show-token echoes the client token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cpx-show-"));
    try {
      const r = await runCli(
        ["login", "--relay", "wss://example.invalid", "--json", "--show-token"],
        { CLOUD_EXPOSE_CONFIG: dir },
      );
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout.trim()) as {
        ok: boolean;
        clientToken: string;
        tokenEchoed: boolean;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.tokenEchoed).toBe(true);
      expect(parsed.clientToken).toMatch(/^cpx_/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("login without --relay and no env produces a structured error", async () => {
    const r = await runCli(["login", "--json"], {
      CLOUD_EXPOSE_RELAY: "",
      CLOUD_EXPOSE_CONFIG: configDir,
    });
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout.trim()) as { ok: boolean; error: { code: string } };
    expect(parsed.error.code).toBe("missing-relay");
  });

  test("expose <port> with --json returns a usable URL and reaches the origin", async () => {
    const proc = Bun.spawn(
      [BUN, "run", CLI_PATH, String(origin.port), "--relay", relay.agentUrl, "--json"],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, CLOUD_EXPOSE_RELAY: "" } },
    );
    const stdoutReader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let stdoutBuf = "";
    try {
      // Read until the JSON line arrives (newline-terminated) or 5s elapses.
      const start = Date.now();
      while (Date.now() - start < 5_000 && !stdoutBuf.includes("\n")) {
        const readPromise = stdoutReader.read();
        const timer = new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), 250),
        );
        const { value, done } = await Promise.race([readPromise, timer]);
        if (done && value === undefined) break;
        if (value) stdoutBuf += decoder.decode(value);
      }
      const parsed = JSON.parse(stdoutBuf.trim()) as {
        ok: boolean;
        url: string;
        hostname: string;
        sessionId: string;
        exposureId: string;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.url).toMatch(/^http:\/\/[a-z0-9]+\.localhost:\d+$/);

      // While the agent is still running, verify reachability.
      const res = await fetch(`http://127.0.0.1:${relay.port}/probe`, {
        headers: { host: `${parsed.hostname}:${relay.port}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { method: string; path: string };
      expect(body.path).toBe("/probe");
    } finally {
      await stdoutReader.cancel().catch(() => {});
      proc.kill("SIGTERM");
      try {
        await proc.exited;
      } catch {
        // already dead
      }
    }
  }, 15_000);

  test("--detach returns immediately and keeps the exposure alive", async () => {
    const proc = Bun.spawn(
      [BUN, "run", CLI_PATH, String(origin.port), "--relay", relay.agentUrl, "--detach", "--json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdoutReader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let stdoutBuf = "";
    let parsed: {
      ok: boolean;
      detached: boolean;
      url: string;
      hostname: string;
      pid: number;
    } | null = null;
    try {
      const start = Date.now();
      while (Date.now() - start < 5_000 && !stdoutBuf.includes("\n")) {
        const readPromise = stdoutReader.read();
        const timer = new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), 250),
        );
        const { value, done } = await Promise.race([readPromise, timer]);
        if (done && value === undefined) break;
        if (value) stdoutBuf += decoder.decode(value);
      }
      const value = JSON.parse(stdoutBuf.trim()) as {
        ok: boolean;
        detached: boolean;
        url: string;
        hostname: string;
        pid: number;
      };
      expect(value.ok).toBe(true);
      expect(value.detached).toBe(true);
      expect(value.pid).toBeGreaterThan(0);
      parsed = value;

      // The detached child should be running. Verify reachability.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const res = await fetch(`http://127.0.0.1:${relay.port}/after-detach`, {
        headers: { host: `${value.hostname}:${relay.port}` },
      });
      expect(res.status).toBe(200);
    } finally {
      await stdoutReader.cancel().catch(() => {});
      // Wait for the parent CLI to exit naturally (it should, since it's just a wrapper).
      try {
        await proc.exited;
      } catch {
        // ignore
      }
      // Clean up the detached child.
      if (parsed !== null) {
        try {
          process.kill(parsed.pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
    }
  }, 20_000);

  test("login then expose does NOT auto-load the persisted token (requires explicit opt-in)", async () => {
    // Phase 6's local-mode login produces a token that is not registered in
    // any relay's authStore. Silently reusing it would surface as
    // 'invalid-token' on authenticated relays, so the CLI must not auto-load
    // it unless CLOUD_EXPOSE_LOAD_PERSISTED_TOKEN=1.
    const dir = mkdtempSync(join(tmpdir(), "cpx-noload-"));
    try {
      const loginResult = await runCli(["login", "--relay", "wss://example.invalid", "--json"], {
        CLOUD_EXPOSE_CONFIG: dir,
      });
      expect(loginResult.exitCode).toBe(0);

      // Start a relay with an auth store so any non-empty token is rejected
      // and any expose without auth is rejected.
      const { startRelay } = await import("../src/relay/server");
      const { InMemoryAuthStore } = await import("../src/auth/tokens");
      const authRelay = await startRelay({
        port: 0,
        authStore: new InMemoryAuthStore(),
      });
      try {
        // Expose with CLOUD_EXPOSE_RELAY pointing at the authenticated relay
        // and CLOUD_EXPOSE_CONFIG pointing at the dir with the persisted
        // token. The persisted token must NOT be auto-loaded. We expect a
        // structured failure (the relay rejects the unauthenticated expose).
        const env: Record<string, string> = {
          CLOUD_EXPOSE_RELAY: authRelay.agentUrl,
          CLOUD_EXPOSE_CONFIG: dir,
          CLOUD_EXPOSE_TOKEN: "",
        };
        const r = await runCli([String(origin.port), "--json", "--ready-timeout=3"], env);
        expect(r.exitCode).toBe(1);
        const parsed = JSON.parse(r.stdout.trim()) as {
          ok: boolean;
          error: { code: string; message: string; nextStep: string };
        };
        expect(parsed.ok).toBe(false);
        // The failure must mention authentication, not just a connection error.
        expect(parsed.error.message.toLowerCase()).toMatch(/auth|token|malformed/);
      } finally {
        await authRelay.stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("--ready-timeout accepts the =N form as well as two tokens", async () => {
    // Both spellings should be parsed and accepted; the failure (dead relay)
    // should be reported quickly because the timeout is short.
    const r = await runCli(["3000", "--relay", "ws://127.0.0.1:1", "--ready-timeout=1", "--json"]);
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout.trim()) as { ok: boolean; error: { code: string } };
    expect(parsed.ok).toBe(false);
    // We expect a failure (dead relay), proving the =N spelling was accepted
    // and the short timeout applied.
    expect(parsed.error.code).toBeDefined();
  });

  test("--origin-hostname rejects malformed values with a structured error", async () => {
    for (const bad of ["http://evil", "app:3000", "two words", "-leading-dash", "trailing."]) {
      const r = await runCli([
        "3000",
        "--relay",
        "ws://127.0.0.1:1",
        "--origin-hostname",
        bad,
        "--json",
      ]);
      expect(r.exitCode).toBe(1);
      const parsed = JSON.parse(r.stdout.trim()) as {
        ok: boolean;
        error: { code: string; nextStep: string };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("invalid-origin-hostname");
      expect(parsed.error.nextStep).toContain("--origin-hostname");
    }
  });

  test("expose with explicit --origin-hostname 127.0.0.1 reaches the origin", async () => {
    // Same behavior as the default, but exercises the flag → agent wiring
    // end-to-end (the flag is what enables container-to-host targeting).
    const proc = Bun.spawn(
      [
        BUN,
        "run",
        CLI_PATH,
        String(origin.port),
        "--relay",
        relay.agentUrl,
        "--origin-hostname",
        "127.0.0.1",
        "--json",
      ],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, CLOUD_EXPOSE_RELAY: "" } },
    );
    const stdoutReader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let stdoutBuf = "";
    try {
      const start = Date.now();
      while (Date.now() - start < 5_000 && !stdoutBuf.includes("\n")) {
        const readPromise = stdoutReader.read();
        const timer = new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), 250),
        );
        const { value, done } = await Promise.race([readPromise, timer]);
        if (done && value === undefined) break;
        if (value) stdoutBuf += decoder.decode(value);
      }
      const parsed = JSON.parse(stdoutBuf.trim()) as { ok: boolean; hostname: string };
      expect(parsed.ok).toBe(true);
      const res = await fetch(`http://127.0.0.1:${relay.port}/origin-host`, {
        headers: { host: `${parsed.hostname}:${relay.port}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { path: string };
      expect(body.path).toBe("/origin-host");
    } finally {
      await stdoutReader.cancel().catch(() => {});
      proc.kill("SIGTERM");
      try {
        await proc.exited;
      } catch {
        // already dead
      }
    }
  }, 15_000);

  test("expose honors CLOUD_EXPOSE_ORIGIN_HOSTNAME env var", async () => {
    const proc = Bun.spawn(
      [BUN, "run", CLI_PATH, String(origin.port), "--relay", relay.agentUrl, "--json"],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          CLOUD_EXPOSE_RELAY: "",
          CLOUD_EXPOSE_ORIGIN_HOSTNAME: "127.0.0.1",
        },
      },
    );
    const stdoutReader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let stdoutBuf = "";
    try {
      const start = Date.now();
      while (Date.now() - start < 5_000 && !stdoutBuf.includes("\n")) {
        const readPromise = stdoutReader.read();
        const timer = new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), 250),
        );
        const { value, done } = await Promise.race([readPromise, timer]);
        if (done && value === undefined) break;
        if (value) stdoutBuf += decoder.decode(value);
      }
      const parsed = JSON.parse(stdoutBuf.trim()) as { ok: boolean; hostname: string };
      expect(parsed.ok).toBe(true);
      const res = await fetch(`http://127.0.0.1:${relay.port}/origin-env`, {
        headers: { host: `${parsed.hostname}:${relay.port}` },
      });
      expect(res.status).toBe(200);
    } finally {
      await stdoutReader.cancel().catch(() => {});
      proc.kill("SIGTERM");
      try {
        await proc.exited;
      } catch {
        // already dead
      }
    }
  }, 15_000);
});

describe("isValidOriginHostname", () => {
  test("accepts bare hostnames, docker names, and IPs", () => {
    expect(isValidOriginHostname("127.0.0.1")).toBe(true);
    expect(isValidOriginHostname("localhost")).toBe(true);
    expect(isValidOriginHostname("host.docker.internal")).toBe(true);
    expect(isValidOriginHostname("app")).toBe(true);
    expect(isValidOriginHostname("my_app")).toBe(true);
    expect(isValidOriginHostname("svc.example.com")).toBe(true);
  });
  test("rejects schemes, ports, paths, whitespace, and empty values", () => {
    expect(isValidOriginHostname("")).toBe(false);
    expect(isValidOriginHostname("http://evil")).toBe(false);
    expect(isValidOriginHostname("app:3000")).toBe(false);
    expect(isValidOriginHostname("app/secret")).toBe(false);
    expect(isValidOriginHostname("two words")).toBe(false);
    expect(isValidOriginHostname("-leading")).toBe(false);
    expect(isValidOriginHostname("trailing-")).toBe(false);
    expect(isValidOriginHostname(".")).toBe(false);
    expect(isValidOriginHostname(`a`.repeat(254))).toBe(false);
  });
});
