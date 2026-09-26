import { describe, expect, it } from "vitest";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import type { RequestContext, Route } from "../server.js";
import type { CredentialRecord, CredentialStoreRow } from "./credentials.js";
import type { TenantAuditInput, TenantRecord, TenantStore } from "./tenants.js";
import {
  CREDENTIAL_NOT_FOUND,
  createTestConnectionRoutes,
  DEFAULT_ERROR_THRESHOLD,
  TENANT_NOT_FOUND,
  TEST_CONNECTION_OPENAPI,
  TEST_CONNECTION_PATH,
  TEST_CONNECTION_PERMISSION,
  TEST_CONNECTION_UNAUTHENTICATED,
  type TestConnectionCaller,
  type TestConnectionResult,
  type TestConnectionRouteOptions,
  type TestConnectionRunner,
} from "./test-connection.js";

const NOW = "2026-06-01T12:00:00.000Z";
const TENANT_ID = "00000000-0000-0000-0000-000000000001";

class MemoryTenantStore implements TenantStore {
  readonly records = new Map<string, TenantRecord>();
  readonly events: TenantAuditInput[] = [];

  async listTenants(): Promise<TenantRecord[]> {
    return [...this.records.values()];
  }

  async getTenant(tenantId: string): Promise<TenantRecord | undefined> {
    const found = this.records.get(tenantId);
    if (!found || found.deletedAt !== null) return undefined;
    return { ...found };
  }

  async upsertTenant(input: TenantRecord): Promise<TenantRecord> {
    const stored = { ...input };
    this.records.set(stored.id, stored);
    return { ...stored };
  }

  async softDeleteTenant(tenantId: string): Promise<boolean> {
    const found = this.records.get(tenantId);
    if (!found) return false;
    found.deletedAt = NOW;
    return true;
  }

  async appendAuditEvent(input: TenantAuditInput): Promise<any> {
    this.events.push(input);
    return input;
  }
}

class MemoryCredentialStore implements CredentialStoreRow {
  readonly records = new Map<string, CredentialRecord>();

  async getCredential(tenantId: string): Promise<CredentialRecord | undefined> {
    const found = this.records.get(tenantId);
    return found ? { ...found } : undefined;
  }

  async upsertCredential(input: CredentialRecord): Promise<CredentialRecord> {
    const stored = { ...input };
    this.records.set(stored.tenantId, stored);
    return { ...stored };
  }

  async appendAuditEvent(): Promise<unknown> {
    return {};
  }
}

function sampleTenant(overrides: Partial<TenantRecord> = {}): TenantRecord {
  return {
    id: TENANT_ID,
    displayName: "Contoso Corp",
    defaultDomain: "contoso.com",
    initialDomain: "contoso.onmicrosoft.com",
    source: "direct",
    status: "active",
    excluded: false,
    excludeReason: null,
    excludeDate: null,
    environment: "commercial",
    lastRunAt: null,
    errorCount: 0,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function sampleCredential(overrides: Partial<CredentialRecord> = {}): CredentialRecord {
  return {
    id: "cred-1",
    tenantId: TENANT_ID,
    authMethod: "certificate-thumbprint",
    clientId: "client-id-1",
    secretRef: "ref://cred-1",
    thumbprint: "THUMBPRINT123",
    environment: "commercial",
    expiresOn: "2027-01-01T00:00:00.000Z",
    lastValidated: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function adminCaller(): TestConnectionCaller {
  return { roles: ["admin"], tenantScope: ALL_TENANTS, userId: "operator-1" };
}

interface Harness {
  routes: Route[];
  tenants: MemoryTenantStore;
  credentials: MemoryCredentialStore;
  runnerCalls: { tenantId: string; cred?: CredentialRecord }[];
  seenPermissions: string[];
}

function createHarness(
  runnerResult: TestConnectionResult,
  overrides: Partial<TestConnectionRouteOptions> = {},
): Harness {
  const tenants = new MemoryTenantStore();
  const credentials = new MemoryCredentialStore();
  const runnerCalls: { tenantId: string; cred?: CredentialRecord }[] = [];
  const seenPermissions: string[] = [];

  const runner: TestConnectionRunner = async (tenantId, cred) => {
    runnerCalls.push({ tenantId, cred });
    return runnerResult;
  };

  const routes = createTestConnectionRoutes({
    tenantStore: tenants,
    credentialStore: credentials,
    runner,
    resolveCaller: () => adminCaller(),
    authorize: (_caller, perm) => {
      seenPermissions.push(perm);
    },
    now: () => NOW,
    errorThreshold: DEFAULT_ERROR_THRESHOLD,
    ...overrides,
  });

  return { routes, tenants, credentials, runnerCalls, seenPermissions };
}

function makeContext(params: Record<string, string>): RequestContext {
  return {
    method: "POST",
    path: `/v1/tenants/${params.id}/test-connection`,
    params,
    query: new URLSearchParams(),
    headers: { "x-correlation-id": "test-corr-1" },
  };
}

describe("Test connection route (T-0024)", () => {
  it("returns per-service pass/fail and does not overwrite tenant configuration", async () => {
    const successResult: TestConnectionResult = {
      tenantId: TENANT_ID,
      success: true,
      testedAt: NOW,
      services: [
        { service: "Graph", status: "pass", connected: true, error: null },
        { service: "ExchangeOnline", status: "pass", connected: true, error: null },
        { service: "Purview", status: "pass", connected: true, error: null },
      ],
    };
    const h = createHarness(successResult);
    await h.tenants.upsertTenant(sampleTenant());
    await h.credentials.upsertCredential(sampleCredential());

    const route = h.routes[0];
    const res = await route.handler(makeContext({ id: TENANT_ID }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(successResult);

    // Verify tenant configuration was not changed
    const tenant = await h.tenants.getTenant(TENANT_ID);
    expect(tenant?.displayName).toBe("Contoso Corp");
    expect(tenant?.defaultDomain).toBe("contoso.com");
    expect(tenant?.initialDomain).toBe("contoso.onmicrosoft.com");
    expect(tenant?.environment).toBe("commercial");
  });

  it("records lastValidated and resets errorCount on successful test", async () => {
    const successResult: TestConnectionResult = {
      tenantId: TENANT_ID,
      success: true,
      testedAt: NOW,
      services: [
        { service: "Graph", status: "pass", connected: true, error: null },
        { service: "ExchangeOnline", status: "pass", connected: true, error: null },
        { service: "Purview", status: "pass", connected: true, error: null },
      ],
    };
    const h = createHarness(successResult);
    await h.tenants.upsertTenant(sampleTenant({ errorCount: 2, lastError: "prior failure" }));
    await h.credentials.upsertCredential(sampleCredential());

    const route = h.routes[0];
    await route.handler(makeContext({ id: TENANT_ID }));

    // Credential lastValidated is recorded
    const cred = await h.credentials.getCredential(TENANT_ID);
    expect(cred?.lastValidated).toBe(NOW);

    // Tenant error state is reset
    const tenant = await h.tenants.getTenant(TENANT_ID);
    expect(tenant?.errorCount).toBe(0);
    expect(tenant?.lastError).toBeNull();
    expect(tenant?.status).toBe("active");
  });

  it("increments errorCount and updates status to error when reaching threshold on failure", async () => {
    const failResult: TestConnectionResult = {
      tenantId: TENANT_ID,
      success: false,
      testedAt: NOW,
      services: [
        { service: "Graph", status: "pass", connected: true, error: null },
        { service: "ExchangeOnline", status: "fail", connected: false, error: "EXO timeout" },
        { service: "Purview", status: "pass", connected: true, error: null },
      ],
    };
    const h = createHarness(failResult);
    // Start with errorCount = 2, threshold = 3 -> next failure should flip to error
    await h.tenants.upsertTenant(sampleTenant({ errorCount: 2, status: "active" }));
    await h.credentials.upsertCredential(sampleCredential());

    const route = h.routes[0];
    const res = await route.handler(makeContext({ id: TENANT_ID }));

    expect(res.status).toBe(200);
    expect((res.body as TestConnectionResult).success).toBe(false);

    // Tenant error state incremented and status flipped to error
    const tenant = await h.tenants.getTenant(TENANT_ID);
    expect(tenant?.errorCount).toBe(3);
    expect(tenant?.lastError).toBe("EXO timeout");
    expect(tenant?.status).toBe("error");

    // Credential lastValidated was NOT updated
    const cred = await h.credentials.getCredential(TENANT_ID);
    expect(cred?.lastValidated).toBeNull();
  });

  it("rejects unauthenticated caller with 401", async () => {
    const h = createHarness(
      { tenantId: TENANT_ID, success: true, testedAt: NOW, services: [] },
      { resolveCaller: () => undefined },
    );

    const route = h.routes[0];
    await expect(route.handler(makeContext({ id: TENANT_ID }))).rejects.toMatchObject({
      code: TEST_CONNECTION_UNAUTHENTICATED,
      status: 401,
    });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const h = createHarness(
      { tenantId: TENANT_ID, success: true, testedAt: NOW, services: [] },
      { resolveCaller: () => ({ roles: ["admin"], tenantScope: tenantScope(["other-tenant"]) }) },
    );

    const route = h.routes[0];
    await expect(route.handler(makeContext({ id: TENANT_ID }))).rejects.toMatchObject({
      code: "auth.forbidden",
      status: 403,
    });
  });

  it("returns 404 when tenant is not found", async () => {
    const h = createHarness({ tenantId: TENANT_ID, success: true, testedAt: NOW, services: [] });

    const route = h.routes[0];
    await expect(route.handler(makeContext({ id: "non-existent" }))).rejects.toMatchObject({
      code: TENANT_NOT_FOUND,
      status: 404,
    });
  });

  it("returns 404 when credential is not configured", async () => {
    const h = createHarness({ tenantId: TENANT_ID, success: true, testedAt: NOW, services: [] });
    await h.tenants.upsertTenant(sampleTenant());

    const route = h.routes[0];
    await expect(route.handler(makeContext({ id: TENANT_ID }))).rejects.toMatchObject({
      code: CREDENTIAL_NOT_FOUND,
      status: 404,
    });
  });

  it("declares OpenAPI spec matching the route", () => {
    expect(TEST_CONNECTION_OPENAPI.paths["/v1/tenants/{id}/test-connection"]).toBeDefined();
    expect(TEST_CONNECTION_OPENAPI.paths["/v1/tenants/{id}/test-connection"].post.permission).toBe(
      TEST_CONNECTION_PERMISSION,
    );
    expect(TEST_CONNECTION_OPENAPI.schemas.TestConnectionResult).toBeDefined();
  });
});
