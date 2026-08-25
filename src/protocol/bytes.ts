import { Buffer } from "node:buffer";

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

export function decodeBase64(encoded: string): Uint8Array {
  if (!isValidBase64(encoded)) {
    throw new Error("invalid base64 payload");
  }
  return new Uint8Array(Buffer.from(encoded, "base64"));
}

export function isValidBase64(value: string): boolean {
  if (value.length % 4 !== 0) {
    return false;
  }
  return BASE64_PATTERN.test(value);
}
