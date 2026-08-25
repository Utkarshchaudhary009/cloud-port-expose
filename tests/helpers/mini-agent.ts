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

try {
  await agent.connect();
} catch (error) {
  console.error(`mini-agent failed to connect: ${(error as Error).message}`);
  process.exit(1);
}
const endpoint = await agent.expose().catch((error: Error) => {
  console.error(`mini-agent failed to expose: ${error.message}`);
  process.exit(1);
});
console.log(
  JSON.stringify({ hostname: endpoint.hostname, sessionId: endpoint.sessionId, url: endpoint.url }),
);

process.on("SIGTERM", () => {
  void agent.close().then(() => process.exit(0));
});

setInterval(() => {}, 60_000);
