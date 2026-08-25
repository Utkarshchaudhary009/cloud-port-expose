import { describe, expect, test } from "bun:test";
import { decodeBase64, encodeBase64 } from "../src/protocol/bytes";
import { decodeMessage, encodeMessage, ProtocolError } from "../src/protocol/codec";
import { PROTOCOL_VERSION, type TunnelMsg } from "../src/protocol/messages";

const SAMPLE_MESSAGES: TunnelMsg[] = [
  { t: "hello", version: PROTOCOL_VERSION },
  { t: "welcome", sessionId: "sess_0123456789abcdef" },
  { t: "auth", token: "secret-token-value" },
  { t: "auth-ok", workspaceId: "ws_alpha" },
  { t: "auth-error", code: "revoked-token", message: "token has been revoked" },
  { t: "expose", exposureId: "exp_100" },
  { t: "expose", exposureId: "exp_101", name: "agy-usage" },
  {
    t: "exposed",
    exposureId: "exp_101",
    hostname: "agy-usage.example.test",
    url: "https://agy-usage.example.test",
  },
  { t: "unexpose", exposureId: "exp_100" },
  { t: "unexposed", exposureId: "exp_100" },
  { t: "ping", nonce: 1 },
  { t: "pong", nonce: 1 },
  { t: "error", code: "unknown-exposure", message: "no such exposure" },
  {
    t: "error",
    code: "protocol-violation",
    message: "bad stream",
    context: { streamId: 7, connId: 3, exposureId: "exp_100" },
  },
  {
    t: "req-head",
    streamId: 1,
    method: "GET",
    path: "/index.html",
    query: "a=1&b=two",
    headers: { host: "example.test", "x-forwarded-for": "203.0.113.9" },
  },
  {
    t: "req-body",
    streamId: 1,
    data: encodeBase64(new TextEncoder().encode("hello world")),
    final: true,
  },
  {
    t: "res-head",
    streamId: 1,
    status: 418,
    headers: { "content-type": "text/plain; charset=utf-8" },
  },
  {
    t: "res-body",
    streamId: 1,
    data: encodeBase64(new Uint8Array([0x00, 0xff, 0x10, 0xfe])),
    final: false,
  },
  { t: "abort", streamId: 2, reason: "upstream closed early" },
  {
    t: "ws-open",
    connId: 5,
    path: "/ws",
    query: "room=lobby",
    headers: { "sec-websocket-protocol": "chat" },
  },
  { t: "ws-data", connId: 5, encoding: "utf8", data: '{"hello":"world"}' },
  { t: "ws-data", connId: 5, encoding: "base64", data: encodeBase64(new Uint8Array([1, 2, 3])) },
  { t: "ws-close", connId: 5, code: 1000, reason: "done" },
];

describe("protocol codec", () => {
  test("PROTOCOL_VERSION is pinned to 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  for (const msg of SAMPLE_MESSAGES) {
    test(`round-trips ${msg.t}`, () => {
      const decoded = decodeMessage(encodeMessage(msg));
      expect(decoded).toEqual(msg);
    });
  }

  test("binary payloads survive base64 round-trip byte-exactly", () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = i;
    }
    const encoded = decodeBase64(encodeBase64(bytes));
    expect(encoded).toEqual(bytes);
  });

  test("decode accepts Uint8Array input", () => {
    const raw = new TextEncoder().encode(JSON.stringify({ t: "ping", nonce: 42 }));
    expect(decodeMessage(raw)).toEqual({ t: "ping", nonce: 42 });
  });

  test("rejects unknown fields", () => {
    expect(() => decodeMessage('{"t":"expose","exposureId":"e1","exposureID":"typo"}')).toThrow(
      ProtocolError,
    );
    expect(() => decodeMessage('{"t":"welcome","sessionId":"s1","admin":true}')).toThrow(
      ProtocolError,
    );
  });

  test("rejects control characters and invalid header names", () => {
    const head = (headers: string) =>
      `{"t":"req-head","streamId":1,"method":"GET","path":"/","query":"","headers":${headers}}`;
    expect(() => decodeMessage(head('{"x-evil":"1\\r\\nHost: injected"}'))).toThrow(ProtocolError);
    expect(() => decodeMessage(head('{"bad\\nname":"v"}'))).toThrow(ProtocolError);
    expect(() => decodeMessage(head('{"":"v"}'))).toThrow(ProtocolError);
    expect(() => decodeMessage(head('{"__proto__":"x"}'))).toThrow(ProtocolError);
    expect(() => decodeMessage(head('{"x-ok":"value with spaces, fine"}'))).not.toThrow();
  });

  test("rejects unknown message type", () => {
    expect(() => decodeMessage('{"t":"teleport"}')).toThrow(ProtocolError);
  });

  test("rejects non-object JSON", () => {
    expect(() => decodeMessage("[1,2,3]")).toThrow(ProtocolError);
    expect(() => decodeMessage('"hello"')).toThrow(ProtocolError);
    expect(() => decodeMessage("null")).toThrow(ProtocolError);
  });

  test("rejects invalid JSON", () => {
    expect(() => decodeMessage("{not json")).toThrow(ProtocolError);
  });

  test("rejects missing discriminator", () => {
    expect(() => decodeMessage('{"version":1}')).toThrow(ProtocolError);
  });

  test("rejects wrong field types", () => {
    expect(() => decodeMessage('{"t":"welcome","sessionId":123}')).toThrow(ProtocolError);
    expect(() =>
      decodeMessage(
        '{"t":"req-head","streamId":"x","method":"GET","path":"/","query":"","headers":{}}',
      ),
    ).toThrow(ProtocolError);
    expect(() =>
      decodeMessage('{"t":"res-body","streamId":1,"data":"!!!notbase64","final":true}'),
    ).toThrow(ProtocolError);
    expect(() =>
      decodeMessage('{"t":"ws-data","connId":1,"encoding":"utf8","data":"ok"}'),
    ).not.toThrow();
  });

  test("rejects out-of-range values", () => {
    expect(() => decodeMessage('{"t":"res-head","streamId":1,"status":42,"headers":{}}')).toThrow(
      ProtocolError,
    );
    expect(() => decodeMessage('{"t":"ws-close","connId":1,"code":70000,"reason":""}')).toThrow(
      ProtocolError,
    );
  });

  test("error message never carries raw token through codec errors", () => {
    try {
      decodeMessage('{"t":"auth"}');
      throw new Error("expected ProtocolError");
    } catch (err) {
      expect(err).toBeInstanceOf(ProtocolError);
      expect((err as Error).message).not.toContain("secret-token-value");
    }
  });
});
