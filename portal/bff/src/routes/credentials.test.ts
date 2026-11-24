import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import type { Route, RouteHandler, RouteResponse } from "../server.js";
import { createInMemoryCredentialStore, createOsKeystoreCredentialStore } from "../credentials/store.js";
import {
  CREDENTIAL_UNSUPPORTED,
  CREDENTIALS_OPENAPI,
  CREDENTIALS_PERMISSION,
  TENANT_CREDENTIAL_PATH,
  TENANT_CREDENTIALS_PATH,
  createCredentialRoutes,
  type CredentialAuditInput,
  type CredentialCaller,
  type CredentialRecord,
  type CredentialRouteOptions,
  type CredentialStoreRow,
} from "./credentials.js";

const NOW = "2026-06-01T00:00:00.000Z";
const SECRET = "super-secret-client-value-9f8e7d6c5b4a";

class MemoryCredentialRows implements CredentialStoreRow {
  readonly records = new Map<string, CredentialRecord>();
  readonly events: CredentialAuditInput[] = [];

  private key(tenantId: string, purpose: CredentialRecord["purpose"] = "reader"): string {
    return `${tenantId}:${purpose ?? "reader"}`;
  }

  async getCredential(
    tenantId: string,
    purpose: CredentialRecord["purpose"] = "reader",
  ): Promise<CredentialRecord | undefined> {
    const found = this.records.get(this.key(tenantId, purpose));
    return found === undefined ? undefined : { ...found };
  }

  async listCredentials(tenantId: string): Promise<CredentialRecord[]> {
    return [...this.records.values()].filter((row) => row.tenantId === tenantId).map((row) => ({ ...row }));
  }

  async upsertCredential(input: CredentialRecord): Promise<CredentialRecord> {
    const stored = { ...input };
    this.records.set(this.key(stored.tenantId, stored.purpose), stored);
    return { ...stored };
  }

  async deleteCredential(
    tenantId: string,
    purpose: CredentialRecord["purpose"],
  ): Promise<boolean> {
    return this.records.delete(this.key(tenantId, purpose));
  }

  async appendAuditEvent(input: CredentialAuditInput): Promise<unknown> {
    this.events.push(input);
    return { ...input };
  }
}

function adminCaller(): CredentialCaller {
  return { roles: ["admin"], tenantScope: ALL_TENANTS, userId: "operator-1" };
}

interface Harness {
  routes: Route[];
  rows: MemoryCredentialRows;
  secrets: ReturnType<typeof createInMemoryCredentialStore>;
  seenPermissions: string[];
}

function harness(overrides: Partial<CredentialRouteOptions> = {}): Harness {
  const rows = new MemoryCredentialRows();
  const secrets = createInMemoryCredentialStore();
  const seenPermissions: string[] = [];
  const routes = createCredentialRoutes({
    records: rows,
    secrets,
    resolveCaller: () => adminCaller(),
    authorize: (caller, permission) => {
      void caller;
      seenPermissions.push(permission);
    },
    now: () => NOW,
    ...overrides,
  });
  return { routes, rows, secrets, seenPermissions };
}

interface TestContext {
  correlationId: string;
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  params: Record<string, string>;
  body?: unknown;
}

type HandlerContext = Parameters<RouteHandler>[0];

function context(overrides: Partial<TestContext> = {}): HandlerContext {
  return {
    correlationId: "corr-test",
    method: "POST",
    path: TENANT_CREDENTIAL_PATH,
    query: new URLSearchParams(),
    headers: {},
    params: { id: "tenant-a" },
    ...overrides,
  } as unknown as HandlerContext;
}

function invoke(
  routes: readonly Route[],
  overrides: Partial<TestContext> = {},
): Promise<RouteResponse> {
  return invokeRoute(routes, "POST", TENANT_CREDENTIAL_PATH, overrides);
}

function invokeRoute(
  routes: readonly Route[],
  method: string,
  path: string,
  overrides: Partial<TestContext> = {},
): Promise<RouteResponse> {
  const route = routes.find(
    (candidate) => candidate.method === method && candidate.path === path,
  );
  if (route === undefined) {
    throw new Error(`no route registered for ${method} ${path}`);
  }
  return Promise.resolve(route.handler(context({ ...overrides, method, path })));
}

function credentialRecord(
  tenantId: string,
  purpose: "reader" | "operator",
  overrides: Partial<CredentialRecord> = {},
): CredentialRecord {
  return {
    id: `${tenantId}-${purpose}`,
    tenantId,
    authMethod: "certificate-thumbprint",
    clientId: `${purpose}-client`,
    secretRef: `cert://thumbprint/${purpose}`,
    thumbprint: "ABC123",
    environment: "commercial",
    expiresOn: null,
    lastValidated: null,
    purpose,
    permissionGroups: purpose === "operator" ? ["identity"] : null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("credential routes", () => {
  it("sets a certificate credential and returns a reference without secret material", async () => {
    const value = harness();
    const response = await invoke(value.routes, {
      body: { authMethod: "certificate-thumbprint", clientId: "client-a", thumbprint: "ABC123" },
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      tenantId: "tenant-a",
      authMethod: "certificate-thumbprint",
      clientId: "client-a",
      thumbprint: "ABC123",
      environment: "commercial",
    });
    expect(response.body).not.toHaveProperty("clientSecret");
    expect(response.body).not.toHaveProperty("certificatePassword");
    expect((response.body as Record<string, unknown>)["secretRef"]).toMatch(/^cert:\/\//);
  });

  it("sets a client secret by reference and rotates it with a fresh reference", async () => {
    const value = harness();
    const first = await invoke(value.routes, {
      body: { authMethod: "client-secret", clientId: "client-a", clientSecret: SECRET },
    });
    expect(first.status).toBe(201);
    const firstRef = (first.body as Record<string, unknown>)["secretRef"];
    expect(typeof firstRef).toBe("string");
    expect(firstRef).toMatch(/^ref:\/\//);
    expect(await value.secrets.readSecret(firstRef as string)).toBe(SECRET);

    const second = await invoke(value.routes, {
      body: { authMethod: "client-secret", clientId: "client-a", clientSecret: `${SECRET}-rotated` },
    });
    expect(second.status).toBe(200);
    const secondRef = (second.body as Record<string, unknown>)["secretRef"];
    expect(secondRef).not.toBe(firstRef);
    expect(await value.secrets.readSecret(secondRef as string)).toBe(`${SECRET}-rotated`);
    expect(await value.secrets.readSecret(firstRef as string)).toBeNull();
  });

  it("never leaks the secret value into responses, rows, or audit events", async () => {
    const value = harness();
    const response = await invoke(value.routes, {
      body: { authMethod: "client-secret", clientId: "client-a", clientSecret: SECRET },
    });
    expect(JSON.stringify(response.body)).not.toContain(SECRET);
    for (const row of value.rows.records.values()) {
      expect(JSON.stringify(row)).not.toContain(SECRET);
    }
    for (const event of value.rows.events) {
      expect(JSON.stringify(event)).not.toContain(SECRET);
    }
  });

  it("rejects a client secret for Exchange Online and Purview sections with a clear error", async () => {
    const value = harness();
    const attempt = invoke(value.routes, {
      body: {
        authMethod: "client-secret",
        clientId: "client-a",
        clientSecret: SECRET,
        sections: ["Email", "Identity"],
      },
    });
    await expect(attempt).rejects.toMatchObject({ code: CREDENTIAL_UNSUPPORTED, status: 400 });
    await expect(attempt).rejects.toSatisfy((error: Error) =>
      /certificate auth/i.test(error.message),
    );
    expect(value.rows.records.size).toBe(0);
    expect(value.rows.events).toHaveLength(0);
    expect(await value.secrets.readSecret("ref://tenants/tenant-a/credential/x")).toBeNull();
  });

  it("accepts a client secret for Graph-only sections", async () => {
    const value = harness();
    const response = await invoke(value.routes, {
      body: {
        authMethod: "client-secret",
        clientId: "client-a",
        clientSecret: SECRET,
        sections: ["Identity"],
      },
    });
    expect(response.status).toBe(201);
  });

  it("derives the expiry state on the returned reference", async () => {
    const value = harness();
    const inDays = (days: number): string =>
      new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    const expiring = await invoke(value.routes, {
      body: {
        authMethod: "certificate-thumbprint",
        clientId: "client-a",
        thumbprint: "ABC123",
        expiresOn: inDays(10),
      },
    });
    expect(expiring.body).toMatchObject({ state: "expiring" });

    const valid = await invoke(value.routes, {
      params: { id: "tenant-b" },
      body: {
        authMethod: "certificate-thumbprint",
        clientId: "client-a",
        thumbprint: "ABC123",
        expiresOn: inDays(100),
      },
    });
    expect(valid.body).toMatchObject({ state: "valid" });
  });

  it("writes an audit event for set and rotate", async () => {
    const value = harness();
    await invoke(value.routes, {
      body: { authMethod: "certificate-thumbprint", clientId: "client-a", thumbprint: "ABC123" },
    });
    await invoke(value.routes, {
      body: { authMethod: "certificate-thumbprint", clientId: "client-a", thumbprint: "DEF456" },
    });
    expect(value.rows.events.map((event) => event.action)).toEqual([
      "tenant.credential.set",
      "tenant.credential.rotate",
    ]);
    for (const event of value.rows.events) {
      expect(event).toMatchObject({
        actorUserId: "operator-1",
        actorType: "user",
        tenantId: "tenant-a",
        targetType: "tenant-credential",
        targetId: "tenant-a",
        result: "success",
        source: "request",
        correlationId: "corr-test",
      });
      expect(JSON.stringify(event)).not.toContain(SECRET);
    }
    expect(value.rows.events[1]?.before).toMatchObject({ thumbprint: "ABC123" });
    expect(value.rows.events[1]?.after).toMatchObject({ thumbprint: "DEF456" });
  });

  it("requires authentication, scope, and the credentials permission", async () => {
    const unauthenticated = harness({ resolveCaller: () => undefined });
    await expect(
      invoke(unauthenticated.routes, {
        body: { authMethod: "certificate-thumbprint", clientId: "c", thumbprint: "T" },
      }),
    ).rejects.toMatchObject({ status: 401 });

    const scoped = harness({
      resolveCaller: () => ({
        roles: ["admin"] as const,
        tenantScope: tenantScope(["tenant-other"]),
        userId: "operator-2",
      }),
    });
    await expect(
      invoke(scoped.routes, {
        body: { authMethod: "certificate-thumbprint", clientId: "c", thumbprint: "T" },
      }),
    ).rejects.toMatchObject({ code: "auth.forbidden", status: 403 });

    const value = harness();
    await invoke(value.routes, {
      body: { authMethod: "certificate-thumbprint", clientId: "c", thumbprint: "T" },
    });
    expect(value.seenPermissions).toContain(CREDENTIALS_PERMISSION);
  });

  it("validates method-specific fields", async () => {
    const value = harness();
    await expect(
      invoke(value.routes, { body: { authMethod: "bogus", clientId: "c" } }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      invoke(value.routes, { body: { authMethod: "certificate-thumbprint", clientId: "c" } }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      invoke(value.routes, { body: { authMethod: "client-secret", clientId: "c" } }),
    ).rejects.toMatchObject({ status: 400 });
    expect(value.rows.events).toHaveLength(0);
  });

  it("lists every credential purpose with its granted write groups", async () => {
    const value = harness();
    await value.rows.upsertCredential(credentialRecord("tenant-a", "reader"));
    await value.rows.upsertCredential(
      credentialRecord("tenant-a", "operator", {
        clientId: "operator-client",
        permissionGroups: ["identity", "exchange"],
      }),
    );

    const response = await invokeRoute(value.routes, "GET", TENANT_CREDENTIALS_PATH);
    expect(response.status).toBe(200);
    const items = (
      response.body as {
        items: Array<{ purpose?: string; permissionGroups?: string[]; clientId?: string }>;
      }
    ).items;
    expect(items).toHaveLength(2);
    const operator = items.find((item) => item.purpose === "operator");
    const reader = items.find((item) => item.purpose === "reader");
    expect(operator?.permissionGroups).toEqual(["identity", "exchange"]);
    expect(reader?.permissionGroups).toEqual([]);
    expect(operator?.clientId).toBe("operator-client");
    expect(value.seenPermissions).toContain(CREDENTIALS_PERMISSION);
  });

  it("keeps the single GET reader-by-default", async () => {
    const value = harness();
    await value.rows.upsertCredential(credentialRecord("tenant-a", "reader"));
    await value.rows.upsertCredential(credentialRecord("tenant-a", "operator"));

    const response = await invokeRoute(value.routes, "GET", TENANT_CREDENTIAL_PATH);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ purpose: "reader", clientId: "reader-client" });
  });

  it("deletes only the operator credential and records an audit event", async () => {
    const value = harness();
    await value.rows.upsertCredential(credentialRecord("tenant-a", "reader"));
    await value.rows.upsertCredential(
      credentialRecord("tenant-a", "operator", {
        permissionGroups: ["identity", "intune"],
      }),
    );

    const response = await invokeRoute(value.routes, "DELETE", TENANT_CREDENTIAL_PATH, {
      method: "DELETE",
      query: new URLSearchParams({ purpose: "operator" }),
    });

    expect(response.status).toBe(204);
    expect(await value.rows.getCredential("tenant-a", "operator")).toBeUndefined();
    expect(await value.rows.getCredential("tenant-a", "reader")).toBeDefined();
    expect(value.rows.events).toHaveLength(1);
    expect(value.rows.events[0]).toMatchObject({
      action: "tenant.credential.delete",
      actorUserId: "operator-1",
      actorType: "user",
      tenantId: "tenant-a",
      targetType: "tenant-credential",
      targetId: "tenant-a",
      before: { purpose: "operator", permissionGroups: ["identity", "intune"] },
      after: null,
      result: "success",
      source: "request",
      correlationId: "corr-test",
    });
  });

  it("refuses any purpose other than operator with 400 and leaves both rows", async () => {
    const value = harness();
    await value.rows.upsertCredential(credentialRecord("tenant-a", "reader"));
    await value.rows.upsertCredential(credentialRecord("tenant-a", "operator"));

    for (const query of [
      new URLSearchParams(),
      new URLSearchParams({ purpose: "reader" }),
      new URLSearchParams({ purpose: "all" }),
    ]) {
      await expect(
        invokeRoute(value.routes, "DELETE", TENANT_CREDENTIAL_PATH, {
          method: "DELETE",
          query,
        }),
      ).rejects.toMatchObject({ status: 400 });
    }

    expect(await value.rows.getCredential("tenant-a", "reader")).toBeDefined();
    expect(await value.rows.getCredential("tenant-a", "operator")).toBeDefined();
    expect(value.rows.events).toHaveLength(0);
  });

  it("returns 404 when the operator credential is absent", async () => {
    const value = harness();
    await value.rows.upsertCredential(credentialRecord("tenant-a", "reader"));

    await expect(
      invokeRoute(value.routes, "DELETE", TENANT_CREDENTIAL_PATH, {
        method: "DELETE",
        query: new URLSearchParams({ purpose: "operator" }),
      }),
    ).rejects.toMatchObject({ code: "credential.not_found", status: 404 });
    expect(value.rows.events).toHaveLength(0);
  });

  it("requires authentication, scope, and the credentials permission for list and delete", async () => {
    const unauthenticated = harness({ resolveCaller: () => undefined });
    await expect(
      invokeRoute(unauthenticated.routes, "GET", TENANT_CREDENTIALS_PATH),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      invokeRoute(unauthenticated.routes, "DELETE", TENANT_CREDENTIAL_PATH, {
        method: "DELETE",
        query: new URLSearchParams({ purpose: "operator" }),
      }),
    ).rejects.toMatchObject({ status: 401 });

    const scoped = harness({
      resolveCaller: () => ({
        roles: ["admin"] as const,
        tenantScope: tenantScope(["tenant-other"]),
        userId: "operator-2",
      }),
    });
    await expect(
      invokeRoute(scoped.routes, "GET", TENANT_CREDENTIALS_PATH),
    ).rejects.toMatchObject({ code: "auth.forbidden", status: 403 });
  });

  it("publishes the OpenAPI set/rotate, list, and delete operations", () => {
    expect(CREDENTIALS_OPENAPI.paths["/tenants/{id}/credential"]).toHaveProperty("post");
    expect(CREDENTIALS_OPENAPI.paths["/tenants/{id}/credential"]).toHaveProperty("get");
    expect(CREDENTIALS_OPENAPI.paths["/tenants/{id}/credential"]).toHaveProperty("delete");
    expect(CREDENTIALS_OPENAPI.paths["/tenants/{id}/credentials"]).toHaveProperty("get");
    expect(CREDENTIALS_OPENAPI.paths["/tenants/{id}/credential"].post.permission).toBe(
      CREDENTIALS_PERMISSION,
    );
    expect(CREDENTIALS_OPENAPI.paths["/tenants/{id}/credential"].delete.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "purpose",
          in: "query",
          schema: { type: "string", enum: ["operator"] },
        }),
      ]),
    );
  });
});

describe("credential store backends", () => {
  it("round-trips material by reference and forgets it on delete", async () => {
    const store = createInMemoryCredentialStore();
    expect(await store.readSecret("ref://missing")).toBeNull();
    await store.writeSecret("ref://tenants/tenant-a/credential/1", SECRET);
    expect(await store.readSecret("ref://tenants/tenant-a/credential/1")).toBe(SECRET);
    await store.deleteSecret("ref://tenants/tenant-a/credential/1");
    expect(await store.readSecret("ref://tenants/tenant-a/credential/1")).toBeNull();
  });

  it("persists OS-keystore material outside the database row", async () => {
    const store = createOsKeystoreCredentialStore({
      directory: mkdtempSync(join(tmpdir(), "cred-store-")),
    });
    const ref = "ref://tenants/tenant-a/credential/1";
    await store.writeSecret(ref, SECRET);
    expect(await store.readSecret(ref)).toBe(SECRET);
    await store.deleteSecret(ref);
    expect(await store.readSecret(ref)).toBeNull();
  });
});
