import { createHash, randomBytes } from "node:crypto";

export type UserId = string;
export type WorkspaceId = string;
export type ExposureId = string;

export interface ClientCredential {
  tokenHash: string;
  workspaceId: WorkspaceId;
  userId: UserId;
}

export interface BrowserSession {
  tokenHash: string;
  exposureId: ExposureId;
  workspaceId: WorkspaceId;
  expiresAt: number;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateClientToken(): string {
  return `cpx_${randomBytes(32).toString("base64url")}`;
}

export function generateBrowserToken(): string {
  return `bst_${randomBytes(32).toString("base64url")}`;
}
