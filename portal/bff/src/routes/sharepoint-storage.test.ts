import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import {
  SHAREPOINT_CLEANUP_PERMISSION,
  SHAREPOINT_READ_PERMISSION,
  SHAREPOINT_STORAGE_PATH,
  SHAREPOINT_VERSION_CLEANUP_PATH,
  createSharePointStorageRoutes,
  parseVersionCleanupInput,
  type SharePointStorageCaller,
  type SharePointStorageProvider,
  type SiteStorageComposition,
  type VersionCleanupApply,
  type VersionCleanupPlan,
} from "./sharepoint-storage.js";

const TENANT = "tenant-test";
const SITE = "site-1";

const STORAGE: SiteStorageComposition = {
  tenantId: TENANT,
  siteId: SITE,
  documentsBytes: 1073741824,
  versionsBytes: 536870912,
  recycleBinBytes: 104857600,
  reclaimableBytes: 641728512,
  totalBytes: 1715470336,
  generatedAt: "2026-09-30T00:00:00.000Z",
};

const PLAN: VersionCleanupPlan = {
  jobId: "job-1",
  tenantId: TENANT,
  siteId: SITE,
  mode: "plan",
  state: "planned",
  ageThresholdDays: 90,
  cutoffDate: "2026-07-02T00:00:00.000Z",
  versions: [
    { versionId: "v1", itemId: "item-1", size: 1024, lastModified: "2026-01-01T00:00:00Z", isCurrent: false, selected: true, reason: null },
    { versionId: "v2", itemId: "item-1", size: 2048, lastModified: "2026-09-01T00:00:00Z", isCurrent: true, selected: false, reason: "current-version-protected" },
  ],
  selectedCount: 1,
  reclaimableBytes: 1024,
  writes: false,
};

class FakeSharePointStorageProvider implements SharePointStorageProvider {
  readonly calls: Array<{ tenantId: string; siteId: string; input?: unknown }> = [];

  async getSiteStorage(tenantId: string, siteId: string): Promise<SiteStorageComposition> {
    this.calls.push({ tenantId, siteId });
    return { ...STORAGE, tenantId, siteId };
  }

  async cleanupVersions(
    tenantId: string,
    siteId: string,
    input: Record<string, unknown>,
  ): Promise<VersionCleanupPlan | VersionCleanupApply> {
    this.calls.push({ tenantId, siteId, input });
    if (input["preview"] === true) {
      return { ...PLAN, tenantId, siteId };
    }
    return {
      jobId: "job-1",
      tenantId,
      siteId,
      mode: "apply",
      state: "completed",
      ageThresholdDays: 90,
      cutoffDate: "2026-07-02T00:00:00.000Z",
      results: [{ versionId: "v1", state: "applied", before: null, after: null, appliedAt: "2026-09-30T00:00:00Z", actor: "user-1", error: null }],
      auditEvents: [],
      summary: { total: 1, removed: 1, failed: 0, skipped: 0 },
    };
  }
}

function makeCaller(permissions: string[]): SharePointStorageCaller {
  return { tenantScope: tenantScope([TENANT]), permissions };
}

function ctxFor(path: string, body?: Record<string, unknown>) {
  return {
    method: "GET",
    path,
    params: { tenantId: TENANT, siteId: SITE },
    query: new URLSearchParams(),
    headers: {},
    ...(body !== undefined ? { body } : {}),
  };
}

describe("SharePoint storage route (T-0487)", () => {
  it("exposes GET .../storage and POST .../versions/cleanup", () => {
    const provider = new FakeSharePointStorageProvider();
    const routes = createSharePointStorageRoutes({
      provider,
      resolveCaller: () => makeCaller([SHAREPOINT_READ_PERMISSION, SHAREPOINT_CLEANUP_PERMISSION]),
    });
    expect(routes).toHaveLength(2);
    expect(routes[0]?.method).toBe("GET");
    expect(routes[0]?.path).toBe(SHAREPOINT_STORAGE_PATH);
    expect(routes[1]?.method).toBe("POST");
    expect(routes[1]?.path).toBe(SHAREPOINT_VERSION_CLEANUP_PATH);
  });

  it("rejects unauthenticated GET with 401", async () => {
    const provider = new FakeSharePointStorageProvider();
    const routes = createSharePointStorageRoutes({ provider, resolveCaller: () => undefined });
    await expect(routes[0]?.handler(ctxFor(`/v1/tenants/${TENANT}/sharepoint/sites/${SITE}/storage`))).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const provider = new FakeSharePointStorageProvider();
    const routes = createSharePointStorageRoutes({
      provider,
      resolveCaller: () => ({ tenantScope: tenantScope(["other"]), permissions: [SHAREPOINT_READ_PERMISSION] }),
    });
    await expect(routes[0]?.handler(ctxFor(`/v1/tenants/${TENANT}/sharepoint/sites/${SITE}/storage`))).rejects.toMatchObject({ status: 403 });
  });

  it("rejects GET without sharepoint.read with 403", async () => {
    const provider = new FakeSharePointStorageProvider();
    const routes = createSharePointStorageRoutes({
      provider,
      resolveCaller: () => makeCaller(["Identity.Group.Read"]),
    });
    await expect(routes[0]?.handler(ctxFor(`/v1/tenants/${TENANT}/sharepoint/sites/${SITE}/storage`))).rejects.toMatchObject({ status: 403 });
  });

  it("returns the storage composition from the provider", async () => {
    const provider = new FakeSharePointStorageProvider();
    const routes = createSharePointStorageRoutes({
      provider,
      resolveCaller: () => makeCaller([SHAREPOINT_READ_PERMISSION]),
    });
    const response = await routes[0]?.handler(ctxFor(`/v1/tenants/${TENANT}/sharepoint/sites/${SITE}/storage`));
    expect(response?.status).toBe(200);
    const body = response?.body as SiteStorageComposition;
    expect(body.documentsBytes).toBe(1073741824);
    expect(body.versionsBytes).toBe(536870912);
    expect(body.recycleBinBytes).toBe(104857600);
    expect(body.reclaimableBytes).toBe(641728512);
    expect(body.totalBytes).toBe(1715470336);
  });

  it("rejects POST without sharepoint.cleanup with 403", async () => {
    const provider = new FakeSharePointStorageProvider();
    const routes = createSharePointStorageRoutes({
      provider,
      resolveCaller: () => makeCaller([SHAREPOINT_READ_PERMISSION]),
    });
    await expect(
      routes[1]?.handler(ctxFor(`/v1/tenants/${TENANT}/sharepoint/sites/${SITE}/versions/cleanup`, { preview: true })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects apply without Remediation.Apply with 403", async () => {
    const provider = new FakeSharePointStorageProvider();
    const routes = createSharePointStorageRoutes({
      provider,
      resolveCaller: () => makeCaller([SHAREPOINT_CLEANUP_PERMISSION]),
    });
    await expect(
      routes[1]?.handler(ctxFor(`/v1/tenants/${TENANT}/sharepoint/sites/${SITE}/versions/cleanup`, { confirmCount: 1 })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects apply without confirmCount with 400", async () => {
    const provider = new FakeSharePointStorageProvider();
    const routes = createSharePointStorageRoutes({
      provider,
      resolveCaller: () => makeCaller([SHAREPOINT_CLEANUP_PERMISSION, "Remediation.Apply"]),
    });
    await expect(
      routes[1]?.handler(ctxFor(`/v1/tenants/${TENANT}/sharepoint/sites/${SITE}/versions/cleanup`, {})),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("passes preview input to the provider", async () => {
    const provider = new FakeSharePointStorageProvider();
    const routes = createSharePointStorageRoutes({
      provider,
      resolveCaller: () => makeCaller([SHAREPOINT_CLEANUP_PERMISSION, "Remediation.Apply"]),
    });
    const response = await routes[1]?.handler(
      ctxFor(`/v1/tenants/${TENANT}/sharepoint/sites/${SITE}/versions/cleanup`, {
        preview: true,
        ageThresholdDays: 30,
        includeVersions: ["v9"],
        excludeVersions: ["v2"],
      }),
    );
    expect(response?.status).toBe(200);
    const body = response?.body as VersionCleanupPlan;
    expect(body.mode).toBe("plan");
    expect(body.writes).toBe(false);
    expect(provider.calls[0]?.input).toMatchObject({ preview: true, ageThresholdDays: 30, includeVersions: ["v9"], excludeVersions: ["v2"] });
  });

  it("passes apply input with confirmCount to the provider", async () => {
    const provider = new FakeSharePointStorageProvider();
    const routes = createSharePointStorageRoutes({
      provider,
      resolveCaller: () => makeCaller([SHAREPOINT_CLEANUP_PERMISSION, "Remediation.Apply"]),
    });
    const response = await routes[1]?.handler(
      ctxFor(`/v1/tenants/${TENANT}/sharepoint/sites/${SITE}/versions/cleanup`, { confirmCount: 1 }),
    );
    expect(response?.status).toBe(200);
    const body = response?.body as VersionCleanupApply;
    expect(body.mode).toBe("apply");
    expect(body.summary.removed).toBe(1);
  });

  it("validates ageThresholdDays range", () => {
    expect(() => parseVersionCleanupInput({ ageThresholdDays: -1 })).toThrow(AppError);
    expect(() => parseVersionCleanupInput({ ageThresholdDays: 4000 })).toThrow(AppError);
    expect(() => parseVersionCleanupInput({ ageThresholdDays: "abc" })).toThrow(AppError);
  });

  it("validates includeVersions and excludeVersions are string arrays", () => {
    expect(() => parseVersionCleanupInput({ includeVersions: "v1" })).toThrow(AppError);
    expect(() => parseVersionCleanupInput({ excludeVersions: [1, 2] })).toThrow(AppError);
  });

  it("validates confirmCount is a non-negative integer", () => {
    expect(() => parseVersionCleanupInput({ confirmCount: -1 })).toThrow(AppError);
    expect(() => parseVersionCleanupInput({ confirmCount: "abc" })).toThrow(AppError);
  });
});
