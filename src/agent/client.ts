import {
  decodeMessage,
  type ExposedMsg,
  encodeMessage,
  PROTOCOL_VERSION,
  type RequestBodyMsg,
  type RequestHeadMsg,
  type TunnelMsg,
  type WelcomeMsg,
  type WsDataMsg,
  type WsOpenMsg,
} from "../protocol";
import { decodeBase64, encodeBase64 } from "../protocol/bytes";
import { filterRequestHeaders, filterResponseHeaders, headersToEntries } from "../util/http";
import { newId } from "../util/ids";
import { createLogger, type Logger, type LogLevel } from "../util/logger";

const DEFAULT_ORIGIN_HOSTNAME = "127.0.0.1";
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export interface AgentOptions {
  relayUrl: string;
  originPort: number;
  originHostname?: string | undefined;
  exposureId?: string | undefined;
  /** Human-readable stable name -> <name>.<domain> hostname (requires relay-side support). */
  exposureName?: string | undefined;
  /** Client credential sent in the auth frame after hello (required when relay auth is on). */
  clientToken?: string | undefined;
  /** Access mode for the exposure: open to anyone, or gated by a browser session token. */
  accessMode?: "open" | "session" | undefined;
  logLevel?: LogLevel;
  connectTimeoutMs?: number;
  heartbeatIntervalMs?: number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;
const WS_HEADERS_TO_DROP = new Set([
  "host",
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-accept",
]);

export interface ExposedEndpoint {
  sessionId: string;
  workspaceId?: string | undefined;
  exposureId: string;
  hostname: string;
  url: string;
}

export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentError";
  }
}

interface Deferred<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

const DEFAULT_AGENT_PATH = "/___agent";

export function resolveAgentUrl(relayUrl: string, agentPath = DEFAULT_AGENT_PATH): string {
  const url = new URL(relayUrl);
  if (url.pathname === "" || url.pathname === "/") {
    return `${url.protocol}//${url.host}${agentPath}${url.search}`;
  }
  return relayUrl;
}

function _deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { resolve, reject };
}

export class ExposeAgent {
  readonly exposureId: string;
  private readonly exposureName: string | undefined;
  private readonly clientToken: string | undefined;
  private readonly accessMode: "open" | "session";
  private readonly relayUrl: string;
  private readonly originPort: number;
  private readonly originHostname: string;
  private readonly connectTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly log: Logger;
  private ws: WebSocket | undefined;
  private sessionId: string | undefined;
  private workspaceId: string | undefined;
  private authWaiter: Deferred<{ workspaceId: string }> | undefined;
  private welcome: Deferred<WelcomeMsg> | undefined;
  private exposed: Deferred<ExposedMsg> | undefined;
  private readonly inflight = new Map<number, AbortController>();
  private readonly requestBodies = new Map<number, ReadableStreamDefaultController<Uint8Array>>();
  private readonly bridged = new Map<number, WebSocket>();
  private readonly pendingOriginFrames = new Map<number, (string | Uint8Array)[]>();
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private lastIncomingAt = Date.now();
  private lastProtocolError: Error | undefined;
  private closedByUs = false;

  constructor(options: AgentOptions) {
    if (!/^wss?:\/\//.test(options.relayUrl)) {
      throw new AgentError("relayUrl must start with ws:// or wss://");
    }
    this.relayUrl = options.relayUrl;
    this.clientToken = options.clientToken;
    this.accessMode = options.accessMode ?? "open";
    this.exposureName = options.exposureName;
    this.exposureId = options.exposureId ?? newId("exp");
    this.originPort = options.originPort;
    this.originHostname = options.originHostname ?? DEFAULT_ORIGIN_HOSTNAME;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.log = createLogger({ subsystem: "agent", level: options.logLevel });
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.sessionId !== undefined;
  }

  connect(): Promise<void> {
    if (this.ws !== undefined) {
      return Promise.reject(new AgentError("agent is already connected or connecting"));
    }
    this.closedByUs = false;
    const targetUrl = resolveAgentUrl(this.relayUrl);
    const socket = new WebSocket(targetUrl);
    socket.binaryType = "arraybuffer";
    this.ws = socket;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settleConnect = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      const timeout = setTimeout(() => {
        settleConnect(
          new AgentError(`relay connection timed out after ${this.connectTimeoutMs}ms`),
        );
        try {
          socket.close();
        } catch {
          // already closed
        }
      }, this.connectTimeoutMs);

      socket.addEventListener("open", () => {
        this.send({ t: "hello", version: PROTOCOL_VERSION });
      });

      socket.addEventListener("message", (event) => {
        this.handleMessage(
          typeof event.data === "string" ? event.data : new Uint8Array(event.data),
        ).catch((error) => {
          this.log.error("message handling failed", { err: (error as Error).message });
          void this.close();
        });
      });

      socket.addEventListener("error", () => {
        settleConnect(new AgentError(`failed to connect to ${targetUrl}`));
      });

      socket.addEventListener("close", () => {
        settleConnect(
          this.lastProtocolError ??
            new AgentError("connection to relay lost before handshake completed"),
        );
        this.lastProtocolError = undefined;
        this.handleSocketClosed();
      });

      const finishConnect = (): void => {
        if (!this.connected) {
          settleConnect(new AgentError("connection lost during authentication"));
          return;
        }
        this.startHeartbeat();
        this.log.info("session established", { sessionId: this.sessionId });
        settleConnect();
      };
      this.welcome = {
        resolve: (welcomeMsg) => {
          this.sessionId = welcomeMsg.sessionId;
          if (this.clientToken !== undefined) {
            this.authWaiter = {
              resolve: (authOk) => {
                this.workspaceId = authOk.workspaceId;
                finishConnect();
              },
              reject: settleConnect,
            };
            this.send({ t: "auth", token: this.clientToken });
            return;
          }
          finishConnect();
        },
        reject: settleConnect,
      };
    });
  }

  expose(): Promise<ExposedEndpoint> {
    if (!this.connected) {
      return Promise.reject(new AgentError("agent must be connected before exposing"));
    }
    const sessionId = this.sessionId as string;
    this.exposed?.reject(new AgentError("superseded by a newer expose() call"));
    return new Promise<ExposedEndpoint>((resolve, reject) => {
      this.exposed = {
        resolve: (msg) => {
          this.log.info("endpoint active", { url: msg.url, hostname: msg.hostname });
          resolve({
            sessionId,
            workspaceId: this.workspaceId,
            exposureId: msg.exposureId,
            hostname: msg.hostname,
            url: msg.url,
          });
        },
        reject,
      };
      const wantsName = this.exposureName !== undefined;
      this.send({
        t: "expose",
        exposureId: this.exposureId,
        ...(wantsName ? { name: this.exposureName } : {}),
        ...(this.accessMode === "session" ? { mode: this.accessMode } : {}),
      });
    });
  }

  async close(): Promise<void> {
    this.closedByUs = true;
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    const socket = this.ws;
    this.ws = undefined;
    for (const controller of this.inflight.values()) {
      controller.abort();
    }
    this.inflight.clear();
    this.failAllPendingBodies(new Error("agent shutting down"), /* clearMap */ true);
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      if (socket.readyState === WebSocket.CONNECTING) {
        const error = new AgentError("connection closed before handshake completed");
        this.welcome?.reject(error);
        this.exposed?.reject(error);
        this.welcome = undefined;
        this.exposed = undefined;
      }
      await new Promise<void>((resolve) => {
        socket.addEventListener("close", () => resolve(), { once: true });
        try {
          socket.close(1000, "agent shutdown");
        } catch {
          resolve();
        }
      });
    }
  }

  private startHeartbeat(): void {
    const interval = this.heartbeatIntervalMs;
    if (interval <= 0) {
      return;
    }
    let lastPingSentAt = Date.now();
    this.heartbeatTimer = setInterval(
      () => {
        if (!this.connected) {
          return;
        }
        const now = Date.now();
        if (now - this.lastIncomingAt > interval * 2.5) {
          this.log.warn("heartbeat timeout, closing relay connection", { interval });
          void this.close();
          return;
        }
        if (now - lastPingSentAt >= interval) {
          lastPingSentAt = now;
          try {
            this.send({ t: "ping", nonce: now % 1_000_000 });
          } catch {
            // socket died; close handler will clean up
          }
        }
      },
      Math.min(interval, 1000),
    );
  }

  private async handleMessage(raw: string | Uint8Array): Promise<void> {
    this.lastIncomingAt = Date.now();
    let msg: TunnelMsg;
    try {
      msg = decodeMessage(raw);
    } catch (error) {
      this.log.error("malformed message from relay", { err: (error as Error).message });
      await this.close();
      return;
    }

    switch (msg.t) {
      case "welcome":
        this.welcome?.resolve(msg);
        this.welcome = undefined;
        return;
      case "auth-error":
      case "error": {
        const error = new AgentError(`${msg.code}: ${msg.message}`);
        this.lastProtocolError = error;
        this.log.error("relay reported an error", { code: msg.code });
        this.welcome?.reject(error);
        this.exposed?.reject(error);
        this.welcome = undefined;
        this.exposed = undefined;
        return;
      }
      case "auth-ok":
        this.workspaceId = msg.workspaceId;
        this.authWaiter?.resolve({ workspaceId: msg.workspaceId });
        this.authWaiter = undefined;
        return;
      case "exposed":
        this.exposed?.resolve(msg);
        this.exposed = undefined;
        return;
      case "ws-open":
        this.openOriginBridge(msg);
        return;
      case "ws-data":
        this.deliverToOrigin(msg);
        return;
      case "ws-close":
        this.closeBridged(msg.connId, msg.code, msg.reason);
        return;
      case "req-head":
        void this.serveRequest(msg);
        return;
      case "req-body":
        this.acceptRequestBody(msg);
        return;
      case "ping":
        this.send({ t: "pong", nonce: msg.nonce });
        return;
      case "abort": {
        this.inflight.get(msg.streamId)?.abort();
        this.failRequestBody(msg.streamId, new Error(`relay aborted stream: ${msg.reason}`));
        return;
      }
      case "unexposed":
      case "pong":
        return;
      default:
        this.log.warn("ignoring unexpected message type", { type: msg.t satisfies TunnelMsg["t"] });
        return;
    }
  }

  private async serveRequest(head: RequestHeadMsg): Promise<void> {
    const streamId = head.streamId;
    const controller = new AbortController();
    this.inflight.set(streamId, controller);
    this.log.info("serving forwarded request", { streamId, method: head.method, path: head.path });

    const noBodyExpected = head.method === "GET" || head.method === "HEAD";
    let responseSent = false;
    try {
      const target = `${this.originBaseUrl()}${head.path}${head.query ? `?${head.query}` : ""}`;
      const requestBody = noBodyExpected ? undefined : this.newRequestBodyStream(streamId);
      const originResponse = await fetch(target, {
        method: head.method,
        headers: new Headers(
          filterRequestHeaders(head.headers).map(([name, value]) => [name, value]),
        ),
        body: requestBody,
        signal: controller.signal,
        redirect: "manual",
      });

      responseSent = true;
      this.send({
        t: "res-head",
        streamId,
        status: originResponse.status,
        headers: filterResponseHeaders(await headersToEntries(originResponse.headers)).map(
          ([name, value]) => [name, value],
        ),
      });

      await this.pumpResponseBody(streamId, originResponse);
      this.log.info("request served", { streamId, status: originResponse.status });
    } catch (error) {
      const reason = (error as Error).message ?? "origin failure";
      this.log.warn("request failed at origin", { streamId, err: reason });
      if (!responseSent) {
        this.trySendAbort(streamId, reason);
      } else if (controller.signal.aborted) {
        // relay retired the stream (timeout/client disconnect): nothing to signal
      } else {
        this.trySendAbort(streamId, `origin response truncated: ${reason}`);
      }
    } finally {
      this.inflight.delete(streamId);
      this.dropRequestBody(streamId);
    }
  }

  private originBaseUrl(): string {
    return `http://${this.originHostname}:${this.originPort}`;
  }

  private pumpResponseBody(streamId: number, response: Response): Promise<void> {
    const pump = async (): Promise<void> => {
      if (response.body === null) {
        this.sendResBodyFinal(streamId);
        return;
      }
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (value && value.byteLength > 0) {
          this.send({ t: "res-body", streamId, data: encodeBase64(value), final: false });
        }
        if (done) {
          break;
        }
      }
      this.sendResBodyFinal(streamId);
    };
    return pump();
  }

  private sendResBodyFinal(streamId: number): void {
    try {
      this.send({ t: "res-body", streamId, data: "", final: true });
    } catch {
      // socket died mid-response; relay side will time out / observe disconnect
    }
  }

  private trySendAbort(streamId: number, reason: string): void {
    try {
      this.send({ t: "abort", streamId, reason: reason.slice(0, 200) });
    } catch {
      // socket dead
    }
  }

  private newRequestBodyStream(streamId: number): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.requestBodies.set(streamId, controller);
      },
      cancel: () => {
        this.requestBodies.delete(streamId);
      },
    });
  }

  private acceptRequestBody(msg: RequestBodyMsg): void {
    const controller = this.requestBodies.get(msg.streamId);
    if (!controller) {
      this.log.debug("dropping body chunk for inactive stream", { streamId: msg.streamId });
      return;
    }
    if (msg.data.length > 0) {
      controller.enqueue(decodeBase64(msg.data));
    }
    if (msg.final) {
      this.requestBodies.delete(msg.streamId);
      try {
        controller.close();
      } catch {
        // already closed
      }
    }
  }

  private failRequestBody(streamId: number, error: Error): void {
    const controller = this.requestBodies.get(streamId);
    if (!controller) {
      return;
    }
    this.requestBodies.delete(streamId);
    try {
      controller.error(error);
    } catch {
      // already closed
    }
  }

  private dropRequestBody(streamId: number): void {
    this.requestBodies.delete(streamId);
  }

  private failAllPendingBodies(error: Error, clearMap: boolean): void {
    for (const [streamId, controller] of [...this.requestBodies.entries()]) {
      try {
        controller.error(error);
      } catch {
        // already closed
      }
      if (clearMap) {
        this.requestBodies.delete(streamId);
      }
    }
  }

  private openOriginBridge(head: WsOpenMsg): void {
    const connId = head.connId;
    const protocols = head.headers
      .filter(([name]) => name.toLowerCase() === "sec-websocket-protocol")
      .map(([, value]) => value)
      .join(", ");
    const forwardedHeaders: Record<string, string> = {};
    for (const [name, value] of head.headers) {
      if (!WS_HEADERS_TO_DROP.has(name.toLowerCase())) {
        forwardedHeaders[name] = value;
      }
    }
    const target = `${this.originWsBaseUrl()}${head.path}${head.query ? `?${head.query}` : ""}`;
    const child = new WebSocket(target, {
      headers: forwardedHeaders,
      protocols: protocols || undefined,
    });
    this.bridged.set(connId, child);
    this.pendingOriginFrames.set(connId, []);
    this.log.info("bridging websocket to origin", { connId, path: head.path });

    child.addEventListener("open", () => {
      const queued = this.pendingOriginFrames.get(connId);
      this.pendingOriginFrames.delete(connId);
      if (queued) {
        for (const frame of queued) {
          child.send(frame);
        }
      }
      this.log.debug("origin bridge open", { connId, flushed: queued?.length ?? 0 });
    });
    child.addEventListener("message", (event) => {
      const isText = typeof event.data === "string";
      try {
        this.send({
          t: "ws-data",
          connId,
          encoding: isText ? "utf8" : "base64",
          data: isText
            ? (event.data as string)
            : encodeBase64(new Uint8Array(event.data as ArrayBuffer)),
        });
      } catch {
        // relay socket died; close handler cleans up bridges
      }
    });
    child.addEventListener("close", (event) => {
      const closeEvent = event as CloseEvent;
      this.bridged.delete(connId);
      this.pendingOriginFrames.delete(connId);
      try {
        this.send({
          t: "ws-close",
          connId,
          code: closeEvent.code ?? 1005,
          reason: (closeEvent.reason ?? "").slice(0, 120),
        });
      } catch {
        // relay socket gone
      }
    });
    child.addEventListener("error", () => {
      this.log.warn("origin bridge error", { connId });
      try {
        child.close(1011, "origin connection failed");
      } catch {
        // already closed
      }
    });
  }

  private deliverToOrigin(msg: WsDataMsg): void {
    const child = this.bridged.get(msg.connId);
    if (!child) {
      this.log.debug("ws-data for unknown origin bridge", { connId: msg.connId });
      return;
    }
    const frame = msg.encoding === "utf8" ? msg.data : decodeBase64(msg.data);
    if (child.readyState === WebSocket.OPEN) {
      child.send(frame);
      return;
    }
    const queued = this.pendingOriginFrames.get(msg.connId);
    if (queued) {
      queued.push(frame);
    }
  }

  private closeBridged(connId: number, code: number, reason: string): void {
    const child = this.bridged.get(connId);
    if (!child) {
      return;
    }
    this.bridged.delete(connId);
    try {
      child.close(code === 1005 ? 1000 : code, reason.slice(0, 120));
    } catch {
      // already closed
    }
  }

  private originWsBaseUrl(): string {
    return `ws://${this.originHostname}:${this.originPort}`;
  }

  private handleSocketClosed(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.failAllPendingBodies(new Error("tunnel closed"), true);
    for (const controller of this.inflight.values()) {
      controller.abort();
    }
    this.inflight.clear();
    for (const child of this.bridged.values()) {
      try {
        child.close(1011, "tunnel closed");
      } catch {
        // already closed
      }
    }
    this.bridged.clear();
    const error = new AgentError(
      this.closedByUs ? "connection closed" : "connection to relay lost",
    );
    this.welcome?.reject(error);
    this.exposed?.reject(error);
    this.welcome = undefined;
    this.exposed = undefined;
    this.ws = undefined;
    this.sessionId = undefined;
    this.log.warn("socket closed", { byUs: this.closedByUs });
  }

  private send(msg: TunnelMsg): void {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new AgentError("cannot send; socket not open");
    }
    socket.send(encodeMessage(msg));
  }
}
