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
    Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(
      ([stdout, stderr, exitCode]) => {
        clearTimeout(watchdog);
        resolve({ stdout, stderr, exitCode });
      },
    );
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
    const parsed = JSON.parse(r.stdout.trim()) as { ok: boolean; error: { code: string; nextStep: string } };
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
    const r = await runCli(["3000", "--relay", "ws://127.0.0.1:1", "--ready-timeout", "1", "--json"]);
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout.trim()) as { ok: boolean; error: { code: string; nextStep: string } };
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
    // Read until the first complete JSON line appears on stdout, then SIGTERM.
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    let stdoutBuf = "";
    const decoder = new TextDecoder();
    let exitCode = 0;
    try {
      // Read for up to 5s waiting for JSON.
      const start = Date.now();
      while (Date.now() - start < 5_000) {
        const readPromise = reader.read();
        const timer = new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), 500),
        );
        const { value, done } = await Promise.race([readPromise, timer]);
        if (done && value === undefined) break;
        if (value) {
          stdoutBuf += decoder.decode(value);
          if (stdoutBuf.includes("\n")) break;
        }
      }
    } finally {
      reader.cancel().catch(() => {});
      proc.kill("SIGTERM");
      try {
        exitCode = await proc.exited;
      } catch {
        exitCode = -1;
      }
    }
    expect(exitCode === 0 || exitCode === 143 || exitCode === 137).toBe(true);
    const parsed = JSON.parse(stdoutBuf.trim().split("\n").pop() ?? "{}") as {
      ok: boolean;
      url: string;
      hostname: string;
      sessionId: string;
      exposureId: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.url).toMatch(/^http:\/\/[a-z0-9]+\.localhost:\d+$/);

    const res = await fetch(`http://127.0.0.1:${relay.port}/probe`, {
      headers: { host: `${parsed.hostname}:${relay.port}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { method: string; path: string };
    expect(body.path).toBe("/probe");
  }, 15_000);

  test("--detach returns immediately and keeps the exposure alive", async () => {
    const proc = Bun.spawn(
      [BUN, "run", CLI_PATH, String(origin.port), "--relay", relay.agentUrl, "--detach", "--json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    // The parent CLI should print JSON and exit 0 quickly. Read until the JSON
    // line arrives, then wait for process exit.
    const stdoutReader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const errReader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    let stdoutBuf = "";
    const decoder = new TextDecoder();
    const stderrChunks: string[] = [];
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const timer = new Promise<{ value: undefined; done: true }>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: true }), 200),
      );
      const { value, done } = await Promise.race([stdoutReader.read(), timer]);
      if (done && value === undefined) break;
      if (value) {
        stdoutBuf += decoder.decode(value);
        if (stdoutBuf.includes("\n")) break;
      }
    }
    while (Date.now() < deadline) {
      const r = await Promise.race([errReader.read(), new Promise<void>((resolve) => setTimeout(resolve, 300))]);
      if (r.done || !r.value) break;
      stderrChunks.push(decoder.decode(r.value));
    }
    await errReader.cancel().catch(() => {});
    await stdoutReader.cancel().catch(() => {});

    const exitCode = await proc.exited;
    const stderr = stderrChunks.join("");
    expect(exitCode).toBe(0);
    if (exitCode !== 0 || !stdoutBuf.includes("ok")) {
      throw new Error(`detach parent failed (exit ${exitCode}); stdout=${stdoutBuf}; stderr=${stderr}`);
    }
    const parsed = JSON.parse(stdoutBuf.trim().split("\n").pop() ?? "{}") as {
      ok: boolean;
      detached: boolean;
      url: string;
      hostname: string;
      pid: number;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.detached).toBe(true);
    expect(parsed.pid).toBeGreaterThan(0);

    // Give the detached child a beat to register.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const res = await fetch(`http://127.0.0.1:${relay.port}/after-detach`, {
      headers: { host: `${parsed.hostname}:${relay.port}` },
    });
    if (res.status !== 200) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `detached exposure not reachable: status=${res.status} body=${body} stderr=${stderr}`,
      );
    }
    expect(res.status).toBe(200);

    // Clean up the detached child.
    try {
      process.kill(parsed.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }, 20_000);
});
