import type { HeaderEntries } from "../protocol/messages";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const FORWARDED_REQUEST_DROP = new Set([...HOP_BY_HOP_HEADERS, "host", "content-length"]);

const FORWARDED_RESPONSE_DROP = new Set([...HOP_BY_HOP_HEADERS, "content-length"]);

export function filterRequestHeaders(entries: HeaderEntries): HeaderEntries {
  const connectionNamed = new Set<string>();
  for (const [name, value] of entries) {
    if (name.toLowerCase() === "connection") {
      for (const token of value.split(",")) {
        connectionNamed.add(token.trim().toLowerCase());
      }
    }
  }
  return entries.filter(
    ([name]) =>
      !FORWARDED_REQUEST_DROP.has(name.toLowerCase()) && !connectionNamed.has(name.toLowerCase()),
  );
}

export function filterResponseHeaders(entries: HeaderEntries): HeaderEntries {
  return entries.filter(([name]) => !FORWARDED_RESPONSE_DROP.has(name.toLowerCase()));
}

export function headersToEntries(headers: Headers): HeaderEntries {
  const entries: [string, string][] = [];
  headers.forEach((value, name) => {
    entries.push([name, value]);
  });
  return entries;
}
