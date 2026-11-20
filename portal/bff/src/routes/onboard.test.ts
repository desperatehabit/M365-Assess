import { describe, expect, it } from "vitest";
import { createInMemoryCredentialStore } from "../credentials/store.js";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import type { RequestContext, Route } from "../server.js";
import type { CredentialRecord, CredentialStoreRow } from "./credentials.js";
import type { TenantAuditInput, TenantRecord, TenantStore } from "./tenants.js";
import {
  createOnboardRoutes,
  parseOnboardProgressLine,
  ONBOARD_CONFIRMATION_REQUIRED,
  ONBOARD_FAILED,
  ONBOARD_OPENAPI,
  ONBOARD_PARTIAL_FAILURE,
  ONBOARD_PERMISSION,
  ONBOARD_PROGRESS_PATH,
  ONBOARD_TIMEOUT,
  ONBOARD_UNAUTHENTICATED,
  type OnboardCaller,
  type OnboardDeviceCodeProgress,
  type OnboardInput,
  type OnboardProgressSnapshot,
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

  private key(tenantId: string, purpose: "reader" | "operator" = "reader"): string {
    return `${tenantId}:${purpose}`;
  }

  async getCredential(
    tenantId: string,
    purpose: "reader" | "operator" = "reader",
  ): Promise<CredentialRecord | undefined> {
    const found = this.records.get(this.key(tenantId, purpose));
    return found ? { ...found } : undefined;
  }

  async upsertCredential(input: CredentialRecord): Promise<CredentialRecord> {
    const stored = { ...input };
    this.records.set(this.key(stored.tenantId, stored.purpose ?? "reader"), stored);
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

  it("stores a PFX-backed onboarding as a certificate-pfx credential holding only the file path", async () => {
    const pfxResult: OnboardWorkerResult = {
      tenantId: TENANT_ID,
      status: "succeeded",
      clientId: "00000000-0000-0000-0000-000000000009",
      certificateThumbprint: "AABBCCDDEEFF0011223344556677889900112233",
      certificatePath: "/home/op/.m365-assess/certs/M365-Assess-t.pfx",
      appDisplayName: "M365-Assess-Reader",
      bootstrapCreated: true,
      totalFailed: 0,
      completedAt: NOW,
    };
    const secrets = createInMemoryCredentialStore();
    const h = createHarness(pfxResult, { secrets });

    const res = await h.routes[0].handler(
      makeContext({ id: TENANT_ID }, { confirmed: true, adminUpn: "admin@contoso.onmicrosoft.com", createNew: true }),
    );

    expect(res.status).toBe(201);
    const savedCred = await h.credentials.getCredential(TENANT_ID);
    expect(savedCred?.authMethod).toBe("certificate-pfx");
    expect(savedCred?.thumbprint).toBe("AABBCCDDEEFF0011223344556677889900112233");
    expect(savedCred?.secretRef).toMatch(/^ref:\/\/tenants\//);
    expect(JSON.stringify(savedCred)).not.toContain(".pfx");
    const material = await secrets.readSecret(savedCred!.secretRef);
    expect(JSON.parse(material!)).toEqual({ certificatePath: "/home/op/.m365-assess/certs/M365-Assess-t.pfx" });
  });

  it("forwards the opt-in write selection and stores the operator credential beside the reader row", async () => {
    const result: OnboardWorkerResult = {
      tenantId: TENANT_ID,
      status: "succeeded",
      clientId: "reader-app-id",
      certificateThumbprint: "AABBCCDDEEFF0011223344556677889900112233",
      appDisplayName: "M365-Assess-Reader",
      operatorClientId: "operator-app-id",
      operatorCertificateThumbprint: "AABBCCDDEEFF0011223344556677889900112233",
      operatorAppDisplayName: "M365-Assess-Operator",
      operatorCreated: true,
      writePermissionGroups: ["identity", "intune"],
      bootstrapCreated: true,
      totalFailed: 0,
      completedAt: NOW,
    };
    const h = createHarness(result);

    const res = await h.routes[0].handler(
      makeContext(
        { id: TENANT_ID },
        {
          confirmed: true,
          adminUpn: "admin@contoso.onmicrosoft.com",
          createNew: true,
          includeWritePermissions: true,
          writePermissionGroups: ["identity", "intune"],
          confirmDangerous: true,
        },
      ),
    );

    expect(res.status).toBe(201);
    expect(h.runnerCalls[0].input.includeWritePermissions).toBe(true);
    expect(h.runnerCalls[0].input.writePermissionGroups).toEqual(["identity", "intune"]);
    expect(h.runnerCalls[0].input.confirmDangerous).toBe(true);

    const reader = await h.credentials.getCredential(TENANT_ID, "reader");
    expect(reader?.clientId).toBe("reader-app-id");
    expect(reader?.purpose).toBe("reader");
    const operator = await h.credentials.getCredential(TENANT_ID, "operator");
    expect(operator?.clientId).toBe("operator-app-id");
    expect(operator?.purpose).toBe("operator");
    expect(operator?.thumbprint).toBe("AABBCCDDEEFF0011223344556677889900112233");
  });

  it("keeps the reader-only path when write access is declined", async () => {
    const h = createHarness({
      tenantId: TENANT_ID,
      status: "succeeded",
      clientId: "reader-app-id",
      certificateThumbprint: "AABBCCDDEEFF0011223344556677889900112233",
      appDisplayName: "M365-Assess-Reader",
      totalFailed: 0,
      completedAt: NOW,
    });

    await h.routes[0].handler(
      makeContext({ id: TENANT_ID }, { confirmed: true, createNew: true }),
    );

    expect(h.runnerCalls[0].input.includeWritePermissions).toBe(false);
    expect(await h.credentials.getCredential(TENANT_ID, "reader")).toBeDefined();
    expect(await h.credentials.getCredential(TENANT_ID, "operator")).toBeUndefined();
  });

  it("fails before writing a tenant row when a PFX result has no credential backend", async () => {
    const pfxResult: OnboardWorkerResult = {
      tenantId: TENANT_ID,
      status: "succeeded",
      clientId: "00000000-0000-0000-0000-000000000009",
      certificateThumbprint: "AABB",
      certificatePath: "/home/op/.m365-assess/certs/M365-Assess-t.pfx",
      totalFailed: 0,
    };
    const h = createHarness(pfxResult);

    await expect(
      h.routes[0].handler(makeContext({ id: TENANT_ID }, { confirmed: true, createNew: true })),
    ).rejects.toThrow(/\.pfx.*no credential backend/);
    expect(await h.tenants.getTenant(TENANT_ID)).toBeUndefined();
    expect(await h.credentials.getCredential(TENANT_ID)).toBeUndefined();
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
    expect(ONBOARD_OPENAPI.paths["/v1/tenants/{id}/onboard/progress/{progressId}"]).toBeDefined();
    expect(
      ONBOARD_OPENAPI.paths["/v1/tenants/{id}/onboard/progress/{progressId}"].get.permission,
    ).toBe(ONBOARD_PERMISSION);
  });
});

function progressContext(
  progressId: string,
  since = 0,
  tenantId: string = TENANT_ID,
): RequestContext {
  return {
    method: "GET",
    path: `/v1/tenants/${tenantId}/onboard/progress/${progressId}`,
    params: { id: tenantId, progressId },
    query: new URLSearchParams(since > 0 ? { since: String(since) } : {}),
    headers: {},
  };
}

async function waitForState(check: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for the onboarding progress channel");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deviceCodeEvent(overrides: Partial<OnboardDeviceCodeProgress> = {}): OnboardDeviceCodeProgress {
  return {
    sequence: 1,
    kind: "device-code",
    signIn: "graph-permissions",
    provider: "Microsoft Graph",
    code: "ABCD-EFGH",
    verificationUrl: "https://microsoft.com/devicelogin",
    expiresAt: "2026-06-01T12:15:00.000Z",
    at: NOW,
    ...overrides,
  };
}

describe("Onboarding device-code relay (T-0916)", () => {
  it("parses worker progress lines and ignores diagnostics and the result line", () => {
    const event = parseOnboardProgressLine(JSON.stringify(deviceCodeEvent()));
    expect(event).toMatchObject({
      kind: "device-code",
      signIn: "graph-permissions",
      code: "ABCD-EFGH",
      verificationUrl: "https://microsoft.com/devicelogin",
    });
    expect(parseOnboardProgressLine("Creating the app registration...")).toBeNull();
    expect(parseOnboardProgressLine('{"tenantId":"t","status":"succeeded"}')).toBeNull();
    expect(parseOnboardProgressLine('{"kind":"sign-in-complete"}')).toBeNull();
  });

  it("publishes each device code and clears it when the sign-in completes", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: OnboardRunner = async (_tenantId, _input, progress) => {
      progress?.(deviceCodeEvent());
      progress?.(
        deviceCodeEvent({
          sequence: 2,
          kind: "sign-in-complete",
          code: null,
          verificationUrl: null,
          expiresAt: null,
          account: "admin@contoso.example",
        }),
      );
      await gate;
      return {
        tenantId: TENANT_ID,
        status: "succeeded",
        clientId: "app-123",
        certificateThumbprint: "THUMB123",
      };
    };
    const h = createHarness({ tenantId: TENANT_ID, status: "succeeded" }, { runner });

    const submit = h.routes[0].handler(
      makeContext({ id: TENANT_ID }, { confirmed: true, progressId: "progress-1" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const pending = (await h.routes[1].handler(progressContext("progress-1"))) as {
      status: number;
      body: OnboardProgressSnapshot;
    };
    expect(pending.status).toBe(200);
    expect(pending.body.state).toBe("pending");
    expect(pending.body.events).toHaveLength(2);
    expect(pending.body.events[0]).toMatchObject({
      sequence: 1,
      kind: "device-code",
      code: "ABCD-EFGH",
      verificationUrl: "https://microsoft.com/devicelogin",
    });
    expect(pending.body.events[1]).toMatchObject({ sequence: 2, kind: "sign-in-complete" });

    const incremental = (await h.routes[1].handler(progressContext("progress-1", 1))) as {
      body: OnboardProgressSnapshot;
    };
    expect(incremental.body.events.map((event) => event.sequence)).toEqual([2]);

    release();
    expect((await submit).status).toBe(201);

    const finished = (await h.routes[1].handler(progressContext("progress-1"))) as {
      body: OnboardProgressSnapshot;
    };
    expect(finished.body.state).toBe("done");
  });

  it("supersedes an earlier channel when onboarding for the tenant starts again", async () => {
    const gated = (): OnboardRunner => async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { tenantId: TENANT_ID, status: "succeeded" };
    };
    const h = createHarness({ tenantId: TENANT_ID, status: "succeeded" }, { runner: gated() });

    const first = h.routes[0].handler(
      makeContext({ id: TENANT_ID }, { confirmed: true, progressId: "old-channel" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = h.routes[0].handler(
      makeContext({ id: TENANT_ID }, { confirmed: true, progressId: "new-channel" }),
    );

    await waitForState(async () => {
      const created = (await h.routes[1].handler(progressContext("new-channel"))) as {
        body: OnboardProgressSnapshot;
      };
      return created.body.state === "pending";
    });

    const oldChannel = (await h.routes[1].handler(progressContext("old-channel"))) as {
      body: OnboardProgressSnapshot;
    };
    expect(oldChannel.body.state).toBe("done");

    await Promise.all([first, second]);
  });

  it("answers unknown for a channel that has not been created yet", async () => {
    const h = createHarness({ tenantId: TENANT_ID, status: "succeeded" });
    const response = (await h.routes[1].handler(progressContext("never-created"))) as {
      status: number;
      body: OnboardProgressSnapshot;
    };
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ state: "unknown", events: [] });
  });

  it("requires admin permission and tenant scope on the progress route", async () => {
    const h = createHarness(
      { tenantId: TENANT_ID, status: "succeeded" },
      {
        resolveCaller: () => ({ roles: ["admin"], tenantScope: tenantScope(["other-tenant"]) }),
      },
    );
    await expect(h.routes[1].handler(progressContext("progress-1"))).rejects.toMatchObject({
      code: "auth.forbidden",
      status: 403,
    });
  });

  it("reports a clear timeout when the job exceeds 30 minutes waiting for sign-in", async () => {
    const runner: OnboardRunner = async () => {
      throw { code: "worker.timeout", message: "worker for job x exceeded its timeout" };
    };
    const h = createHarness({ tenantId: TENANT_ID, status: "succeeded" }, { runner });

    await expect(
      h.routes[0].handler(makeContext({ id: TENANT_ID }, { confirmed: true })),
    ).rejects.toMatchObject({
      code: ONBOARD_TIMEOUT,
      status: 504,
    });
    const event = h.tenants.events[0];
    expect(event.result).toBe("failure");
    expect(JSON.stringify(event)).not.toMatch(/worker for job/);
  });
});
