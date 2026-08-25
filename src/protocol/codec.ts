import { isValidBase64 } from "./bytes";
import type {
  AbortMsg,
  AuthErrorCode,
  AuthErrorMsg,
  AuthOkMsg,
  Encoding,
  ErrorCode,
  ErrorContext,
  ErrorMsg,
  ExposedMsg,
  ExposeMsg,
  HelloMsg,
  MessageHeaders,
  PingMsg,
  PongMsg,
  RequestBodyMsg,
  RequestHeadMsg,
  ResponseBodyMsg,
  ResponseHeadMsg,
  TunnelMsg,
  UnexposedMsg,
  UnexposeMsg,
  WelcomeMsg,
  WsCloseMsg,
  WsDataMsg,
  WsOpenMsg,
} from "./messages";

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

const AUTH_ERROR_CODES: readonly AuthErrorCode[] = [
  "invalid-token",
  "revoked-token",
  "expired-token",
  "malformed",
];

const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.`^_|~-]+$/;

const ERROR_CODES: readonly ErrorCode[] = [
  "bad-request",
  "unauthorized",
  "unknown-exposure",
  "session-conflict",
  "protocol-violation",
  "internal-error",
];

const ALLOWED_FIELDS_BY_TYPE: Record<string, readonly string[]> = {
  hello: ["version"],
  welcome: ["sessionId"],
  auth: ["token"],
  "auth-ok": ["workspaceId"],
  "auth-error": ["code", "message"],
  expose: ["exposureId", "name"],
  exposed: ["exposureId", "hostname", "url"],
  unexpose: ["exposureId"],
  unexposed: ["exposureId"],
  ping: ["nonce"],
  pong: ["nonce"],
  error: ["code", "message", "context"],
  "req-head": ["streamId", "method", "path", "query", "headers"],
  "req-body": ["streamId", "data", "final"],
  "res-head": ["streamId", "status", "headers"],
  "res-body": ["streamId", "data", "final"],
  abort: ["streamId", "reason"],
  "ws-open": ["connId", "path", "query", "headers"],
  "ws-data": ["connId", "encoding", "data"],
  "ws-close": ["connId", "code", "reason"],
};

function assertObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolError("message must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function readString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string") {
    throw new ProtocolError(`field "${key}" must be a string`);
  }
  return value;
}

function readOptionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ProtocolError(`field "${key}" must be a string`);
  }
  return value;
}

function readInteger(
  obj: Record<string, unknown>,
  key: string,
  min?: number,
  max?: number,
): number {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ProtocolError(`field "${key}" must be an integer`);
  }
  if (min !== undefined && value < min) {
    throw new ProtocolError(`field "${key}" must be >= ${min}`);
  }
  if (max !== undefined && value > max) {
    throw new ProtocolError(`field "${key}" must be <= ${max}`);
  }
  return value;
}

function readBoolean(obj: Record<string, unknown>, key: string): boolean {
  const value = obj[key];
  if (typeof value !== "boolean") {
    throw new ProtocolError(`field "${key}" must be a boolean`);
  }
  return value;
}

function readHeaders(obj: Record<string, unknown>, key: string): MessageHeaders {
  const value = obj[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolError(`field "${key}" must be an object of string values`);
  }
  const headers: MessageHeaders = {};
  for (const [name, headerValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof headerValue !== "string") {
      throw new ProtocolError(`field "${key}" must contain only string values`);
    }
    if (!HEADER_NAME_PATTERN.test(name)) {
      throw new ProtocolError(`field "${key}" contains invalid header name "${name}"`);
    }
    if (name === "__proto__" || name === "constructor" || name === "prototype") {
      throw new ProtocolError(`field "${key}" contains forbidden header name "${name}"`);
    }
    if (/[\r\n\0]/.test(headerValue)) {
      throw new ProtocolError(`field "${key}" contains control characters in a header value`);
    }
    headers[name] = headerValue;
  }
  return headers;
}

function readLiteral<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  const value = obj[key];
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ProtocolError(`field "${key}" must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function readPayload(obj: Record<string, unknown>, encoding: Encoding): string {
  const data = readString(obj, "data");
  if (encoding === "base64" && !isValidBase64(data)) {
    throw new ProtocolError('field "data" is not valid base64');
  }
  return data;
}

type Validator = (obj: Record<string, unknown>) => TunnelMsg;

const validators: Record<string, Validator> = {
  hello: (o): HelloMsg => ({ t: "hello", version: readInteger(o, "version", 1) }),
  welcome: (o): WelcomeMsg => ({ t: "welcome", sessionId: readString(o, "sessionId") }),
  auth: (o) => ({ t: "auth", token: readString(o, "token") }),
  "auth-ok": (o): AuthOkMsg => ({ t: "auth-ok", workspaceId: readString(o, "workspaceId") }),
  "auth-error": (o): AuthErrorMsg => ({
    t: "auth-error",
    code: readLiteral(o, "code", AUTH_ERROR_CODES),
    message: readString(o, "message"),
  }),
  expose: (o): ExposeMsg => {
    const name = readOptionalString(o, "name");
    return name === undefined
      ? { t: "expose", exposureId: readString(o, "exposureId") }
      : { t: "expose", exposureId: readString(o, "exposureId"), name };
  },
  exposed: (o): ExposedMsg => ({
    t: "exposed",
    exposureId: readString(o, "exposureId"),
    hostname: readString(o, "hostname"),
    url: readString(o, "url"),
  }),
  unexpose: (o): UnexposeMsg => ({ t: "unexpose", exposureId: readString(o, "exposureId") }),
  unexposed: (o): UnexposedMsg => ({ t: "unexposed", exposureId: readString(o, "exposureId") }),
  ping: (o): PingMsg => ({ t: "ping", nonce: readInteger(o, "nonce", 0) }),
  pong: (o): PongMsg => ({ t: "pong", nonce: readInteger(o, "nonce", 0) }),
  error: (o): ErrorMsg => {
    const contextValue = o.context;
    let context: ErrorContext | undefined;
    if (contextValue !== undefined) {
      const ctx = assertObject(contextValue);
      context = {};
      const exposureId = readOptionalString(ctx, "exposureId");
      if (exposureId !== undefined) {
        context.exposureId = exposureId;
      }
      if (ctx.streamId !== undefined) {
        context.streamId = readInteger(ctx, "streamId", 0);
      }
      if (ctx.connId !== undefined) {
        context.connId = readInteger(ctx, "connId", 0);
      }
      if (Object.keys(context).length === 0) {
        context = undefined;
      }
    }
    return context === undefined
      ? { t: "error", code: readLiteral(o, "code", ERROR_CODES), message: readString(o, "message") }
      : {
          t: "error",
          code: readLiteral(o, "code", ERROR_CODES),
          message: readString(o, "message"),
          context,
        };
  },
  "req-head": (o): RequestHeadMsg => ({
    t: "req-head",
    streamId: readInteger(o, "streamId", 0),
    method: readString(o, "method"),
    path: readString(o, "path"),
    query: readString(o, "query"),
    headers: readHeaders(o, "headers"),
  }),
  "req-body": (o): RequestBodyMsg => ({
    t: "req-body",
    streamId: readInteger(o, "streamId", 0),
    data: readPayload(o, "base64"),
    final: readBoolean(o, "final"),
  }),
  "res-head": (o): ResponseHeadMsg => ({
    t: "res-head",
    streamId: readInteger(o, "streamId", 0),
    status: readInteger(o, "status", 100, 599),
    headers: readHeaders(o, "headers"),
  }),
  "res-body": (o): ResponseBodyMsg => ({
    t: "res-body",
    streamId: readInteger(o, "streamId", 0),
    data: readPayload(o, "base64"),
    final: readBoolean(o, "final"),
  }),
  abort: (o): AbortMsg => ({
    t: "abort",
    streamId: readInteger(o, "streamId", 0),
    reason: readString(o, "reason"),
  }),
  "ws-open": (o): WsOpenMsg => ({
    t: "ws-open",
    connId: readInteger(o, "connId", 0),
    path: readString(o, "path"),
    query: readString(o, "query"),
    headers: readHeaders(o, "headers"),
  }),
  "ws-data": (o): WsDataMsg => {
    const encoding = readLiteral<Encoding>(o, "encoding", ["utf8", "base64"]);
    return {
      t: "ws-data",
      connId: readInteger(o, "connId", 0),
      encoding,
      data: readPayload(o, encoding),
    };
  },
  "ws-close": (o): WsCloseMsg => ({
    t: "ws-close",
    connId: readInteger(o, "connId", 0),
    code: readInteger(o, "code", 0, 65535),
    reason: readString(o, "reason"),
  }),
};

export function encodeMessage(msg: TunnelMsg): string {
  return JSON.stringify(msg);
}

export function decodeMessage(raw: string | Uint8Array): TunnelMsg {
  let parsed: unknown;
  try {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    parsed = JSON.parse(text);
  } catch {
    throw new ProtocolError("message is not valid JSON");
  }
  const obj = assertObject(parsed);
  const type = obj.t;
  if (typeof type !== "string") {
    throw new ProtocolError('missing string field "t"');
  }
  const validator = validators[type];
  if (validator === undefined) {
    throw new ProtocolError(`unknown message type "${type}"`);
  }
  const allowedFields = ALLOWED_FIELDS_BY_TYPE[type];
  if (allowedFields === undefined) {
    throw new ProtocolError(`unknown message type "${type}"`);
  }
  for (const field of Object.keys(obj)) {
    if (field !== "t" && !allowedFields.includes(field)) {
      throw new ProtocolError(`unknown field "${field}" for message type "${type}"`);
    }
  }
  return validator(obj);
}
