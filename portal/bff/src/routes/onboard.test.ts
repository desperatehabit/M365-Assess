import { describe, expect, it } from "vitest";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import type { RequestContext, Route } from "../server.js";
import type { CredentialRecord, CredentialStoreRow } from "./credentials.js";
import type { TenantAuditInput, TenantRecord, TenantStore } from "./tenants.js";
import {
  createOnboardRoutes,
  ONBOARD_CONFIRMATION_REQUIRED,
  ONBOARD_FAILED,
  ONBOARD_OPENAPI,
  ONBOARD_PARTIAL_FAILURE,
  ONBOARD_PERMISSION,
  ONBOARD_UNAUTHENTICATED,
  type OnboardCaller,
  type OnboardInput,
  type OnboardRouteOptions,
  type OnboardRunner,
  type OnboardWorkerResult,
} from "./onboard.js";

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

function adminCaller(): OnboardCaller {
  return { roles: ["admin"], tenantScope: ALL_TENANTS, userId: "admin-user-1" };
}

function operatorCaller(): OnboardCaller {
  return { roles: ["operator"], tenantScope: ALL_TENANTS, userId: "operator-user-1" };
}

interface Harness {
  routes: Route[];
  tenants: MemoryTenantStore;
  credentials: MemoryCredentialStore;
  runnerCalls: { tenantId: string; input: OnboardInput }[];
  seenPermissions: string[];
}

function createHarness(
  runnerResult: OnboardWorkerResult,
  overrides: Partial<OnboardRouteOptions> = {},
): Harness {
  const tenants = new MemoryTenantStore();
  const credentials = new MemoryCredentialStore();
  const runnerCalls: { tenantId: string; input: OnboardInput }[] = [];
  const seenPermissions: string[] = [];

  const runner: OnboardRunner = async (tenantId, input) => {
    runnerCalls.push({ tenantId, input });
    return runnerResult;
  };

  const routes = createOnboardRoutes({
    tenantStore: tenants,
    credentialStore: credentials,
    runner,
    resolveCaller: () => adminCaller(),
    authorize: (_caller, perm) => {
      seenPermissions.push(perm);
    },
    now: () => NOW,
    ...overrides,
  });

  return { routes, tenants, credentials, runnerCalls, seenPermissions };
}

function makeContext(params: Record<string, string>, body: Record<string, unknown>): RequestContext {
  return {
    method: "POST",
    path: `/v1/tenants/${params.id}/onboard`,
    params,
    query: new URLSearchParams(),
    headers: { "x-correlation-id": "test-onboard-corr" },
    body,
  };
}

describe("Tenant onboarding route (T-0025)", () => {
  it("refuses unconfirmed requests with 400 and never invokes runner", async () => {
    const h = createHarness({
      tenantId: TENANT_ID,
      status: "succeeded",
      clientId: "app-123",
      certificateThumbprint: "THUMB123",
    });

    const route = h.routes[0];
    await expect(
      route.handler(makeContext({ id: TENANT_ID }, { confirmed: false })),
    ).rejects.toMatchObject({
      code: ONBOARD_CONFIRMATION_REQUIRED,
      status: 400,
    });

    expect(h.runnerCalls.length).toBe(0);
  });

  it("requires tenants.onboard / admin permission and refuses lower privilege roles", async () => {
    const h = createHarness(
      {
        tenantId: TENANT_ID,
        status: "succeeded",
      },
      {
        resolveCaller: () => operatorCaller(),
        authorize: (caller) => {
          if (!caller.roles.includes("admin")) {
            throw { code: "rbac.forbidden", status: 403 };
          }
        },
      },
    );

    const route = h.routes[0];
    await expect(
      route.handler(makeContext({ id: TENANT_ID }, { confirmed: true })),
    ).rejects.toMatchObject({
      code: "rbac.forbidden",
      status: 403,
    });

    expect(h.runnerCalls.length).toBe(0);
  });

  it("rejects unauthenticated caller with 401", async () => {
    const h = createHarness(
      { tenantId: TENANT_ID, status: "succeeded" },
      { resolveCaller: () => undefined },
    );

    const route = h.routes[0];
    await expect(
      route.handler(makeContext({ id: TENANT_ID }, { confirmed: true })),
    ).rejects.toMatchObject({
      code: ONBOARD_UNAUTHENTICATED,
      status: 401,
    });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const h = createHarness(
      { tenantId: TENANT_ID, status: "succeeded" },
      { resolveCaller: () => ({ roles: ["admin"], tenantScope: tenantScope(["other-tenant"]) }) },
    );

    const route = h.routes[0];
    await expect(
      route.handler(makeContext({ id: TENANT_ID }, { confirmed: true })),
    ).rejects.toMatchObject({
      code: "auth.forbidden",
      status: 403,
    });
  });

  it("successfully onboards tenant, persists tenant row, stores credential ref, and writes audit", async () => {
    const successResult: OnboardWorkerResult = {
      tenantId: TENANT_ID,
      status: "succeeded",
      clientId: "00000000-0000-0000-0000-000000000009",
      certificateThumbprint: "AABBCCDDEEFF0011223344556677889900112233",
      appDisplayName: "M365-Assess-Reader",
      bootstrapCreated: true,
      totalFailed: 0,
      completedAt: NOW,
    };
    const h = createHarness(successResult);

    const route = h.routes[0];
    const res = await route.handler(
      makeContext(
        { id: TENANT_ID },
        {
          confirmed: true,
          adminUpn: "admin@contoso.onmicrosoft.com",
          displayName: "Contoso Production",
          defaultDomain: "contoso.com",
          createNew: true,
        },
      ),
    );

    expect(res.status).toBe(201);
    expect(h.runnerCalls.length).toBe(1);
    expect(h.runnerCalls[0].input.confirmed).toBe(true);
    expect(h.runnerCalls[0].input.adminUpn).toBe("admin@contoso.onmicrosoft.com");

    // Verify tenant was saved
    const savedTenant = await h.tenants.getTenant(TENANT_ID);
    expect(savedTenant).toBeDefined();
    expect(savedTenant?.displayName).toBe("Contoso Production");
    expect(savedTenant?.defaultDomain).toBe("contoso.com");
    expect(savedTenant?.source).toBe("direct");
    expect(savedTenant?.status).toBe("active");

    // Verify credential was saved by reference
    const savedCred = await h.credentials.getCredential(TENANT_ID);
    expect(savedCred).toBeDefined();
    expect(savedCred?.clientId).toBe("00000000-0000-0000-0000-000000000009");
    expect(savedCred?.thumbprint).toBe("AABBCCDDEEFF0011223344556677889900112233");
    expect(savedCred?.secretRef).toMatch(/^cert:\/\/thumbprint\//);
    expect(savedCred?.lastValidated).toBe(NOW);

    // Verify audit event
    expect(h.tenants.events.length).toBe(1);
    const event = h.tenants.events[0];
    expect(event.action).toBe("tenant.onboard");
    expect(event.result).toBe("success");
    expect(event.actorUserId).toBe("admin-user-1");
    expect(event.after?.clientId).toBe("00000000-0000-0000-0000-000000000009");
  });

  it("records audit event and returns 502 on half-provisioned partial failure", async () => {
    const partialResult: OnboardWorkerResult = {
      tenantId: TENANT_ID,
      status: "partial",
      clientId: "00000000-0000-0000-0000-000000000009",
      certificateThumbprint: "AABBCCDDEEFF0011223344556677889900112233",
      appDisplayName: "M365-Assess-Reader",
      totalFailed: 2,
      error: "Tenant onboarding completed with 2 failed permission assignments (code: onboard.partial_failure).",
    };
    const h = createHarness(partialResult);

    const route = h.routes[0];
    await expect(
      route.handler(makeContext({ id: TENANT_ID }, { confirmed: true })),
    ).rejects.toMatchObject({
      code: ONBOARD_PARTIAL_FAILURE,
      status: 502,
    });

    // An audit event MUST still be written for partial/half-provisioned failures
    expect(h.tenants.events.length).toBe(1);
    const event = h.tenants.events[0];
    expect(event.action).toBe("tenant.onboard");
    expect(event.result).toBe("failure");
    expect(event.error).toMatch(/onboard\.partial_failure/);
    expect(event.after?.totalFailed).toBe(2);
  });

  it("records audit event and returns 500 when onboarding worker fails completely", async () => {
    const failedResult: OnboardWorkerResult = {
      tenantId: TENANT_ID,
      status: "failed",
      totalFailed: 1,
      error: "Insufficient directory privileges.",
    };
    const h = createHarness(failedResult);

    const route = h.routes[0];
    await expect(
      route.handler(makeContext({ id: TENANT_ID }, { confirmed: true })),
    ).rejects.toMatchObject({
      code: ONBOARD_FAILED,
      status: 500,
    });

    expect(h.tenants.events.length).toBe(1);
    const event = h.tenants.events[0];
    expect(event.action).toBe("tenant.onboard");
    expect(event.result).toBe("failure");
    expect(event.error).toBe("Insufficient directory privileges.");
  });

  it("declares OpenAPI specification matching the route", () => {
    expect(ONBOARD_OPENAPI.paths["/v1/tenants/{id}/onboard"]).toBeDefined();
    expect(ONBOARD_OPENAPI.paths["/v1/tenants/{id}/onboard"].post.permission).toBe(ONBOARD_PERMISSION);
  });
});
