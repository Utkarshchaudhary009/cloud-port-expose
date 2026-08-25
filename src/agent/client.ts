import {
  decodeMessage,
  type ExposedMsg,
  encodeMessage,
  PROTOCOL_VERSION,
  type RequestBodyMsg,
  type RequestHeadMsg,
  type TunnelMsg,
  type WelcomeMsg,
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
  originHostname?: string;
  exposureId?: string;
  logLevel?: LogLevel;
  connectTimeoutMs?: number;
}

export interface ExposedEndpoint {
  sessionId: string;
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
  private readonly relayUrl: string;
  private readonly originPort: number;
  private readonly originHostname: string;
  private readonly connectTimeoutMs: number;
  private readonly log: Logger;
  private ws: WebSocket | undefined;
  private sessionId: string | undefined;
  private welcome: Deferred<WelcomeMsg> | undefined;
  private exposed: Deferred<ExposedMsg> | undefined;
  private readonly inflight = new Map<number, AbortController>();
  private readonly requestBodies = new Map<number, ReadableStreamDefaultController<Uint8Array>>();
  private closedByUs = false;

  constructor(options: AgentOptions) {
    if (!/^wss?:\/\//.test(options.relayUrl)) {
      throw new AgentError("relayUrl must start with ws:// or wss://");
    }
    this.relayUrl = options.relayUrl;
    this.exposureId = options.exposureId ?? newId("exp");
    this.originPort = options.originPort;
    this.originHostname = options.originHostname ?? DEFAULT_ORIGIN_HOSTNAME;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
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
        settleConnect(new AgentError("connection to relay lost before handshake completed"));
        this.handleSocketClosed();
      });

      this.welcome = {
        resolve: (welcomeMsg) => {
          this.sessionId = welcomeMsg.sessionId;
          this.log.info("session established", { sessionId: welcomeMsg.sessionId });
          settleConnect();
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
          resolve({ sessionId, exposureId: msg.exposureId, hostname: msg.hostname, url: msg.url });
        },
        reject,
      };
      this.send({ t: "expose", exposureId: this.exposureId });
    });
  }

  async close(): Promise<void> {
    this.closedByUs = true;
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

  private async handleMessage(raw: string | Uint8Array): Promise<void> {
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
        this.log.error("relay reported an error", { code: msg.code });
        this.welcome?.reject(error);
        this.exposed?.reject(error);
        this.welcome = undefined;
        this.exposed = undefined;
        return;
      }
      case "exposed":
        this.exposed?.resolve(msg);
        this.exposed = undefined;
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
      } else {
        this.sendResBodyFinal(streamId);
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

  private handleSocketClosed(): void {
    this.failAllPendingBodies(new Error("tunnel closed"), true);
    for (const controller of this.inflight.values()) {
      controller.abort();
    }
    this.inflight.clear();
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
