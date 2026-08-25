import { describe, expect, test } from "bun:test";
import { filterRequestHeaders, filterResponseHeaders, headersToEntries } from "../src/util/http";
import { isValidExposureId, randomSlug } from "../src/util/ids";
import { createLogger } from "../src/util/logger";

function firstLine(lines: string[]): string {
  const line = lines[0];
  if (line === undefined) {
    throw new Error("expected at least one log line");
  }
  return line;
}

describe("http header filtering", () => {
  test("strips hop-by-hop, host, and content-length from requests", () => {
    const filtered = filterRequestHeaders([
      ["Host", "abc.localhost:8080"],
      ["content-length", "42"],
      ["connection", "keep-alive"],
      ["transfer-encoding", "chunked"],
      ["x-keep", "yes"],
    ]);
    expect(filtered).toEqual([["x-keep", "yes"]]);
  });

  test("keeps content-type on responses but drops framing headers", () => {
    const filtered = filterResponseHeaders([
      ["content-length", "7"],
      ["Content-Type", "text/plain"],
      ["keep-alive", "timeout=5"],
    ]);
    expect(filtered).toEqual([["Content-Type", "text/plain"]]);
  });

  test("headersToEntries preserves duplicates and order", () => {
    const headers = new Headers();
    headers.append("set-cookie", "a=1");
    headers.append("set-cookie", "b=2");
    const entries = headersToEntries(headers);
    expect(entries).toEqual([
      ["set-cookie", "a=1"],
      ["set-cookie", "b=2"],
    ]);
  });
});

describe("identifiers", () => {
  test("randomSlug uses unambiguous lowercase charset", () => {
    for (let i = 0; i < 20; i++) {
      expect(randomSlug()).toMatch(/^[a-z0-9]{8}$/);
    }
    expect(randomSlug(12)).toMatch(/^[a-z0-9]{12}$/);
  });

  test("exposure id validation accepts reasonable ids and rejects junk", () => {
    expect(isValidExposureId("exp_abcdef12")).toBe(true);
    expect(isValidExposureId("12345678")).toBe(true);
    expect(isValidExposureId("short")).toBe(false);
    expect(isValidExposureId("-starts-with-dash")).toBe(false);
    expect(isValidExposureId("has spaces!!")).toBe(false);
    expect(isValidExposureId("")).toBe(false);
  });
});

describe("structured logger", () => {
  test("emits single-line JSON with subsystem and level to the sink", () => {
    const lines: string[] = [];
    const log = createLogger({ subsystem: "test", sink: (line) => lines.push(line) });
    log.info("hello", { streamId: 3 });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(firstLine(lines));
    expect(parsed.subsystem).toBe("test");
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("hello");
    expect(parsed.streamId).toBe(3);
  });

  test("redacts secret-like keys recursively", () => {
    const lines: string[] = [];
    const log = createLogger({ subsystem: "test", sink: (line) => lines.push(line) });
    log.info("auth attempt", { token: "super-secret", nested: { authorization: "Bearer x" } });
    const parsed = JSON.parse(firstLine(lines));
    expect(JSON.stringify(parsed)).not.toContain("super-secret");
    expect(JSON.stringify(parsed)).not.toContain("Bearer x");
    expect(parsed.token).toBe("[redacted]");
    expect(parsed.nested.authorization).toBe("[redacted]");
  });

  test("child loggers inherit bindings and level filtering works", () => {
    const lines: string[] = [];
    const log = createLogger({
      subsystem: "relay",
      level: "warn",
      sink: (line) => lines.push(line),
    }).child({
      sessionId: "sess_x",
    });
    log.debug("noisy");
    log.warn("careful", { extra: true });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(firstLine(lines));
    expect(parsed.sessionId).toBe("sess_x");
    expect(parsed.level).toBe("warn");
  });
});
