import { randomBytes } from "node:crypto";
import {
  type BrowserSession,
  type ClientCredential,
  type ExposureId,
  generateBrowserToken,
  generateClientToken,
  hashToken,
  type WorkspaceId,
} from "./identity";

export const DEFAULT_BROWSER_SESSION_TTL_MS = 15 * 60 * 1000;

export interface AuthStore {
  createWorkspace(userId?: string): { workspaceId: WorkspaceId; clientToken: string };
  verifyClientToken(token: string): ClientCredential | null;
  revokeClientToken(token: string): boolean;
  rotateClientToken(token: string): { clientToken: string } | null;
  createBrowserSession(exposureId: ExposureId, workspaceId: WorkspaceId, ttlMs?: number): string;
  verifyBrowserSession(token: string, exposureId: ExposureId): boolean;
  revokeBrowserSession(token: string): boolean;
}

export class InMemoryAuthStore implements AuthStore {
  private readonly clients = new Map<string, ClientCredential>();
  private readonly sessions = new Map<string, BrowserSession>();

  createWorkspace(userId = `usr_${randomBytes(8).toString("hex")}`): {
    workspaceId: WorkspaceId;
    clientToken: string;
  } {
    const workspaceId = `wsp_${randomBytes(8).toString("hex")}`;
    const clientToken = this.createClientToken(workspaceId, userId);
    return { workspaceId, clientToken };
  }

  createClientToken(workspaceId: WorkspaceId, userId: string): string {
    const clientToken = generateClientToken();
    this.clients.set(hashToken(clientToken), {
      tokenHash: hashToken(clientToken),
      workspaceId,
      userId,
    });
    return clientToken;
  }

  verifyClientToken(token: string): ClientCredential | null {
    if (typeof token !== "string" || token.length === 0) {
      return null;
    }
    return this.clients.get(hashToken(token)) ?? null;
  }

  revokeClientToken(token: string): boolean {
    return this.clients.delete(hashToken(token));
  }

  rotateClientToken(token: string): { clientToken: string } | null {
    const credential = this.verifyClientToken(token);
    if (!credential) {
      return null;
    }
    this.revokeClientToken(token);
    const clientToken = this.createClientToken(credential.workspaceId, credential.userId);
    return { clientToken };
  }

  createBrowserSession(exposureId: ExposureId, workspaceId: WorkspaceId, ttlMs?: number): string {
    const browserToken = generateBrowserToken();
    this.sessions.set(hashToken(browserToken), {
      tokenHash: hashToken(browserToken),
      exposureId,
      workspaceId,
      expiresAt: Date.now() + (ttlMs ?? DEFAULT_BROWSER_SESSION_TTL_MS),
    });
    return browserToken;
  }

  verifyBrowserSession(token: string, exposureId: ExposureId): boolean {
    if (typeof token !== "string" || token.length === 0) {
      return false;
    }
    const session = this.sessions.get(hashToken(token));
    if (!session) {
      return false;
    }
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(session.tokenHash);
      return false;
    }
    return session.exposureId === exposureId;
  }

  revokeBrowserSession(token: string): boolean {
    return this.sessions.delete(hashToken(token));
  }

  sweepExpired(): number {
    let removed = 0;
    const now = Date.now();
    for (const [key, session] of [...this.sessions.entries()]) {
      if (session.expiresAt <= now) {
        this.sessions.delete(key);
        removed++;
      }
    }
    return removed;
  }
}
