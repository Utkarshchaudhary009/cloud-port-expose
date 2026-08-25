import { ExposeAgent } from "../../src/agent/client";

const [relayUrl, originPort, exposureId] = Bun.argv.slice(2);

if (!relayUrl || !originPort || !exposureId) {
  console.error("usage: mini-agent.ts <relayUrl> <originPort> <exposureId>");
  process.exit(1);
}

const agent = new ExposeAgent({
  relayUrl,
  originPort: Number.parseInt(originPort, 10),
  exposureId,
  logLevel: "warn",
});
await agent.connect();
const endpoint = await agent.expose();
console.log(
  JSON.stringify({ sessionId: endpoint.sessionId, hostname: endpoint.hostname, url: endpoint.url }),
);

function noteExit(reason: string): void {
  try {
    const { appendFileSync } = require("node:fs");
    appendFileSync(
      "/tmp/opencode/mini-agent-exits.log",
      `${new Date().toISOString()} pid=${process.pid} ${reason}\n`,
    );
  } catch {
    // ignore
  }
}

process.on("SIGTERM", () => {
  noteExit("sigterm");
  void agent.close().then(() => process.exit(0));
});

process.on("exit", () => {
  noteExit("exit");
});

process.on("uncaughtException", (error) => {
  noteExit(`uncaught: ${error.message}`);
  process.exit(1);
});

setInterval(() => {}, 60_000);
