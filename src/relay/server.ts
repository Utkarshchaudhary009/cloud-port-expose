import type { ServerWebSocket } from "bun";
import { filterRequestHeaders, headersToEntries } from "../util/http";
import { createLogger, type Logger } from "../util/logger";
import type { BridgeInfo } from "./session";
import { AgentConnection, errorResponse, type RelayHandle, type RelayOptions } from "./session";

const DEFAULT_DOMAIN = "localhost";
const DEFAULT_AGENT_PATH = "/___agent";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;
const MAX_PERSISTED_SLUGS = 1000;

interface PublicBridgeData {
  bridge?: { owner: AgentConnection; info: BridgeInfo };
}

interface ExposureBinding {
  hostname: string;
  exposureId: string;
  owner: AgentConnection;
}

export function startRelay(options: RelayOptions = {}): Promise<RelayHandle> {
  const domain = (options.domain ?? DEFAULT_DOMAIN).toLowerCase();
  const agentPath = options.agentPath ?? DEFAULT_AGENT_PATH;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const log: Logger = createLogger({ subsystem: "relay", level: options.logLevel });

  const activeHostnames = new Map<string, ExposureBinding>();
  const hostnameByExposure = new Map<string, string>();
  const connections = new WeakMap<ServerWebSocket<unknown>, AgentConnection>();
  let portSuffix = "";

  const deps = {
    domain,
    requestTimeoutMs,
    heartbeatIntervalMs,
    log,
    buildPublicUrl: (hostname: string) => `http://${hostname}${portSuffix}`,
    registerExposure: (hostname: string, owner: AgentConnection): boolean => {
      const existing = activeHostnames.get(hostname);
      if (existing && existing.owner !== owner) {
        return false;
      }
      activeHostnames.set(hostname, { hostname, exposureId: "", owner });
      return true;
    },
    unregisterExposure: (hostname: string, owner: AgentConnection): void => {
      const binding = activeHostnames.get(hostname);
      if (binding && binding.owner === owner) {
        activeHostnames.delete(hostname);
      }
    },
    lookupExposureHostname: (exposureId: string): string | undefined =>
      hostnameByExposure.get(exposureId),
    rememberExposureHostname: (exposureId: string, hostname: string): void => {
      // Refresh insertion order so the oldest entry is evicted first below.
      hostnameByExposure.delete(exposureId);
      hostnameByExposure.set(exposureId, hostname);
      const binding = activeHostnames.get(hostname);
      if (binding) {
        binding.exposureId = exposureId;
      }
      if (hostnameByExposure.size > MAX_PERSISTED_SLUGS) {
        const oldest = hostnameByExposure.keys().next().value;
        if (oldest !== undefined) {
          hostnameByExposure.delete(oldest);
        }
      }
    },
    forgetExposureHostname: (exposureId: string): void => {
      hostnameByExposure.delete(exposureId);
    },
    releaseAll: (owner: AgentConnection): void => {
      for (const [hostname, binding] of [...activeHostnames.entries()]) {
        if (binding.owner === owner) {
          activeHostnames.delete(hostname);
          log.info("exposure offline", { hostname, exposureId: binding.exposureId });
        }
      }
    },
    isExposureTakenByOther: (exposureId: string, self: AgentConnection): boolean => {
      const hostname = hostnameByExposure.get(exposureId);
      if (!hostname) {
        return false;
      }
      const binding = activeHostnames.get(hostname);
      return binding !== undefined && binding.owner !== self;
    },
  };

  const server = Bun.serve<PublicBridgeData>({
    port: options.port ?? 0,
    hostname: options.hostname ?? "127.0.0.1",
    idleTimeout: 255,
    async fetch(request, server): Promise<Response | undefined> {
      const url = new URL(request.url);
      const isUpgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
      if (isUpgrade && url.pathname === agentPath) {
        const upgraded = server.upgrade(request, { data: {} });
        if (!upgraded) {
          return new Response("websocket upgrade failed", { status: 500 });
        }
        return undefined;
      }
      const hostHeader = request.headers.get("host");
      if (!hostHeader) {
        return errorResponse(400, "bad-host");
      }
      const host = hostHeader.split(":")[0]?.toLowerCase() ?? "";
      if (!host.endsWith(`.${domain}`)) {
        return errorResponse(404, "no-route");
      }
      const slug = host.slice(0, host.length - domain.length - 1);
      if (slug.length === 0 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
        return errorResponse(404, "no-route");
      }

      const binding = activeHostnames.get(host);
      if (!binding) {
        log.warn("public request to offline exposure", { hostname: host });
        return errorResponse(503, "offline");
      }

      if (isUpgrade) {
        const info = binding.owner.prepareBridge(
          url.pathname,
          url.search.replace(/^\?/, ""),
          filterRequestHeaders(headersToEntries(request.headers)),
        );
        const data: PublicBridgeData = { bridge: { owner: binding.owner, info } };
        const upgraded = server.upgrade(request, { data });
        if (!upgraded) {
          binding.owner.releaseBridge(info);
          return errorResponse(500, "upgrade-failed");
        }
        return undefined;
      }
      return binding.owner.forwardRequest(request);
    },
    websocket: {
      open(ws): void {
        const socket = ws as ServerWebSocket<PublicBridgeData>;
        const bridge = socket.data?.bridge;
        if (bridge) {
          bridge.owner.attachPublic(bridge.info, socket as unknown as ServerWebSocket<unknown>);
          return;
        }
        const conn = new AgentConnection(socket as unknown as ServerWebSocket<unknown>, deps);
        connections.set(socket as unknown as ServerWebSocket<unknown>, conn);
        conn.onOpen();
      },
      message(ws, message): void {
        const socket = ws as ServerWebSocket<PublicBridgeData>;
        const bridge = socket.data?.bridge;
        if (bridge) {
          bridge.owner.deliverFromPublic(bridge.info.connId, message as string | Uint8Array);
          return;
        }
        connections
          .get(socket as unknown as ServerWebSocket<unknown>)
          ?.handleMessage(message as string | Uint8Array);
      },
      close(ws): void {
        const socket = ws as ServerWebSocket<PublicBridgeData>;
        const bridge = socket.data?.bridge;
        if (bridge) {
          bridge.owner.publicClosed(bridge.info.connId, 1006, "public client disconnected");
          return;
        }
        connections.get(socket as unknown as ServerWebSocket<unknown>)?.dispose();
      },
    },
  });

  portSuffix = server.port === 80 ? "" : `:${server.port}`;

  const { port, hostname } = server;
  if (port === undefined || hostname === undefined) {
    throw new Error("relay failed to report its listen address");
  }

  log.info("relay listening", { hostname, port, domain, agentPath });
  return Promise.resolve({
    port,
    hostname,
    agentUrl: `ws://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}${agentPath}`,
    domain,
    stop: async () => {
      server.stop(true);
    },
  });
}
