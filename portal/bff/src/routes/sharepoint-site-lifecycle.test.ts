import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import {
  REMEDIATION_APPLY_PERMISSION,
  SHAREPOINT_READ_PERMISSION,
  SHAREPOINT_RECYCLE_BIN_PATH,
  SHAREPOINT_SITE_CONFIRM_REQUIRED,
  SHAREPOINT_SITE_DELETE_PATH,
  SHAREPOINT_SITE_LIFECYCLE_OPENAPI,
  SHAREPOINT_SITE_NOT_SOFT_DELETED,
  SHAREPOINT_SITE_RESTORE_PATH,
  SHAREPOINT_WRITE_PERMISSION,
  createSharePointSiteLifecycleRoutes,
  parseRecycleBinFilter,
  type SharePointRecycleBinActionInput,
  type SharePointRecycleBinActionResult,
  type SharePointRecycleBinFilter,
  type SharePointRecycleBinPage,
  type SharePointSiteAuditEvent,
  type SharePointSiteLifecycleCaller,
  type SharePointSiteLifecycleInput,
  type SharePointSiteLifecyclePlan,
  type SharePointSiteLifecycleProvider,
  type SharePointSiteLifecycleRouteOptions,
  type SharePointSiteOperationResult,
  type SiteOperationRecord,
  type SiteOperationStore,
} from "./sharepoint-site-lifecycle.js";

const TENANT = "tenant-a";
const SITE = "site-1";

const DELETE_PLAN: SharePointSiteLifecyclePlan = {
  action: "delete",
  siteId: SITE,
  targetName: "Project Alpha",
  before: { id: SITE, displayName: "Project Alpha", state: "active" },
  after: { id: SITE, displayName: "Project Alpha", state: "softDeleted" },
  diff: ["Soft-delete site 'Project Alpha' (site-1)"],
  valid: true,
  dryRun: true,
  requiresConfirmation: true,
};

function deleteResult(audit = true): SharePointSiteOperationResult {
  return {
    success: true,
    state: "succeeded",
    operation: "delete",
    siteId: SITE,
    targetName: "Project Alpha",
    before: { id: SITE, state: "active" },
    after: { id: SITE, state: "softDeleted" },
    error: null,
    ...(audit
      ? {
          auditEvent: {
            id: "audit-delete-1",
            tenantId: TENANT,
            action: "sharepoint.site.delete",
            targetId: SITE,
            targetName: "Project Alpha",
            timestamp: "2026-09-28T00:00:00.000Z",
            result: "success" as const,
            before: { id: SITE, state: "active" },
            after: { id: SITE, state: "softDeleted" },
          },
        }
      : {}),
  };
}

const RESTORE_RESULT: SharePointSiteOperationResult = {
  success: true,
  state: "succeeded",
  operation: "restore",
  siteId: SITE,
  targetName: "Project Alpha",
  before: { id: SITE, state: "softDeleted" },
  after: { id: SITE, state: "active" },
  error: null,
  auditEvent: {
    id: "audit-restore-1",
    tenantId: TENANT,
    action: "sharepoint.site.restore",
    targetId: SITE,
    targetName: "Project Alpha",
    timestamp: "2026-09-28T00:01:00.000Z",
    result: "success",
    before: { id: SITE, state: "softDeleted" },
    after: { id: SITE, state: "active" },
  },
};

class FakeLifecycleProvider implements SharePointSiteLifecycleProvider {
  readonly deleteCalls: Array<{
    tenantId: string;
    siteId: string;
    input: SharePointSiteLifecycleInput;
    preview: boolean;
  }> = [];
  readonly restoreCalls: Array<{
    tenantId: string;
    siteId: string;
    input: SharePointSiteLifecycleInput;
    preview: boolean;
  }> = [];
  readonly listCalls: Array<{ tenantId: string; filter: SharePointRecycleBinFilter }> = [];
  readonly recycleCalls: Array<{
    tenantId: string;
    input: SharePointRecycleBinActionInput;
    preview: boolean;
  }> = [];
  deleteError: unknown = undefined;
  restoreError: unknown = undefined;

  async deleteSite(
    tenantId: string,
    siteId: string,
    input: SharePointSiteLifecycleInput,
    preview: boolean,
  ): Promise<SharePointSiteOperationResult | SharePointSiteLifecyclePlan> {
    this.deleteCalls.push({ tenantId, siteId, input, preview });
    if (this.deleteError !== undefined) {
      throw this.deleteError;
    }
    return preview ? DELETE_PLAN : deleteResult();
  }

  async restoreSite(
    tenantId: string,
    siteId: string,
    input: SharePointSiteLifecycleInput,
    preview: boolean,
  ): Promise<SharePointSiteOperationResult | SharePointSiteLifecyclePlan> {
    this.restoreCalls.push({ tenantId, siteId, input, preview });
    if (this.restoreError !== undefined) {
      throw this.restoreError;
    }
    return preview ? { ...DELETE_PLAN, action: "restore", dryRun: true } : RESTORE_RESULT;
  }

  async listRecycleBin(
    tenantId: string,
    filter: SharePointRecycleBinFilter,
  ): Promise<SharePointRecycleBinPage> {
    this.listCalls.push({ tenantId, filter });
    return {
      tenantId,
      totalCount: 1,
      items: [
        {
          id: "recycled-1",
          siteId: "recycled-1",
          displayName: "Retired Site",
          url: "https://retired.example.invalid",
          deletedAt: "2026-09-20T00:00:00.000Z",
          daysUntilPurge: 20,
        },
      ],
      nextCursor: null,
    };
  }

  async recycleBinAction(
    tenantId: string,
    input: SharePointRecycleBinActionInput,
    preview: boolean,
  ): Promise<SharePointRecycleBinActionResult> {
    this.recycleCalls.push({ tenantId, input, preview });
    if (preview) {
      return {
        action: input.action,
        mode: "plan",
        results: input.itemIds.map((id) => ({
          id,
          siteId: id,
          status: "planned" as const,
          before: { id, state: "deleted" },
          after: { id, state: input.action === "restore" ? "active" : "purged" },
          error: null,
        })),
        summary: { total: input.itemIds.length, succeeded: 0, failed: 0 },
      };
    }
    return {
      action: input.action,
      mode: "apply",
      results: input.itemIds.map((id) => ({
        id,
        siteId: id,
        status: input.action === "restore" ? ("restored" as const) : ("emptied" as const),
        before: { id, state: "deleted" },
        after: { id, state: input.action === "restore" ? "active" : "purged" },
        error: null,
      })),
      auditEvents: input.itemIds.map((id) => ({
        id: `audit-${id}`,
        tenantId,
        action: `sharepoint.recyclebin.${input.action}`,
        targetId: id,
        targetName: id,
        timestamp: "2026-09-28T00:02:00.000Z",
        result: "success" as const,
        before: { id, state: "deleted" },
        after: { id, state: input.action === "restore" ? "active" : "purged" },
      })),
      summary: { total: input.itemIds.length, succeeded: input.itemIds.length, failed: 0 },
    };
  }
}

class FakeSiteOperationStore implements SiteOperationStore {
  readonly created: Array<{ id: string; operation: string; state: string }> = [];
  readonly updates: Array<{ operationId: string; state?: string; result?: string | null }> = [];
  private counter = 0;

  async createSiteOperation(input: {
    id: string;
    tenantId: string;
    siteId: string;
    operation: string;
    state: string;
    by?: string | null;
    at?: string;
  }): Promise<SiteOperationRecord> {
    this.counter += 1;
    const id = `op-${this.counter}`;
    this.created.push({ id, operation: input.operation, state: input.state });
    return {
      id,
      tenantId: input.tenantId,
      siteId: input.siteId,
      operation: input.operation,
      state: input.state,
      by: input.by ?? null,
      at: input.at ?? "2026-09-28T00:00:00.000Z",
      result: null,
      createdAt: "2026-09-28T00:00:00.000Z",
      updatedAt: "2026-09-28T00:00:00.000Z",
    };
  }

  async updateSiteOperation(
    _tenantId: string,
    operationId: string,
    update: { state?: string; result?: string | null },
  ): Promise<SiteOperationRecord | undefined> {
    this.updates.push({ operationId, state: update.state, result: update.result });
    return undefined;
  }
}

function callerFor(
  tenantIds: readonly string[],
  permissions: readonly string[],
): SharePointSiteLifecycleCaller {
  return {
    userId: "operator-1",
    roles: [],
    tenantScope: tenantScope(tenantIds),
    permissions,
  };
}

function contextFor(
  method: string,
  path: string,
  body: unknown,
  params: Record<string, string> = { tenantId: TENANT },
  query = "",
): {
  correlationId: string;
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  params: Record<string, string>;
  body: unknown;
} {
  return {
    correlationId: "corr-1",
    method,
    path,
    query: new URLSearchParams(query),
    headers: {},
    params,
    body,
  };
}

interface Harness {
  readonly provider: FakeLifecycleProvider;
  readonly store: FakeSiteOperationStore;
  readonly audits: SharePointSiteAuditEvent[];
  readonly routes: ReturnType<typeof createSharePointSiteLifecycleRoutes>;
}

function harness(caller?: SharePointSiteLifecycleCaller): Harness {
  const provider = new FakeLifecycleProvider();
  const store = new FakeSiteOperationStore();
  const audits: SharePointSiteAuditEvent[] = [];
  const options: SharePointSiteLifecycleRouteOptions = {
    provider,
    siteOperations: store,
    resolveCaller: () => caller,
    recordAudit: (event) => {
      audits.push(event);
    },
  };
  return { provider, store, audits, routes: createSharePointSiteLifecycleRoutes(options) };
}

const WRITE_CALLER = callerFor([TENANT], [
  SHAREPOINT_READ_PERMISSION,
  SHAREPOINT_WRITE_PERMISSION,
  REMEDIATION_APPLY_PERMISSION,
]);

describe("SharePoint site lifecycle routes (T-0485)", () => {
  it("exposes delete, restore, and recycle-bin paths", () => {
    const { routes } = harness(WRITE_CALLER);
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `DELETE ${SHAREPOINT_SITE_DELETE_PATH}`,
      `POST ${SHAREPOINT_SITE_RESTORE_PATH}`,
      `GET ${SHAREPOINT_RECYCLE_BIN_PATH}`,
      `POST ${SHAREPOINT_RECYCLE_BIN_PATH}`,
    ]);
  });

  it("publishes the delete, restore, and recycle-bin OpenAPI path items", () => {
    const paths = Object.keys(SHAREPOINT_SITE_LIFECYCLE_OPENAPI.paths);
    expect(paths).toContain("/tenants/{tenantId}/sharepoint/sites/{siteId}");
    expect(paths).toContain("/tenants/{tenantId}/sharepoint/sites/{siteId}/restore");
    expect(paths).toContain("/tenants/{tenantId}/sharepoint/recyclebin");
  });

  it("rejects unauthenticated requests with 401", async () => {
    const { routes } = harness(undefined);
    const route = routes.find((r) => r.method === "DELETE")!;
    await expect(
      route.handler(contextFor("DELETE", SHAREPOINT_SITE_DELETE_PATH, { confirm: true }, { tenantId: TENANT, siteId: SITE })),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a caller missing sharepoint.write with 403", async () => {
    const { provider, routes } = harness(callerFor([TENANT], [REMEDIATION_APPLY_PERMISSION]));
    const route = routes.find((r) => r.method === "DELETE")!;
    await expect(
      route.handler(contextFor("DELETE", SHAREPOINT_SITE_DELETE_PATH, { confirm: true }, { tenantId: TENANT, siteId: SITE })),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider.deleteCalls).toHaveLength(0);
  });

  it("rejects an out-of-scope tenant with 403", async () => {
    const { provider, routes } = harness(callerFor(["other-tenant"], [SHAREPOINT_WRITE_PERMISSION, REMEDIATION_APPLY_PERMISSION]));
    const route = routes.find((r) => r.method === "DELETE")!;
    await expect(
      route.handler(contextFor("DELETE", SHAREPOINT_SITE_DELETE_PATH, { confirm: true }, { tenantId: TENANT, siteId: SITE })),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider.deleteCalls).toHaveLength(0);
  });

  it("returns a delete plan preview without writing when preview requested", async () => {
    const { provider, store, audits, routes } = harness(WRITE_CALLER);
    const route = routes.find((r) => r.method === "DELETE")!;
    const response = await route.handler(
      contextFor("DELETE", SHAREPOINT_SITE_DELETE_PATH, { preview: true }, { tenantId: TENANT, siteId: SITE }),
    );
    expect(response.status).toBe(200);
    expect((response.body as SharePointSiteLifecyclePlan).dryRun).toBe(true);
    expect(provider.deleteCalls[0]?.preview).toBe(true);
    expect(store.created).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it("refuses a delete apply without confirmation and writes nothing", async () => {
    const { provider, store, audits, routes } = harness(WRITE_CALLER);
    const route = routes.find((r) => r.method === "DELETE")!;
    await expect(
      route.handler(contextFor("DELETE", SHAREPOINT_SITE_DELETE_PATH, {}, { tenantId: TENANT, siteId: SITE })),
    ).rejects.toMatchObject({ status: 400, code: SHAREPOINT_SITE_CONFIRM_REQUIRED });
    expect(provider.deleteCalls).toHaveLength(0);
    expect(store.created).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it("applies a confirmed delete and records a SiteOperation plus an audit event", async () => {
    const { provider, store, audits, routes } = harness(WRITE_CALLER);
    const route = routes.find((r) => r.method === "DELETE")!;
    const response = await route.handler(
      contextFor("DELETE", SHAREPOINT_SITE_DELETE_PATH, { confirm: true }, { tenantId: TENANT, siteId: SITE }),
    );
    expect(response.status).toBe(200);
    const body = response.body as SharePointSiteOperationResult;
    expect(body.state).toBe("succeeded");
    expect(body.auditEvent?.action).toBe("sharepoint.site.delete");
    expect(provider.deleteCalls).toHaveLength(1);
    expect(store.created).toEqual([{ id: "op-1", operation: "delete", state: "running" }]);
    expect(store.updates[0]?.state).toBe("succeeded");
    expect(store.updates[0]?.result).toContain("softDeleted");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe("sharepoint.site.delete");
  });

  it("maps a provider not-found delete to a structured 404", async () => {
    const { provider, routes } = harness(WRITE_CALLER);
    provider.deleteError = new Error("NotFound: site 'site-1' was not found");
    const route = routes.find((r) => r.method === "DELETE")!;
    await expect(
      route.handler(contextFor("DELETE", SHAREPOINT_SITE_DELETE_PATH, { confirm: true }, { tenantId: TENANT, siteId: SITE })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("restores a soft-deleted site and records a SiteOperation plus an audit event", async () => {
    const { provider, store, audits, routes } = harness(WRITE_CALLER);
    const route = routes.find((r) => r.method === "POST" && r.path === SHAREPOINT_SITE_RESTORE_PATH)!;
    const response = await route.handler(
      contextFor("POST", SHAREPOINT_SITE_RESTORE_PATH, {}, { tenantId: TENANT, siteId: SITE }),
    );
    expect(response.status).toBe(200);
    const body = response.body as SharePointSiteOperationResult;
    expect(body.operation).toBe("restore");
    expect(body.after).toMatchObject({ state: "active" });
    expect(provider.restoreCalls[0]?.preview).toBe(false);
    expect(store.created).toEqual([{ id: "op-1", operation: "restore", state: "running" }]);
    expect(store.updates[0]?.state).toBe("succeeded");
    expect(audits[0]?.action).toBe("sharepoint.site.restore");
  });

  it("maps restoring a site that is not soft-deleted to a structured 404", async () => {
    const { provider, routes } = harness(WRITE_CALLER);
    provider.restoreError = new AppError(SHAREPOINT_SITE_NOT_SOFT_DELETED, "not soft-deleted", 404);
    const route = routes.find((r) => r.method === "POST" && r.path === SHAREPOINT_SITE_RESTORE_PATH)!;
    await expect(
      route.handler(contextFor("POST", SHAREPOINT_SITE_RESTORE_PATH, {}, { tenantId: TENANT, siteId: SITE })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("lists the recycle bin with the parsed filter", async () => {
    const { provider, routes } = harness(callerFor([TENANT], [SHAREPOINT_READ_PERMISSION]));
    const route = routes.find((r) => r.method === "GET")!;
    const response = await route.handler(
      contextFor("GET", SHAREPOINT_RECYCLE_BIN_PATH, undefined, { tenantId: TENANT }, "search=retired"),
    );
    expect(response.status).toBe(200);
    const body = response.body as SharePointRecycleBinPage;
    expect(body.totalCount).toBe(1);
    expect(body.items[0]?.displayName).toBe("Retired Site");
    expect(provider.listCalls[0]?.filter.search).toBe("retired");
  });

  it("parses the recycle-bin filter with pagination", () => {
    const filter = parseRecycleBinFilter(new URLSearchParams("search=old&limit=5&cursor=abc"));
    expect(filter.search).toBe("old");
    expect(filter.limit).toBe(5);
    expect(filter.cursor).toBe("abc");
  });

  it("refuses an empty apply without confirmation and writes nothing", async () => {
    const { provider, store, audits, routes } = harness(WRITE_CALLER);
    const route = routes.find((r) => r.method === "POST" && r.path === SHAREPOINT_RECYCLE_BIN_PATH)!;
    await expect(
      route.handler(
        contextFor("POST", SHAREPOINT_RECYCLE_BIN_PATH, { action: "empty", itemIds: ["recycled-1"] }, { tenantId: TENANT }),
      ),
    ).rejects.toMatchObject({ status: 400, code: SHAREPOINT_SITE_CONFIRM_REQUIRED });
    expect(provider.recycleCalls).toHaveLength(0);
    expect(store.created).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it("previews a recycle-bin restore without writing", async () => {
    const { provider, store, routes } = harness(WRITE_CALLER);
    const route = routes.find((r) => r.method === "POST" && r.path === SHAREPOINT_RECYCLE_BIN_PATH)!;
    const response = await route.handler(
      contextFor(
        "POST",
        SHAREPOINT_RECYCLE_BIN_PATH,
        { action: "restore", itemIds: ["recycled-1"], preview: true },
        { tenantId: TENANT },
      ),
    );
    expect(response.status).toBe(200);
    expect((response.body as SharePointRecycleBinActionResult).mode).toBe("plan");
    expect(provider.recycleCalls[0]?.preview).toBe(true);
    expect(store.created).toHaveLength(0);
  });

  it("restores recycle-bin entries, records per-entry SiteOperations, and audits each", async () => {
    const { store, audits, routes } = harness(WRITE_CALLER);
    const route = routes.find((r) => r.method === "POST" && r.path === SHAREPOINT_RECYCLE_BIN_PATH)!;
    const response = await route.handler(
      contextFor(
        "POST",
        SHAREPOINT_RECYCLE_BIN_PATH,
        { action: "restore", itemIds: ["recycled-1", "recycled-2"] },
        { tenantId: TENANT },
      ),
    );
    expect(response.status).toBe(200);
    const body = response.body as SharePointRecycleBinActionResult;
    expect(body.mode).toBe("apply");
    expect(body.summary.succeeded).toBe(2);
    expect(store.created.map((row) => row.operation)).toEqual([
      "recyclebin.restore",
      "recyclebin.restore",
    ]);
    expect(audits).toHaveLength(2);
  });

  it("empties recycle-bin entries with confirmation and audits each", async () => {
    const { store, audits, routes } = harness(WRITE_CALLER);
    const route = routes.find((r) => r.method === "POST" && r.path === SHAREPOINT_RECYCLE_BIN_PATH)!;
    const response = await route.handler(
      contextFor(
        "POST",
        SHAREPOINT_RECYCLE_BIN_PATH,
        { action: "empty", itemIds: ["recycled-1"], confirm: true },
        { tenantId: TENANT },
      ),
    );
    expect(response.status).toBe(200);
    const body = response.body as SharePointRecycleBinActionResult;
    expect(body.results[0]?.status).toBe("emptied");
    expect(store.created[0]?.operation).toBe("recyclebin.empty");
    expect(audits[0]?.action).toBe("sharepoint.recyclebin.empty");
  });

  it("rejects a recycle-bin action missing itemIds before dispatch", async () => {
    const { provider, routes } = harness(WRITE_CALLER);
    const route = routes.find((r) => r.method === "POST" && r.path === SHAREPOINT_RECYCLE_BIN_PATH)!;
    await expect(
      route.handler(
        contextFor("POST", SHAREPOINT_RECYCLE_BIN_PATH, { action: "restore", itemIds: [] }, { tenantId: TENANT }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(provider.recycleCalls).toHaveLength(0);
  });
});
