export const PROTOCOL_VERSION = 1;

export type HeaderEntry = readonly [name: string, value: string];

export type HeaderEntries = readonly HeaderEntry[];

export type Encoding = "utf8" | "base64";

export interface HelloMsg {
  t: "hello";
  version: number;
}

export interface WelcomeMsg {
  t: "welcome";
  sessionId: string;
}

export interface AuthMsg {
  t: "auth";
  token: string;
}

export type AuthErrorCode = "invalid-token" | "revoked-token" | "expired-token" | "malformed";

export interface AuthOkMsg {
  t: "auth-ok";
  workspaceId: string;
}

export interface AuthErrorMsg {
  t: "auth-error";
  code: AuthErrorCode;
  message: string;
}

export type ExposureAccessMode = "open" | "session";

export interface ExposeMsg {
  t: "expose";
  exposureId: string;
  name?: string;
  mode?: ExposureAccessMode;
}

export interface ExposedMsg {
  t: "exposed";
  exposureId: string;
  hostname: string;
  url: string;
}

export interface UnexposeMsg {
  t: "unexpose";
  exposureId: string;
}

export interface UnexposedMsg {
  t: "unexposed";
  exposureId: string;
}

export interface PingMsg {
  t: "ping";
  nonce: number;
}

export interface PongMsg {
  t: "pong";
  nonce: number;
}

export type ErrorCode =
  | "bad-request"
  | "unauthorized"
  | "unknown-exposure"
  | "session-conflict"
  | "protocol-violation"
  | "internal-error";

export interface ErrorContext {
  exposureId?: string;
  streamId?: number;
  connId?: number;
}

export interface ErrorMsg {
  t: "error";
  code: ErrorCode;
  message: string;
  context?: ErrorContext;
}

export interface RequestHeadMsg {
  t: "req-head";
  streamId: number;
  method: string;
  path: string;
  query: string;
  headers: HeaderEntries;
}

export interface RequestBodyMsg {
  t: "req-body";
  streamId: number;
  data: string;
  final: boolean;
}

export interface ResponseHeadMsg {
  t: "res-head";
  streamId: number;
  status: number;
  headers: HeaderEntries;
}

export interface ResponseBodyMsg {
  t: "res-body";
  streamId: number;
  data: string;
  final: boolean;
}

export interface AbortMsg {
  t: "abort";
  streamId: number;
  reason: string;
}

export interface WsOpenMsg {
  t: "ws-open";
  connId: number;
  path: string;
  query: string;
  headers: HeaderEntries;
}

export interface WsDataMsg {
  t: "ws-data";
  connId: number;
  encoding: Encoding;
  data: string;
}

export interface WsCloseMsg {
  t: "ws-close";
  connId: number;
  code: number;
  reason: string;
}

export type AgentToRelayMsg =
  | HelloMsg
  | AuthMsg
  | ExposeMsg
  | UnexposeMsg
  | PingMsg
  | PongMsg
  | ResponseHeadMsg
  | ResponseBodyMsg
  | AbortMsg
  | WsDataMsg
  | WsCloseMsg;

export type RelayToAgentMsg =
  | WelcomeMsg
  | AuthOkMsg
  | AuthErrorMsg
  | ExposedMsg
  | UnexposedMsg
  | ErrorMsg
  | PingMsg
  | PongMsg
  | RequestHeadMsg
  | RequestBodyMsg
  | AbortMsg
  | WsOpenMsg
  | WsDataMsg
  | WsCloseMsg;

export type TunnelMsg = AgentToRelayMsg | RelayToAgentMsg;

export type TunnelMessageType = TunnelMsg["t"];
