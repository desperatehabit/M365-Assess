import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { hashApiClientSecret } from "../rbac/api-client-secret.js";
import { testPortalAccess } from "../rbac/test-portal-access.js";
import {
  ApiClientIdentityProvider,
  authenticateApiClient,
  type ApiClientAuthOptions,
  type ApiClientAuthRecord,
  type ValidatedClientToken,
} from "./api-client-auth.js";

const APP_ID = "client-1";
const AUDIENCE = `api://${APP_ID}/.default`;
const SECRET = "client-secret-value";
const TOKEN = "validated-token";

function record(overrides: Partial<ApiClientAuthRecord> = {}): ApiClientAuthRecord {
  return {
    id: APP_ID,
    secretHash: hashApiClientSecret(SECRET),
    roles: ["admin"],
    ipRanges: ["10.0.0.0/24"],
    enabled: true,
    ...overrides,
  };
}

function options(
  clients: readonly ApiClientAuthRecord[],
  validate: (token: string) => Promise<ValidatedClientToken | null> = async (token) =>
    token === TOKEN ? { appId: APP_ID, audience: AUDIENCE } : null,
): ApiClientAuthOptions {
  const byId = new Map(clients.map((client) => [client.id, client]));
  return {
    expectedAudience: AUDIENCE,
    validateToken: validate,
    store: {
      getApiClient: async (clientId) => byId.get(clientId),
    },
  };
}

async function authError(promise: Promise<unknown>): Promise<AppError> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AppError);
  return thrown as AppError;
}

describe("authenticateApiClient success path", () => {
  it("authenticates a valid client and runs through Test-PortalAccess as its roles", () => {
    return authenticateApiClient(options([record()]), {
      token: TOKEN,
      presentedSecret: SECRET,
      clientIp: "10.0.0.9",
      permission: "Tenant.Read",
    }).then((result) => {
      expect(result.caller.clientId).toBe(APP_ID);
      expect(result.caller.roles).toEqual(["admin"]);
      expect(result.decision?.allowed).toBe(true);
      expect(
        testPortalAccess({ permission: "Tenant.Read", roles: [...result.caller.roles] })
          .allowed,
      ).toBe(true);
    });
  });

  it("denies a permission outside the client roles with the stable code", async () => {
    const error = await authError(
      authenticateApiClient(options([record({ roles: ["readonly"] })]), {
        token: TOKEN,
        presentedSecret: SECRET,
        clientIp: "10.0.0.9",
        permission: "Remediation.Apply",
      }),
    );
    expect(error.code).toBe("auth.forbidden");
    expect(error.status).toBe(403);
  });

  it("skips the permission check when none is requested", async () => {
    const result = await authenticateApiClient(options([record()]), {
      token: TOKEN,
      presentedSecret: SECRET,
      clientIp: "10.0.0.9",
    });
    expect(result.decision).toBeNull();
    expect(result.caller.clientId).toBe(APP_ID);
  });

  it("allows an IPv6 client inside its range and Any from anywhere", async () => {
    const v6 = await authenticateApiClient(
      options([record({ ipRanges: ["2001:db8::/32"] })]),
      { token: TOKEN, presentedSecret: SECRET, clientIp: "2001:db8::5" },
    );
    expect(v6.caller.clientId).toBe(APP_ID);
    const any = await authenticateApiClient(options([record({ ipRanges: ["Any"] })]), {
      token: TOKEN,
      presentedSecret: SECRET,
      clientIp: "203.0.113.7",
    });
    expect(any.caller.clientId).toBe(APP_ID);
  });
});

describe("authenticateApiClient denials", () => {
  it("denies a client outside its IP range for audit", async () => {
    const error = await authError(
      authenticateApiClient(options([record()]), {
        token: TOKEN,
        presentedSecret: SECRET,
        clientIp: "192.168.9.9",
      }),
    );
    expect(error.code).toBe("auth.forbidden");
    expect(error.status).toBe(403);
    expect(error.details).toEqual([{ field: "clientIp", reason: "out_of_range" }]);
  });

  it("denies a disabled client", async () => {
    const error = await authError(
      authenticateApiClient(options([record({ enabled: false })]), {
        token: TOKEN,
        presentedSecret: SECRET,
        clientIp: "10.0.0.9",
      }),
    );
    expect(error.code).toBe("auth.unauthenticated");
    expect(error.status).toBe(401);
  });

  it("denies a bad presented secret", async () => {
    const error = await authError(
      authenticateApiClient(options([record()]), {
        token: TOKEN,
        presentedSecret: "wrong-secret",
        clientIp: "10.0.0.9",
      }),
    );
    expect(error.code).toBe("auth.unauthenticated");
    expect(error.status).toBe(401);
  });

  it("denies an unknown token, an audience mismatch, and an unknown client", async () => {
    const unknownToken = await authError(
      authenticateApiClient(options([record()]), {
        token: "bogus",
        presentedSecret: SECRET,
        clientIp: "10.0.0.9",
      }),
    );
    expect(unknownToken.code).toBe("auth.unauthenticated");

    const mismatch = await authError(
      authenticateApiClient(
        options([record()], async () => ({ appId: APP_ID, audience: "api://other/.default" })),
        { token: TOKEN, presentedSecret: SECRET, clientIp: "10.0.0.9" },
      ),
    );
    expect(mismatch.code).toBe("auth.unauthenticated");

    const unknownClient = await authError(
      authenticateApiClient(
        options([], async () => ({ appId: "missing", audience: AUDIENCE })),
        { token: TOKEN, presentedSecret: SECRET, clientIp: "10.0.0.9" },
      ),
    );
    expect(unknownClient.code).toBe("auth.unauthenticated");
  });
});

describe("ApiClientIdentityProvider", () => {
  function request(headers: Record<string, string | string[]>): IncomingMessage {
    return { headers, socket: { remoteAddress: "10.0.0.9" } } as unknown as IncomingMessage;
  }

  it("resolves the caller from bearer token, secret header, and forwarded IP", async () => {
    const provider = new ApiClientIdentityProvider(options([record()]));
    const caller = await provider.authenticate(
      request({
        authorization: `Bearer ${TOKEN}`,
        "x-client-secret": SECRET,
        "x-forwarded-for": "10.0.0.9, 198.51.100.1",
      }),
    );
    expect(caller?.clientId).toBe(APP_ID);
    expect(caller?.roles).toEqual(["admin"]);
  });

  it("returns null without a token, with a bad secret, or from a denied IP", async () => {
    const provider = new ApiClientIdentityProvider(options([record()]));
    await expect(
      provider.authenticate(
        request({ "x-client-secret": SECRET, "x-forwarded-for": "10.0.0.9" }),
      ),
    ).resolves.toBeNull();
    await expect(
      provider.authenticate(
        request({
          authorization: `Bearer ${TOKEN}`,
          "x-client-secret": "wrong-secret",
          "x-forwarded-for": "10.0.0.9",
        }),
      ),
    ).resolves.toBeNull();
    await expect(
      provider.authenticate(
        request({
          authorization: `Bearer ${TOKEN}`,
          "x-client-secret": SECRET,
          "x-forwarded-for": "192.168.9.9",
        }),
      ),
    ).resolves.toBeNull();
  });
});
