import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import {
  REMEDIATION_APPLY_PERMISSION,
  SHARING_LINKS_REMOVE_OPENAPI,
  SHARING_LINKS_REMOVE_PATH,
  SHARING_WRITE_PERMISSION,
  createSharingLinksRemoveRoutes,
  postSharingLinksRemove,
  type LinkRemovalJobRecord,
  type LinkRemovalJobStore,
  type SharingLinkRef,
  type SharingLinkRemovalAuditEvent,
  type SharingLinkRemovalProvider,
  type SharingLinksRemoveCaller,
  type SharingLinksRemoveRouteOptions,
} from "./sharing-links-remove.js";

const TENANT = "tenant-a";

const LINKS: SharingLinkRef[] = [
  { linkId: "perm-1", itemId: "item-1", driveId: "drive-1", linkType: "anonymous", resourceName: null },
  { linkId: "perm-2", itemId: "item-2", driveId: "drive-1", linkType: "organization", resourceName: null },
];

class FakeRemovalProvider implements SharingLinkRemovalProvider {
  readonly calls: Array<{ tenantId: string; link: SharingLinkRef }> = [];

  constructor(private readonly failLinkIds: readonly string[] = []) {}

  async removeLink(tenantId: string, link: SharingLinkRef) {
    this.calls.push({ tenantId, link });
    if (this.failLinkIds.includes(link.linkId)) {
      return { status: "failed" as const, before: link, after: null, error: "graph refused the delete" };
    }
    return { status: "removed" as const, before: link, after: null };
  }
}

class FakeJobStore implements LinkRemovalJobStore {
  readonly created: Array<{ id: string; tenantId: string }> = [];
  readonly updates: Array<{ jobId: string; state?: string }> = [];
  readonly jobs = new Map<string, LinkRemovalJobRecord>();

  async createLinkRemovalJob(input: { id: string; tenantId: string; linkIds: readonly string[]; createdBy: string }) {
    this.created.push({ id: input.id, tenantId: input.tenantId });
    const record: LinkRemovalJobRecord = {
      ...input,
      state: "planned",
      results: null,
      createdAt: "2026-09-26T00:00:00.000Z",
    };
    this.jobs.set(input.id, record);
    return record;
  }

  async updateLinkRemovalJob(tenantId: string, jobId: string, update: { state?: LinkRemovalJobRecord["state"]; results?: unknown }) {
    const existing = this.jobs.get(jobId);
    if (!existing || existing.tenantId !== tenantId) {
      return undefined;
    }
    this.updates.push({ jobId, state: update.state });
    const next: LinkRemovalJobRecord = {
      ...existing,
      state: update.state ?? existing.state,
      results: update.results ?? existing.results,
    };
    this.jobs.set(jobId, next);
    return next;
  }
}

function callerFor(tenantIds: readonly string[] | "all"): SharingLinksRemoveCaller {
  return {
    userId: "operator-1",
    roles: [],
    tenantScope: tenantIds === "all" ? { all: true, tenantIds: [] } : tenantScope(tenantIds),
  };
}

function contextFor(body: unknown) {
  return {
    correlationId: "corr-1",
    method: "POST",
    path: SHARING_LINKS_REMOVE_PATH,
    query: new URLSearchParams(),
    headers: {},
    params: { tenantId: TENANT },
    body,
  };
}

function optionsFor(
  provider: FakeRemovalProvider,
  jobs: FakeJobStore,
  audits: SharingLinkRemovalAuditEvent[],
): SharingLinksRemoveRouteOptions {
  return {
    provider,
    jobs,
    resolveCaller: () => callerFor("all"),
    authorize: async () => undefined,
    recordAudit: async (event) => {
      audits.push(event);
    },
    newId: () => "job-1",
  };
}

describe("sharing-link removal plan preview (T-0527)", () => {
  it("returns the exact link set and performs no writes", async () => {
    const provider = new FakeRemovalProvider();
    const jobs = new FakeJobStore();
    const audits: SharingLinkRemovalAuditEvent[] = [];
    const response = await postSharingLinksRemove(
      optionsFor(provider, jobs, audits),
      contextFor({ links: LINKS, reason: "risky links", preview: true }),
      TENANT,
      callerFor("all"),
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      tenantId: TENANT,
      mode: "plan",
      total: 2,
      writes: false,
    });
    expect((response.body as { links: Array<{ linkId: string }> }).links.map((link) => link.linkId)).toEqual([
      "perm-1",
      "perm-2",
    ]);
    expect(provider.calls).toHaveLength(0);
    expect(audits).toHaveLength(0);
    expect(jobs.created).toHaveLength(0);
  });
});

describe("sharing-link removal confirmation gate (T-0527)", () => {
  it("refuses to apply without an explicit confirmation", async () => {
    const provider = new FakeRemovalProvider();
    const jobs = new FakeJobStore();
    await expect(
      postSharingLinksRemove(
        optionsFor(provider, jobs, []),
        contextFor({ links: LINKS, reason: "risky links", confirmCount: 2 }),
        TENANT,
        callerFor("all"),
      ),
    ).rejects.toMatchObject({ status: 400, code: "sharing.confirm_required" });
    expect(provider.calls).toHaveLength(0);
    expect(jobs.created).toHaveLength(0);
  });

  it("refuses to apply when the confirmed count does not name the link count", async () => {
    const provider = new FakeRemovalProvider();
    const jobs = new FakeJobStore();
    await expect(
      postSharingLinksRemove(
        optionsFor(provider, jobs, []),
        contextFor({ links: LINKS, reason: "risky links", confirm: true, confirmCount: 1 }),
        TENANT,
        callerFor("all"),
      ),
    ).rejects.toMatchObject({ status: 400, code: "sharing.bulk_count_required" });
    expect(provider.calls).toHaveLength(0);
    expect(jobs.created).toHaveLength(0);
  });
});

describe("sharing-link removal apply (T-0527)", () => {
  it("removes every link, audits each one, and settles the job with per-link results", async () => {
    const provider = new FakeRemovalProvider();
    const jobs = new FakeJobStore();
    const audits: SharingLinkRemovalAuditEvent[] = [];
    const response = await postSharingLinksRemove(
      optionsFor(provider, jobs, audits),
      contextFor({ links: LINKS, reason: "risky links", confirm: true, confirmCount: 2 }),
      TENANT,
      callerFor("all"),
    );
    expect(response.body).toMatchObject({
      tenantId: TENANT,
      mode: "apply",
      jobId: "job-1",
      summary: { total: 2, removed: 2, failed: 0, skipped: 0 },
    });
    expect(provider.calls.map((call) => call.link.linkId)).toEqual(["perm-1", "perm-2"]);
    expect(audits.map((event) => event.targetId).sort()).toEqual(["perm-1", "perm-2"]);
    expect(audits.every((event) => event.action === "sharing.linkRemove" && event.result === "success")).toBe(true);
    expect(jobs.created).toEqual([{ id: "job-1", tenantId: TENANT }]);
    expect(jobs.updates.map((update) => update.state)).toEqual(["running", "completed"]);
    const settled = jobs.jobs.get("job-1");
    expect(settled?.state).toBe("completed");
    expect((settled?.results as { rows: unknown[] }).rows).toHaveLength(2);
  });

  it("records a per-link failure without silencing it and marks the job failed", async () => {
    const provider = new FakeRemovalProvider(["perm-2"]);
    const jobs = new FakeJobStore();
    const audits: SharingLinkRemovalAuditEvent[] = [];
    const response = await postSharingLinksRemove(
      optionsFor(provider, jobs, audits),
      contextFor({ links: LINKS, reason: "risky links", confirm: true, confirmCount: 2 }),
      TENANT,
      callerFor("all"),
    );
    expect(response.body).toMatchObject({ summary: { total: 2, removed: 1, failed: 1, skipped: 0 } });
    const outcome = response.body as { rows: Array<{ linkId: string; status: string; error: string | null }> };
    expect(outcome.rows.find((row) => row.linkId === "perm-1")?.status).toBe("removed");
    expect(outcome.rows.find((row) => row.linkId === "perm-2")).toMatchObject({
      status: "failed",
      error: "graph refused the delete",
    });
    expect(audits).toHaveLength(2);
    expect(audits.find((event) => event.targetId === "perm-2")).toMatchObject({ result: "failure" });
    expect(jobs.jobs.get("job-1")?.state).toBe("failed");
  });

  it("skips deferred direct-permission entries explicitly instead of dropping them", async () => {
    const provider = new FakeRemovalProvider();
    const jobs = new FakeJobStore();
    const audits: SharingLinkRemovalAuditEvent[] = [];
    const withDirect: SharingLinkRef[] = [
      ...LINKS,
      { linkId: "perm-9", itemId: "item-9", driveId: "drive-1", linkType: "direct", resourceName: null },
    ];
    const response = await postSharingLinksRemove(
      optionsFor(provider, jobs, audits),
      contextFor({ links: withDirect, reason: "risky links", confirm: true, confirmCount: 3 }),
      TENANT,
      callerFor("all"),
    );
    expect(response.body).toMatchObject({ summary: { total: 3, removed: 2, failed: 0, skipped: 1 } });
    expect(provider.calls.map((call) => call.link.linkId).sort()).toEqual(["perm-1", "perm-2"]);
  });
});

describe("sharing-link removal route wiring (T-0527)", () => {
  it("requires Sharing.Permissions.ReadWrite on the route and Remediation.Apply on apply", async () => {
    const seen: string[] = [];
    const routes = createSharingLinksRemoveRoutes({
      provider: new FakeRemovalProvider(),
      jobs: new FakeJobStore(),
      resolveCaller: () => callerFor("all"),
      authorize: async (_caller, permission) => {
        seen.push(permission);
      },
      recordAudit: async () => undefined,
      newId: () => "job-9",
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toContain(`POST ${SHARING_LINKS_REMOVE_PATH}`);
    const handler = routes[0];
    if (!handler) {
      throw new Error("expected the remove route to be registered");
    }
    await handler.handler(contextFor({ links: LINKS, reason: "risky links", preview: true }));
    expect(seen).toEqual([SHARING_WRITE_PERMISSION]);
    await handler.handler(contextFor({ links: LINKS, reason: "risky links", confirm: true, confirmCount: 2 }));
    expect(seen).toEqual([SHARING_WRITE_PERMISSION, SHARING_WRITE_PERMISSION, REMEDIATION_APPLY_PERMISSION]);
    expect(SHARING_LINKS_REMOVE_OPENAPI.paths["/tenants/{tenantId}/sharing/links/remove"].post.permission).toBe(
      "Sharing.Permissions.ReadWrite",
    );
  });

  it("refuses callers without Sharing.Permissions.ReadWrite and tenants outside scope", async () => {
    const routes = createSharingLinksRemoveRoutes({
      provider: new FakeRemovalProvider(),
      jobs: new FakeJobStore(),
      resolveCaller: () => ({ roles: [], permissions: [], tenantScope: tenantScope([TENANT]) }),
      recordAudit: async () => undefined,
    });
    const handler = routes[0];
    if (!handler) {
      throw new Error("expected the remove route to be registered");
    }
    await expect(
      handler.handler(contextFor({ links: LINKS, reason: "risky links", preview: true })),
    ).rejects.toMatchObject({ status: 403 });
    const scoped = createSharingLinksRemoveRoutes({
      provider: new FakeRemovalProvider(),
      jobs: new FakeJobStore(),
      resolveCaller: () => callerFor(["other-tenant"]),
      authorize: async () => undefined,
      recordAudit: async () => undefined,
    });
    const scopedHandler = scoped[0];
    if (!scopedHandler) {
      throw new Error("expected the remove route to be registered");
    }
    await expect(
      scopedHandler.handler(contextFor({ links: LINKS, reason: "risky links", preview: true })),
    ).rejects.toSatisfy((error: unknown) => error instanceof AppError && error.status === 403);
  });
});
