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

  async getCredential(tenantId: string): Promise<CredentialRecord | undefined> {
    const found = this.records.get(tenantId);
    return found === undefined ? undefined : { ...found };
  }

  async upsertCredential(input: CredentialRecord): Promise<CredentialRecord> {
    const stored = { ...input };
    this.records.set(stored.tenantId, stored);
    return { ...stored };
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
  const route = routes.find(
    (candidate) =>
      candidate.method === "POST" && candidate.path === TENANT_CREDENTIAL_PATH,
  );
  if (route === undefined) {
    throw new Error("no route registered for POST credential");
  }
  return Promise.resolve(route.handler(context(overrides)));
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

  it("publishes the OpenAPI set/rotate operation", () => {
    expect(CREDENTIALS_OPENAPI.paths["/tenants/{id}/credential"]).toHaveProperty("post");
    expect(CREDENTIALS_OPENAPI.paths["/tenants/{id}/credential"].post.permission).toBe(
      CREDENTIALS_PERMISSION,
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
