import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError, ErrorCodes, toErrorBody } from "../errors.js";
import { ALL_TENANTS } from "../rbac/scope.js";
import {
  AuthErrorCodes,
  readBearerToken,
  requireCaller,
  type IdentityProvider,
  type PortalUser,
} from "./identity.js";
import { BearerIdentityProvider } from "./provider.js";

const caller: PortalUser = {
  id: "user-1",
  upn: "operator@contoso.example",
  roles: ["operator"],
  tenantScope: ALL_TENANTS,
};

function request(authorization?: string): IncomingMessage {
  return { headers: authorization === undefined ? {} : { authorization } } as IncomingMessage;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readBearerToken", () => {
  it("extracts the bearer token, case-insensitively", () => {
    expect(readBearerToken(request("Bearer abc.def"))).toBe("abc.def");
    expect(readBearerToken(request("bearer spaced-token"))).toBe("spaced-token");
  });

  it("returns null when there is no usable token", () => {
    expect(readBearerToken(request())).toBeNull();
    expect(readBearerToken(request("Basic abc"))).toBeNull();
    expect(readBearerToken(request("Bearer   "))).toBeNull();
  });
});

describe("BearerIdentityProvider", () => {
  it("resolves the caller from the bearer token", async () => {
    const resolveToken = vi.fn(async (token: string) =>
      token === "good-token" ? caller : null,
    );
    const provider = new BearerIdentityProvider(resolveToken);

    await expect(provider.authenticate(request("Bearer good-token"))).resolves.toBe(caller);
    await expect(provider.authenticate(request("Bearer bad-token"))).resolves.toBeNull();
  });

  it("does not call the resolver without a token", async () => {
    const resolveToken = vi.fn(async () => caller);
    const provider = new BearerIdentityProvider(resolveToken);

    await expect(provider.authenticate(request())).resolves.toBeNull();
    expect(resolveToken).not.toHaveBeenCalled();
  });
});

describe("requireCaller", () => {
  it("returns the caller when authenticated", async () => {
    const provider: IdentityProvider = { authenticate: async () => caller };
    await expect(requireCaller(provider, request("Bearer good-token"))).resolves.toBe(caller);
  });

  it("throws a structured 401 when unauthenticated", async () => {
    const provider: IdentityProvider = { authenticate: async () => null };

    let thrown: unknown;
    try {
      await requireCaller(provider, request());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    const appError = thrown as AppError;
    expect(appError.code).toBe(AuthErrorCodes.unauthenticated);
    expect(appError.status).toBe(401);
    expect(toErrorBody(appError, "corr-2")).toEqual({
      code: "auth.unauthenticated",
      message: "authentication required",
      correlationId: "corr-2",
    });
    expect(ErrorCodes.internalError).not.toBe(AuthErrorCodes.unauthenticated);
  });
});

describe("secret handling", () => {
  it("never logs the bearer token and never puts it on the caller", async () => {
    const token = "super-secret-token-value";
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "debug").mockImplementation(() => {}),
    ];
    const provider = new BearerIdentityProvider(async () => caller);

    const resolved = await provider.authenticate(request(`Bearer ${token}`));

    expect(resolved).toBe(caller);
    for (const spy of spies) {
      const logged = spy.mock.calls.flat().map((value) => String(value));
      expect(logged.join(" ")).not.toContain(token);
      expect(spy).not.toHaveBeenCalled();
    }
    expect(Object.values(resolved as object)).not.toContain(token);
    expect(JSON.stringify(resolved)).not.toContain(token);
  });
});
