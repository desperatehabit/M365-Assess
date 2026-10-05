// T-0509 — LIS location route gating, civic-field validation, gated-executor
// enqueue, and TeamOperation audit.
// Route-level tests: the read route validates Teams.Team.Read + tenant scope; the
// write routes validate Teams.Voice.ReadWrite + Remediation.Apply + tenant scope, reject
// missing required civic fields before any write, enqueue the EPIC-006 gated
// job, and record a TeamOperation plus an audit event.

import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import type { JobEnvelope } from "@m365-assess/contracts";
import type { RequestContext } from "../server.js";
import {
  REMEDIATION_APPLY_PERMISSION,
  TEAMS_LIS_BASE_PATH,
  TEAMS_LIS_ITEM_PATH,
  TEAMS_READ_PERMISSION,
  TEAMS_VOICE_PERMISSION,
  createLisLocationsRoutes,
  validateCountryCode,
  type LisLocationItem,
  type LisLocationsListResponse,
  type LisLocationsProvider,
  type LisLocationsRoutesOptions,
  type TeamOperationsStore,
} from "./teams-lis.js";

const TENANT = "tenant-test";

const HQ_LOCATION: LisLocationItem = {
  id: "loc-1",
  displayName: "Corporate HQ",
  street: "1 Main St",
  city: "Seattle",
  state: "WA",
  country: "US",
  postalCode: "98101",
  companyName: "Contoso Ltd",
};

class FakeLisLocationsProvider implements LisLocationsProvider {
  readonly getLocationCalls: Array<{ tenantId: string; locationId: string }> = [];

  locations: LisLocationItem[] = [HQ_LOCATION];

  async listLocations(tenantId: string): Promise<LisLocationsListResponse> {
    return {
      tenantId,
      totalCount: this.locations.length,
      items: this.locations,
    };
  }

  async getLocation(tenantId: string, locationId: string): Promise<LisLocationItem | undefined> {
    this.getLocationCalls.push({ tenantId, locationId });
    return this.locations.find((l) => l.id === locationId);
  }
}

class FakeQueue {
  readonly enqueued: JobEnvelope[] = [];

  async enqueue(envelope: JobEnvelope): Promise<string> {
    this.enqueued.push(envelope);
    return envelope.jobId;
  }
}

class FakeTeamOperationsStore implements TeamOperationsStore {
  readonly created: Array<Record<string, unknown>> = [];
  readonly updated: Array<{ tenantId: string; operationId: string; update: Record<string, unknown> }> = [];

  async createTeamOperation(input: Record<string, unknown>): Promise<unknown> {
    this.created.push(input);
    return input;
  }

  async updateTeamOperation(
    tenantId: string,
    operationId: string,
    update: Record<string, unknown>,
  ): Promise<unknown> {
    this.updated.push({ tenantId, operationId, update });
    return null;
  }
}

const VALID_CIVIC = {
  displayName: "Branch Office",
  street: "22 2nd Ave",
  city: "Bellevue",
  state: "WA",
  country: "US",
  postalCode: "98004",
};

function voiceCaller() {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [TEAMS_VOICE_PERMISSION, REMEDIATION_APPLY_PERMISSION],
    userId: "user-1",
  };
}

function readerCaller() {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [TEAMS_READ_PERMISSION],
  };
}

let defaultCaller: any = voiceCaller();

beforeEach(() => {
  defaultCaller = voiceCaller();
});

function createHarness(overrides?: Partial<LisLocationsRoutesOptions>) {
  const provider = new FakeLisLocationsProvider();
  const queue = new FakeQueue();
  const teamOperations = new FakeTeamOperationsStore();
  const audited: Record<string, unknown>[] = [];

  const routes = createLisLocationsRoutes({
    provider,
    queue,
    teamOperations,
    recordAudit: async (event) => {
      audited.push(event);
    },
    resolveCaller: () => defaultCaller,
    ...overrides,
  });

  const getRoute = (method: string, path: string) => {
    const route = routes.find((r) => r.method === method && r.path === path);
    if (!route) throw new Error(`route not found: ${method} ${path}`);
    return route;
  };

  return {
    provider,
    queue,
    teamOperations,
    audited,
    routes,
    getRoute,
    setCaller: (c: any) => {
      defaultCaller = c;
    },
  };
}

function ctx(
  path: string,
  options: { params?: Record<string, string>; body?: Record<string, unknown>; query?: Record<string, string> } = {},
): RequestContext & { body?: unknown } {
  const query = new URLSearchParams(options.query ?? {});
  return {
    correlationId: "corr-lis-1",
    method: "GET",
    path,
    query,
    headers: {},
    params: options.params ?? {},
    ...(options.body !== undefined ? { body: options.body } : {}),
  };
}

describe("Country code validation helper", () => {
  it("validates ISO 3166-1 alpha-2 codes", () => {
    expect(validateCountryCode("US")).toBe(true);
    expect(validateCountryCode("gb")).toBe(true);
    expect(validateCountryCode("USA")).toBe(false);
    expect(validateCountryCode("12")).toBe(false);
    expect(validateCountryCode("")).toBe(false);
  });
});

describe("GET /v1/tenants/:tenantId/teams/lis (T-0509)", () => {
  it("rejects unauthenticated caller", async () => {
    const harness = createHarness({ resolveCaller: () => undefined });
    const route = harness.getRoute("GET", TEAMS_LIS_BASE_PATH);
    await expect(
      route.handler(ctx(`/v1/tenants/${TENANT}/teams/lis`, { params: { tenantId: TENANT } })),
    ).rejects.toThrow(AppError);
  });

  it("rejects a caller without Teams.Team.Read", async () => {
    const harness = createHarness();
    harness.setCaller({ tenantScope: tenantScope([TENANT]), permissions: [] });
    const route = harness.getRoute("GET", TEAMS_LIS_BASE_PATH);
    await expect(
      route.handler(ctx(`/v1/tenants/${TENANT}/teams/lis`, { params: { tenantId: TENANT } })),
    ).rejects.toThrow(/forbidden/);
  });

  it("rejects a tenant outside the caller scope", async () => {
    const harness = createHarness();
    const route = harness.getRoute("GET", TEAMS_LIS_BASE_PATH);
    await expect(
      route.handler(ctx(`/v1/tenants/other-tenant/teams/lis`, { params: { tenantId: "other-tenant" } })),
    ).rejects.toThrow(AppError);
  });

  it("returns the LIS locations for the tenant", async () => {
    const harness = createHarness();
    harness.setCaller(readerCaller());
    const route = harness.getRoute("GET", TEAMS_LIS_BASE_PATH);
    const res = await route.handler(ctx(`/v1/tenants/${TENANT}/teams/lis`, { params: { tenantId: TENANT } }));
    expect(res.status).toBe(200);
    const body = res.body as LisLocationsListResponse;
    expect(body.totalCount).toBe(1);
    expect(body.items[0].displayName).toBe("Corporate HQ");
    expect(body.items[0].city).toBe("Seattle");
  });
});

describe("POST /v1/tenants/:tenantId/teams/lis (T-0509)", () => {
  it("rejects a caller without Teams.Voice.ReadWrite", async () => {
    const harness = createHarness();
    harness.setCaller(readerCaller());
    const route = harness.getRoute("POST", TEAMS_LIS_BASE_PATH);
    await expect(
      route.handler(
        ctx(`/v1/tenants/${TENANT}/teams/lis`, { params: { tenantId: TENANT }, body: VALID_CIVIC }),
      ),
    ).rejects.toThrow(/forbidden/);
  });

  it("rejects a caller without Remediation.Apply", async () => {
    const harness = createHarness();
    harness.setCaller({
      tenantScope: tenantScope([TENANT]),
      permissions: [TEAMS_VOICE_PERMISSION],
    });
    const route = harness.getRoute("POST", TEAMS_LIS_BASE_PATH);
    await expect(
      route.handler(
        ctx(`/v1/tenants/${TENANT}/teams/lis`, { params: { tenantId: TENANT }, body: VALID_CIVIC }),
      ),
    ).rejects.toThrow(/forbidden/);
  });

  it("rejects missing required civic fields before any write", async () => {
    const harness = createHarness();
    const route = harness.getRoute("POST", TEAMS_LIS_BASE_PATH);
    const body = { ...VALID_CIVIC, street: "", city: undefined };
    await expect(
      route.handler(ctx(`/v1/tenants/${TENANT}/teams/lis`, { params: { tenantId: TENANT }, body })),
    ).rejects.toThrow(/Missing required civic fields/);
    expect(harness.queue.enqueued).toHaveLength(0);
    expect(harness.teamOperations.created).toHaveLength(0);
  });

  it("rejects an invalid country code before any write", async () => {
    const harness = createHarness();
    const route = harness.getRoute("POST", TEAMS_LIS_BASE_PATH);
    await expect(
      route.handler(
        ctx(`/v1/tenants/${TENANT}/teams/lis`, {
          params: { tenantId: TENANT },
          body: { ...VALID_CIVIC, country: "USA" },
        }),
      ),
    ).rejects.toThrow(/Invalid country code/);
    expect(harness.queue.enqueued).toHaveLength(0);
  });

  it("supports preview mode without enqueueing", async () => {
    const harness = createHarness();
    const route = harness.getRoute("POST", TEAMS_LIS_BASE_PATH);
    const res = await route.handler(
      ctx(`/v1/tenants/${TENANT}/teams/lis`, {
        params: { tenantId: TENANT },
        body: { ...VALID_CIVIC, preview: true },
      }),
    );
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.action).toBe("create");
    expect(body.dryRun).toBe(true);
    expect(harness.queue.enqueued).toHaveLength(0);
  });

  it("enqueues the gated job and records a TeamOperation and audit event", async () => {
    const harness = createHarness();
    const route = harness.getRoute("POST", TEAMS_LIS_BASE_PATH);
    const res = await route.handler(
      ctx(`/v1/tenants/${TENANT}/teams/lis`, { params: { tenantId: TENANT }, body: VALID_CIVIC }),
    );
    expect(res.status).toBe(202);
    const body = res.body as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.jobId).toBeTruthy();

    expect(harness.queue.enqueued).toHaveLength(1);
    const envelope = harness.queue.enqueued[0]!;
    expect(envelope.jobType).toBe("remediation");
    expect(envelope.tenantId).toBe(TENANT);
    expect(envelope.payload).toMatchObject({
      area: "teams.lis",
      action: "create",
      displayName: "Branch Office",
      country: "US",
    });

    expect(harness.teamOperations.created).toHaveLength(1);
    expect(harness.teamOperations.created[0]).toMatchObject({
      tenantId: TENANT,
      teamId: "",
      operation: "lis.create",
      state: "queued",
      by: "user-1",
    });

    expect(harness.audited).toHaveLength(1);
    expect(harness.audited[0]).toMatchObject({
      action: "teams.lis.create",
      tenantId: TENANT,
      targetId: "",
    });
  });
});

describe("PATCH /v1/tenants/:tenantId/teams/lis/:locationId (T-0509)", () => {
  it("rejects missing required civic fields before any write", async () => {
    const harness = createHarness();
    harness.provider.locations = [
      { ...HQ_LOCATION, id: "loc-blank", displayName: "Blank Street Office", street: "" },
    ];
    const route = harness.getRoute("PATCH", TEAMS_LIS_ITEM_PATH);
    await expect(
      route.handler(
        ctx(`/v1/tenants/${TENANT}/teams/lis/loc-blank`, {
          params: { tenantId: TENANT, locationId: "loc-blank" },
          body: { city: "Bellevue" },
        }),
      ),
    ).rejects.toThrow(/Missing required civic fields/);
    expect(harness.queue.enqueued).toHaveLength(0);
  });

  it("returns 404 for an unknown location", async () => {
    const harness = createHarness();
    const route = harness.getRoute("PATCH", TEAMS_LIS_ITEM_PATH);
    await expect(
      route.handler(
        ctx(`/v1/tenants/${TENANT}/teams/lis/missing`, {
          params: { tenantId: TENANT, locationId: "missing" },
          body: { city: "Portland" },
        }),
      ),
    ).rejects.toThrow(/not found/);
  });

  it("enqueues the edit through the gated path and records a TeamOperation", async () => {
    const harness = createHarness();
    const route = harness.getRoute("PATCH", TEAMS_LIS_ITEM_PATH);
    const res = await route.handler(
      ctx(`/v1/tenants/${TENANT}/teams/lis/loc-1`, {
        params: { tenantId: TENANT, locationId: "loc-1" },
        body: { city: "Bellevue" },
      }),
    );
    expect(res.status).toBe(202);
    const body = res.body as Record<string, unknown>;
    expect(body.success).toBe(true);

    expect(harness.queue.enqueued).toHaveLength(1);
    expect(harness.queue.enqueued[0]!.payload).toMatchObject({
      area: "teams.lis",
      action: "edit",
      locationId: "loc-1",
      city: "Bellevue",
    });

    expect(harness.teamOperations.created).toHaveLength(1);
    expect(harness.teamOperations.created[0]).toMatchObject({
      tenantId: TENANT,
      teamId: "loc-1",
      operation: "lis.edit",
      state: "queued",
    });

    expect(harness.audited).toHaveLength(1);
    expect(harness.audited[0]).toMatchObject({
      action: "teams.lis.edit",
      targetId: "loc-1",
    });
  });
});

describe("DELETE /v1/tenants/:tenantId/teams/lis/:locationId (T-0509)", () => {
  it("requires confirmName matching the display name", async () => {
    const harness = createHarness();
    const route = harness.getRoute("DELETE", TEAMS_LIS_ITEM_PATH);
    await expect(
      route.handler(
        ctx(`/v1/tenants/${TENANT}/teams/lis/loc-1`, {
          params: { tenantId: TENANT, locationId: "loc-1" },
          body: {},
        }),
      ),
    ).rejects.toThrow(/confirmName/);
    expect(harness.queue.enqueued).toHaveLength(0);
  });

  it("enqueues the delete through the gated path and records a TeamOperation", async () => {
    const harness = createHarness();
    const route = harness.getRoute("DELETE", TEAMS_LIS_ITEM_PATH);
    const res = await route.handler(
      ctx(`/v1/tenants/${TENANT}/teams/lis/loc-1`, {
        params: { tenantId: TENANT, locationId: "loc-1" },
        body: { confirmName: "Corporate HQ" },
      }),
    );
    expect(res.status).toBe(202);
    const body = res.body as Record<string, unknown>;
    expect(body.success).toBe(true);

    expect(harness.queue.enqueued).toHaveLength(1);
    expect(harness.queue.enqueued[0]!.payload).toMatchObject({
      area: "teams.lis",
      action: "delete",
      locationId: "loc-1",
    });

    expect(harness.teamOperations.created).toHaveLength(1);
    expect(harness.teamOperations.created[0]).toMatchObject({
      tenantId: TENANT,
      teamId: "loc-1",
      operation: "lis.delete",
      state: "queued",
    });

    expect(harness.audited).toHaveLength(1);
    expect(harness.audited[0]).toMatchObject({
      action: "teams.lis.delete",
      targetId: "loc-1",
    });
  });
});
