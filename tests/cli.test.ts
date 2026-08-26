import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      error: { code: string; nextStep: string };
    };
    expect(parsed.ok).toBe(false);
    expect(["expose-failed", "connect-timeout"]).toContain(parsed.error.code);
    expect(parsed.error.nextStep.length).toBeGreaterThan(0);
  });

  test("login (local-mode) writes a token to disk and prints JSON", async () => {
    const r = await runCli(["login", "--relay", "wss://example.invalid", "--json"], {
      CLOUD_EXPOSE_CONFIG: configDir,
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout.trim()) as {
      ok: boolean;
      command: string;
      workspaceId: string;
      clientToken: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("login");
    expect(parsed.clientToken).toMatch(/^cpx_/);
    const authPath = join(configDir, "auth.json");
    expect(existsSync(authPath)).toBe(true);
    const stored = JSON.parse(readFileSync(authPath, "utf8")) as { clientToken: string };
    expect(stored.clientToken).toBe(parsed.clientToken);
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
});
