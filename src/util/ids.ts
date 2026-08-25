import { PROTOCOL_VERSION } from "../protocol/messages";

const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function newId(prefix: string): string {
  const uuid = crypto.randomUUID().replace(/-/g, "");
  return `${prefix}_${uuid.slice(0, 16)}`;
}

export function randomSlug(length = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let slug = "";
  for (const byte of bytes) {
    slug += SLUG_ALPHABET.charAt(byte % SLUG_ALPHABET.length);
  }
  return slug;
}

export function isValidExposureId(exposureId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/.test(exposureId);
}

export function protocolVersion(): number {
  return PROTOCOL_VERSION;
}
