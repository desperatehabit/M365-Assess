// Authentication seam (EPIC-001 SPEC.md §7): resolves *who* the portal user is.
// Deliberately thin so EPIC-038 can drop in the Entra ID provider without route
// code changing. Bearer tokens are passed through to the provider and never
// logged, echoed, or attached to the caller object.

import type { IncomingMessage } from "node:http";
import { AppError } from "../errors.js";
import type { Caller } from "../rbac/authorize.js";

export interface PortalUser extends Caller {
  readonly id: string;
  readonly upn: string;
  readonly displayName?: string;
}

export interface IdentityProvider {
  authenticate(request: IncomingMessage): Promise<PortalUser | null>;
}

export const AuthErrorCodes = {
  unauthenticated: "auth.unauthenticated",
} as const;

export function readBearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  const token = match?.[1]?.trim();
  return token === undefined || token.length === 0 ? null : token;
}

export async function requireCaller(
  provider: IdentityProvider,
  request: IncomingMessage,
): Promise<PortalUser> {
  const caller = await provider.authenticate(request);
  if (caller === null) {
    throw new AppError(AuthErrorCodes.unauthenticated, "authentication required", 401);
  }
  return caller;
}
