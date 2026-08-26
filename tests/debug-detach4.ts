// tests/debug-detach4.ts
import { startRelay } from "../src/relay/server";
import { spawn } from "node:child_process";

const relay = await startRelay({ port: 0 });
const origin = Bun.serve({ port: 0, fetch: () => new Response("ok") });
const originPort = origin.port;

const child = spawn(
  "bun",
  ["run", "src/cli/main.ts", String(originPort), "--relay", relay.agentUrl, "--detach", "--json", "--verbose"],
  {
    env: { ...process.env, CLOUD_EXPOSE_DETACH_CHILD: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout.on("data", (c: Buffer) => process.stdout.write("[OUT] " + c));
child.stderr.on("data", (c: Buffer) => process.stdout.write("[ERR] " + c));

await new Promise((r) => setTimeout(r, 3000));
console.log("\n[debug] child killed=" + child.killed);
child.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 200));
await relay.stop();
origin.stop();
process.exit(0);
