import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import { buildServer, type Route } from "../server.js";
import {
  ACCESS_CHECK_OPENAPI,
  ACCESS_CHECK_PATH,
  createAccessRoutes,
  type AccessCaller,
} from "./access.js";

function caller(overrides: Partial<AccessCaller> = {}): AccessCaller {
  return {
    id: "caller-1",
    upn: "caller@example.invalid",
    displayName: "Caller One",
    roles: ["admin"],
    tenantScope: { all: true, tenantIds: [] },
    ...overrides,
  };
}

function capturingAudit() {
  const events: Record<string, unknown>[] = [];
  return {
    events,
    recordAccess: async (event: Record<string, unknown>) => {
      events.push(event);
    },
  };
}

function routesFor(callerValue: AccessCaller | undefined, recordAccess: (event: Record<string, unknown>) => Promise<void>) {
  return createAccessRoutes({ resolveCaller: () => callerValue, recordAccess });
}

const openServers: Server[] = [];

async function startServer(routes: readonly Route[]) {
  const server = buildServer({ routes });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  openServers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function postAccess(baseUrl: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/v1/access/check`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/access/check", () => {
  it("returns the same decision the endpoint would enforce for an allowed permission", async () => {
    const audit = capturingAudit();
    const baseUrl = await startServer(routesFor(caller({ roles: ["readonly"] }), audit.recordAccess));

    const response = await postAccess(baseUrl, { permission: "Tenant.Read" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["allowed"]).toBe(true);
    expect(body["code"]).toBe("auth.allowed");
    expect(body["permission"]).toBe("Tenant.Read");
    expect(body["matchedRoles"]).toEqual(["readonly"]);
  });

  it("returns allowed false with the stable forbidden code for a denied permission", async () => {
    const audit = capturingAudit();
    const baseUrl = await startServer(routesFor(caller({ roles: ["editor"] }), audit.recordAccess));

    const response = await postAccess(baseUrl, { permission: "Remediation.Apply" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["allowed"]).toBe(false);
    expect(body["code"]).toBe("auth.forbidden");
    expect(body["matchedRoles"]).toEqual([]);
  });

  it("audits the RBAC allow decision with the §4.5 fields", async () => {
    const audit = capturingAudit();
    const baseUrl = await startServer(routesFor(caller({ roles: ["readonly"] }), audit.recordAccess));

    const response = await postAccess(baseUrl, { permission: "Tenant.Read" }, { "x-correlation-id": "corr-42" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-correlation-id")).toBe("corr-42");

    expect(audit.events).toHaveLength(1);
    const event = audit.events[0]!;
    expect(event["actorType"]).toBe("user");
    expect(event["actor"]).toBe("caller-1");
    expect(event["action"]).toBe("access.check");
    expect(event["targetId"]).toBe("Tenant.Read");
    expect(event["result"]).toBe("success");
    expect(event["correlationId"]).toBe("corr-42");
    const after = event["after"] as Record<string, unknown>;
    expect(after["roles"]).toEqual(["readonly"]);
    expect(after["check"]).toBe("rbac");
  });

  it("audits the RBAC deny decision with result failure", async () => {
    const audit = capturingAudit();
    const baseUrl = await startServer(routesFor(caller({ roles: ["editor"] }), audit.recordAccess));

    await postAccess(baseUrl, { permission: "Remediation.Apply" });

    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]!["result"]).toBe("failure");
    const after = audit.events[0]!["after"] as Record<string, unknown>;
    expect(after["allowed"]).toBe(false);
    expect(after["check"]).toBe("rbac");
  });

  it("audits a denied request from both the RBAC and the scope path", async () => {
    const audit = capturingAudit();
    const baseUrl = await startServer(
      routesFor(caller({ roles: ["editor"], tenantScope: tenantScope(["tenant-a"]) }), audit.recordAccess),
    );

    const response = await postAccess(baseUrl, { permission: "Remediation.Apply", tenantId: "tenant-b" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["allowed"]).toBe(false);
    expect(body["tenantId"]).toBe("tenant-b");
    expect(body["tenantAllowed"]).toBe(false);

    expect(audit.events).toHaveLength(2);
    const checks = audit.events.map((event) => (event["after"] as Record<string, unknown>)["check"]);
    expect(checks).toEqual(["rbac", "scope"]);
    expect(audit.events.every((event) => event["result"] === "failure")).toBe(true);
    expect(audit.events.every((event) => event["tenantId"] === "tenant-b")).toBe(true);
  });

  it("audits the scope allow decision when the tenant is in scope", async () => {
    const audit = capturingAudit();
    const baseUrl = await startServer(
      routesFor(caller({ roles: ["admin"], tenantScope: tenantScope(["tenant-a"]) }), audit.recordAccess),
    );

    const response = await postAccess(baseUrl, { permission: "Tenant.Read", tenantId: "tenant-a" });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["allowed"]).toBe(true);
    expect(body["tenantAllowed"]).toBe(true);

    expect(audit.events).toHaveLength(2);
    expect(audit.events[0]!["result"]).toBe("success");
    expect(audit.events[1]!["result"]).toBe("success");
    expect((audit.events[1]!["after"] as Record<string, unknown>)["check"]).toBe("scope");
  });

  it("records the client IP from x-forwarded-for on the audit row", async () => {
    const audit = capturingAudit();
    const baseUrl = await startServer(routesFor(caller({ roles: ["admin"] }), audit.recordAccess));

    await postAccess(baseUrl, { permission: "Tenant.Read" }, { "x-forwarded-for": "203.0.113.7, 10.0.0.1" });

    const after = audit.events[0]!["after"] as Record<string, unknown>;
    expect(after["ip"]).toBe("203.0.113.7");
  });

  it("audits api clients with actorType apiClient", async () => {
    const audit = capturingAudit();
    const baseUrl = await startServer(
      routesFor(caller({ kind: "api-client", clientId: "client-9", id: undefined, roles: ["readonly"] }), audit.recordAccess),
    );

    await postAccess(baseUrl, { permission: "Tenant.Read" });

    expect(audit.events[0]!["actorType"]).toBe("apiClient");
    expect(audit.events[0]!["actor"]).toBe("client-9");
  });

  it("requires authentication", async () => {
    const audit = capturingAudit();
    const baseUrl = await startServer(routesFor(undefined, audit.recordAccess));

    const response = await postAccess(baseUrl, { permission: "Tenant.Read" });
    expect(response.status).toBe(401);
    expect(audit.events).toHaveLength(0);
  });

  it("rejects a missing permission with 400", async () => {
    const audit = capturingAudit();
    const baseUrl = await startServer(routesFor(caller(), audit.recordAccess));

    const response = await postAccess(baseUrl, {});
    expect(response.status).toBe(400);
    expect(audit.events).toHaveLength(0);
  });

  it("rejects a non-string tenantId with 400", async () => {
    const audit = capturingAudit();
    const baseUrl = await startServer(routesFor(caller(), audit.recordAccess));

    const response = await postAccess(baseUrl, { permission: "Tenant.Read", tenantId: 42 });
    expect(response.status).toBe(400);
  });

  it("publishes the /v1/access/check path through the route module", () => {
    expect(ACCESS_CHECK_PATH).toBe("/v1/access/check");
    const operation = ACCESS_CHECK_OPENAPI.paths["/access/check"].post;
    expect(operation.operationId).toBe("checkAccess");
    expect(operation.security).toEqual([{ bearerAuth: [] }]);
  });
});
