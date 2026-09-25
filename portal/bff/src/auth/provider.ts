// Thin default identity provider: it only knows how to pull a bearer token off the
// request and hand it to an injected resolver. EPIC-038 replaces the resolver with
// an Entra ID token-validation implementation of `IdentityProvider`; route code
// depends only on the interface in ./identity.ts.

import type { IncomingMessage } from "node:http";
import { readBearerToken, type IdentityProvider, type PortalUser } from "./identity.js";

export type TokenResolver = (token: string) => Promise<PortalUser | null>;

export class BearerIdentityProvider implements IdentityProvider {
  constructor(private readonly resolveToken: TokenResolver) {}

  async authenticate(request: IncomingMessage): Promise<PortalUser | null> {
    const token = readBearerToken(request);
    if (token === null) {
      return null;
    }
    return this.resolveToken(token);
  }
}
