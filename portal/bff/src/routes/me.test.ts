import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import { buildServer, type Route } from "../server.js";
import {
  ME_OPENAPI,
  ME_PATH,
  createMeRoutes,
  effectivePermissions,
  type MeCaller,
} from "./me.js";

function caller(overrides: Partial<MeCaller> = {}): MeCaller {
  return {
    id: "caller-1",
    upn: "caller@example.invalid",
    displayName: "Caller One",
    roles: ["admin"],
    tenantScope: { all: true, tenantIds: [] },
    ...overrides,
  };
}

function routesFor(caller: MeCaller | undefined) {
  return createMeRoutes({ resolveCaller: () => caller });
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

describe("GET /v1/me", () => {
  it("returns the caller's identity, roles, effective permissions, and scope", async () => {
    const baseUrl = await startServer(
      routesFor(
        caller({
          roles: ["admin"],
          tenantScope: tenantScope(["tenant-a", "tenant-b"]),
        }),
      ),
    );

    const response = await fetch(`${baseUrl}/v1/me`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["id"]).toBe("caller-1");
    expect(body["upn"]).toBe("caller@example.invalid");
    expect(body["displayName"]).toBe("Caller One");
    expect(body["roles"]).toEqual(["admin"]);
    expect(body["scope"]).toEqual({ all: false, tenantIds: ["tenant-a", "tenant-b"] });
    const permissions = body["permissions"] as string[];
    expect(permissions).toContain("Tenant.Runs.Read");
    expect(permissions).toContain("CIPP.ApiClients.Read");
  });

  it("resolves effective permissions through the T-0743 base-role table", () => {
    const readonlyPermissions = effectivePermissions(["readonly"]);
    expect(readonlyPermissions).toContain("Tenant.Runs.Read");
    expect(readonlyPermissions).toContain("CIPP.ApiClients.Read");
    expect(readonlyPermissions).not.toContain("Tenant.Runs.ReadWrite");
    expect(readonlyPermissions).not.toContain("Remediation.Apply");

    const editorPermissions = effectivePermissions(["editor"]);
    expect(editorPermissions).toContain("Tenant.Runs.ReadWrite");
    expect(editorPermissions).toContain("CIPP.ApiClients.ReadWrite");
    expect(editorPermissions).not.toContain("Remediation.Apply");

    const superadminPermissions = effectivePermissions(["superadmin"]);
    expect(superadminPermissions).toContain("Remediation.Apply");
    expect(superadminPermissions).toContain("CIPP.ApiClients.ReadWrite");
  });

  it("maps EPIC-001 role ids onto base roles", () => {
    expect(effectivePermissions(["operator"])).toEqual(effectivePermissions(["readonly"]));
    expect(effectivePermissions(["admin"])).toContain("Tenant.Runs.ReadWrite");
  });

  it("returns no effective permissions for unknown roles", () => {
    expect(effectivePermissions(["not-a-role"])).toEqual([]);
  });

  it("requires authentication", async () => {
    const baseUrl = await startServer(routesFor(undefined));
    const response = await fetch(`${baseUrl}/v1/me`);
    expect(response.status).toBe(401);
  });

  it("publishes the /v1/me path through the route module", () => {
    expect(ME_PATH).toBe("/v1/me");
    const operation = ME_OPENAPI.paths["/me"].get;
    expect(operation.operationId).toBe("getCurrentCaller");
  });
});
