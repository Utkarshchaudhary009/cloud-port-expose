import type { ServerWebSocket } from "bun";
import {
  type AbortMsg,
  decodeMessage,
  type ExposeMsg,
  encodeMessage,
  type HeaderEntries,
  PROTOCOL_VERSION,
  type ResponseBodyMsg,
  type ResponseHeadMsg,
  type TunnelMsg,
} from "../protocol";
import { decodeBase64, encodeBase64 } from "../protocol/bytes";
import { filterRequestHeaders, filterResponseHeaders, headersToEntries } from "../util/http";
import { isValidExposureId, newId, randomSlug } from "../util/ids";
import type { Logger, LogLevel } from "../util/logger";

const _SLUG_CHARSET = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export interface RelayOptions {
  port?: number;
  hostname?: string;
  domain?: string;
  agentPath?: string;
  requestTimeoutMs?: number;
  logLevel?: LogLevel;
}

export interface RelayHandle {
  port: number;
  hostname: string;
  agentUrl: string;
  domain: string;
  stop(): Promise<void>;
}

interface PendingHead {
  status: number;
  headers: HeaderEntries;
}

class StreamState {
  headReceived = false;
  bodyComplete = false;
  readonly chunks: Uint8Array[] = [];

  constructor(
    readonly id: number,
    readonly method: string,
    readonly path: string,
  ) {}
}

interface ExchangeWaiter {
  resolveHead: (head: PendingHead) => void;
  resolveBody: () => void;
  reject: (error: Error) => void;
}

export interface RelayDeps {
  domain: string;
  requestTimeoutMs: number;
  log: Logger;
  buildPublicUrl: (hostname: string) => string;
  registerExposure: (hostname: string, owner: AgentConnection) => boolean;
  unregisterExposure: (hostname: string, owner: AgentConnection) => void;
  lookupExposureHostname: (exposureId: string) => string | undefined;
  rememberExposureHostname: (exposureId: string, hostname: string) => void;
  forgetExposureHostname: (exposureId: string) => void;
  releaseAll: (owner: AgentConnection) => void;
  isExposureTakenByOther: (exposureId: string, self: AgentConnection) => boolean;
}

export class AgentConnection {
  readonly sessionId = newId("sess");
  private readonly exposures = new Map<string, { hostname: string }>();
  private readonly streams = new Map<number, StreamState>();
  private readonly waiters = new Map<number, ExchangeWaiter>();
  private nextStreamId = 1;
  private disposed = false;
  private handshaked = false;
  private readonly log: Logger;

  constructor(
    private readonly ws: ServerWebSocket<unknown>,
    private readonly deps: RelayDeps,
  ) {
    this.log = deps.log.child({ sessionId: this.sessionId });
  }

  onOpen(): void {
    this.log.info("agent connected");
  }

  handleMessage(raw: string | Uint8Array): void {
    if (this.disposed) {
      return;
    }
    let msg: TunnelMsg;
    try {
      msg = decodeMessage(raw);
    } catch (error) {
      this.fail(`malformed message: ${(error as Error).message}`);
      return;
    }
    if (!this.handshaked && msg.t !== "hello" && msg.t !== "error") {
      this.fail("handshake required before other messages");
      return;
    }
    switch (msg.t) {
      case "hello":
        this.handleHello(msg.version);
        return;
      case "expose":
        this.handleExpose(msg);
        return;
      case "unexpose":
        this.handleUnexpose(msg.exposureId);
        return;
      case "ping":
        this.send({ t: "pong", nonce: msg.nonce });
        return;
      case "res-head":
        this.handleResponseHead(msg);
        return;
      case "res-body":
        this.handleResponseBody(msg);
        return;
      case "abort":
        this.handleAbortFromAgent(msg);
        return;
      case "auth":
        this.send({
          t: "auth-error",
          code: "malformed",
          message: "authentication arrives in phase 4; connect without auth",
        });
        return;
      case "req-head":
      case "req-body":
      case "ws-open":
      case "ws-data":
      case "ws-close":
        this.fail(`message type "${msg.t}" not accepted from agents`);
        return;
      case "welcome":
      case "auth-ok":
      case "auth-error":
      case "exposed":
      case "unexposed":
      case "error":
      case "pong":
        this.fail(`unexpected message type "${msg.t}" from agent`);
        return;
    }
  }

  async forwardRequest(request: Request): Promise<Response> {
    const inboundUrl = new URL(request.url);
    const streamId = this.nextStreamId++;
    const state = new StreamState(streamId, request.method, inboundUrl.pathname);
    this.streams.set(streamId, state);
    this.log.info("forwarding public request", {
      streamId,
      method: request.method,
      path: inboundUrl.pathname,
    });

    let resolveHead!: (head: PendingHead) => void;
    let resolveBody!: () => void;
    let rejectHead!: (error: Error) => void;
    let rejectBody!: (error: Error) => void;
    const headPromise = new Promise<PendingHead>((resolve, reject) => {
      resolveHead = resolve;
      rejectHead = reject;
    });
    const bodyPromise = new Promise<void>((resolve, reject) => {
      resolveBody = resolve;
      rejectBody = reject;
    });
    headPromise.catch(() => {});
    bodyPromise.catch(() => {});
    const rejectBoth = (error: Error): void => {
      rejectHead(error);
      rejectBody(error);
    };
    this.waiters.set(streamId, { resolveHead, resolveBody, reject: rejectBoth });

    const notifyAgentAbort = (reason: string): void => {
      this.send({ t: "abort", streamId, reason });
    };
    const onClientAbort = (): void => {
      notifyAgentAbort("public client disconnected");
      this.log.info("public client disconnected", { streamId });
      this.rejectExchange(
        streamId,
        classify(new Error("public client disconnected"), "client-disconnect", 502),
      );
    };
    if (request.signal.aborted) {
      queueMicrotask(onClientAbort);
    } else {
      request.signal.addEventListener("abort", onClientAbort, { once: true });
    }

    const timer = setTimeout(() => {
      notifyAgentAbort(`relay timed out after ${this.deps.requestTimeoutMs}ms`);
      this.rejectExchange(streamId, classify(new Error("upstream timeout"), "timeout", 504));
    }, this.deps.requestTimeoutMs);

    const pumpPromise = this.pumpRequestBody(request, streamId).catch((error) => {
      if (!state.headReceived) {
        this.rejectExchange(streamId, classify(error as Error, "client-disconnect", 502));
      }
    });
    pumpPromise.catch(() => {});

    try {
      this.send({
        t: "req-head",
        streamId,
        method: request.method,
        path: inboundUrl.pathname,
        query: inboundUrl.search.replace(/^\?/, ""),
        headers: filterRequestHeaders(headersToEntries(request.headers)),
      });

      const head = await headPromise;
      await pumpPromise;
      await bodyPromise;

      const body = concatChunks(state.chunks);
      this.log.info("upstream responded", { streamId, status: head.status });
      return new Response(body, {
        status: head.status,
        headers: new Headers(
          filterResponseHeaders(head.headers).map(([name, value]) => [name, value]),
        ),
      });
    } catch (error) {
      const coded = error as Error & { relayCode?: string; relayStatus?: number };
      this.log.warn("exchange failed", {
        streamId,
        code: coded.relayCode ?? "upstream-disconnected",
      });
      return errorResponse(coded.relayStatus ?? 502, coded.relayCode ?? "upstream-disconnected");
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onClientAbort);
      this.waiters.delete(streamId);
      this.streams.delete(streamId);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const streamId of [...this.waiters.keys()]) {
      this.rejectExchange(
        streamId,
        classify(new Error("agent disconnected"), "upstream-disconnected", 502),
      );
    }
    this.deps.releaseAll(this);
    this.exposures.clear();
    this.log.info("agent disconnected");
  }

  private handleHello(version: number): void {
    if (version !== PROTOCOL_VERSION) {
      this.send({
        t: "error",
        code: "protocol-violation",
        message: `unsupported protocol version ${version}; expected ${PROTOCOL_VERSION}`,
      });
      this.closeSocket();
      this.dispose();
      return;
    }
    this.handshaked = true;
    this.send({ t: "welcome", sessionId: this.sessionId });
  }

  private handleExpose(msg: ExposeMsg): void {
    if (!isValidExposureId(msg.exposureId)) {
      this.send({
        t: "error",
        code: "bad-request",
        message: "exposureId must be 8-64 chars of [A-Za-z0-9._-] starting alphanumeric",
        context: { exposureId: msg.exposureId },
      });
      return;
    }
    if (this.deps.isExposureTakenByOther(msg.exposureId, this)) {
      this.send({
        t: "error",
        code: "session-conflict",
        message: "exposure already bound to another connected session",
        context: { exposureId: msg.exposureId },
      });
      return;
    }

    const owned = this.exposures.get(msg.exposureId);
    if (owned) {
      // Idempotent retry on the same session: keep the existing binding.
      this.log.info("exposure re-confirmed", {
        exposureId: msg.exposureId,
        hostname: owned.hostname,
      });
      this.send({
        t: "exposed",
        exposureId: msg.exposureId,
        hostname: owned.hostname,
        url: this.deps.buildPublicUrl(owned.hostname),
      });
      return;
    }

    let hostname = this.deps.lookupExposureHostname(msg.exposureId);
    if (!hostname || !this.deps.registerExposure(hostname, this)) {
      do {
        hostname = `${randomSlug()}.${this.deps.domain}`;
      } while (!this.deps.registerExposure(hostname, this));
    }
    this.exposures.set(msg.exposureId, { hostname });
    this.deps.rememberExposureHostname(msg.exposureId, hostname);
    this.log.info("exposure registered", { exposureId: msg.exposureId, hostname });
    this.send({
      t: "exposed",
      exposureId: msg.exposureId,
      hostname,
      url: this.deps.buildPublicUrl(hostname),
    });
  }

  private handleUnexpose(exposureId: string): void {
    const owned = this.exposures.get(exposureId);
    if (owned) {
      this.deps.unregisterExposure(owned.hostname, this);
      this.deps.forgetExposureHostname(exposureId);
      this.exposures.delete(exposureId);
      this.log.info("exposure released", { exposureId });
    }
    this.send({ t: "unexposed", exposureId });
  }

  private handleResponseHead(msg: ResponseHeadMsg): void {
    const waiter = this.waiters.get(msg.streamId);
    const state = this.streams.get(msg.streamId);
    if (!waiter || !state) {
      // Stream already retired locally (e.g. relay-side timeout). The agent may
      // legitimately still be finishing its origin request: drop, don't punish.
      this.log.debug("dropping res-head for retired stream", { streamId: msg.streamId });
      return;
    }
    if (state.headReceived) {
      this.fail(`duplicate res-head for stream ${msg.streamId}`);
      return;
    }
    state.headReceived = true;
    waiter.resolveHead({ status: msg.status, headers: msg.headers });
  }

  private handleResponseBody(msg: ResponseBodyMsg): void {
    const waiter = this.waiters.get(msg.streamId);
    const state = this.streams.get(msg.streamId);
    if (!waiter || !state) {
      this.log.debug("dropping res-body for retired stream", { streamId: msg.streamId });
      return;
    }
    if (!state.headReceived) {
      this.fail(`res-body before res-head on stream ${msg.streamId}`);
      return;
    }
    if (state.bodyComplete) {
      this.fail(`res-body after final chunk on stream ${msg.streamId}`);
      return;
    }
    if (msg.data.length > 0) {
      state.chunks.push(decodeBase64(msg.data));
    }
    if (msg.final) {
      state.bodyComplete = true;
      waiter.resolveBody();
    }
  }

  private handleAbortFromAgent(msg: AbortMsg): void {
    this.rejectExchange(
      msg.streamId,
      classify(new Error(`upstream aborted: ${msg.reason}`), "upstream-aborted", 502),
    );
  }

  private rejectExchange(
    streamId: number,
    error: Error & { relayCode?: string; relayStatus?: number },
  ): void {
    const waiter = this.waiters.get(streamId);
    if (!waiter) {
      return;
    }
    this.waiters.delete(streamId);
    waiter.reject(error);
  }

  private pumpRequestBody(request: Request, streamId: number): Promise<void> {
    const pump = async (): Promise<void> => {
      if (request.body === null) {
        this.send({ t: "req-body", streamId, data: "", final: true });
        return;
      }
      const reader = request.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (value && value.byteLength > 0) {
          this.send({ t: "req-body", streamId, data: encodeBase64(value), final: false });
        }
        if (done) {
          break;
        }
      }
      this.send({ t: "req-body", streamId, data: "", final: true });
    };
    return pump().catch((error) => {
      this.send({
        t: "abort",
        streamId,
        reason: `public client aborted: ${(error as Error).message}`,
      });
      throw error;
    });
  }

  private fail(reason: string): void {
    this.log.warn("closing agent connection", { reason });
    this.send({ t: "error", code: "protocol-violation", message: reason });
    this.closeSocket();
    this.dispose();
  }

  private send(msg: TunnelMsg): void {
    if (this.disposed) {
      return;
    }
    try {
      this.ws.send(encodeMessage(msg));
    } catch {
      this.dispose();
    }
  }

  private closeSocket(): void {
    try {
      this.ws.close(1002, "protocol violation");
    } catch {
      // socket already closed
    }
  }
}

function classify(
  error: Error,
  code: string,
  status: number,
): Error & { relayCode: string; relayStatus: number } {
  return Object.assign(error, { relayCode: code, relayStatus: status });
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function errorResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { "content-type": "application/json", "x-relay-error": code },
  });
}
