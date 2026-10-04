import { describe, expect, it } from "vitest";
import type { CredentialRecord, CredentialStoreRow } from "../routes/credentials.js";
import { createSharePointProviders } from "./sharepoint.js";
import type { WorkerRunner } from "./workers.js";

const CRED: CredentialRecord = {
  id: "c",
  tenantId: "t-a",
  authMethod: "certificate-thumbprint",
  clientId: "app-1",
  secretRef: "thumbprint://ABC",
  thumbprint: "ABC",
  environment: "commercial",
  expiresOn: null,
  lastValidated: null,
  createdAt: "",
  updatedAt: "",
};

const credentials: CredentialStoreRow = {
  getCredential: async (tenantId) => (tenantId === "t-a" ? CRED : undefined),
  upsertCredential: async (input) => input,
  appendAuditEvent: async () => undefined,
};

function harness(respond: (entrypoint: string, job: Record<string, unknown>) => unknown = () => ({})) {
  const calls: { entrypoint: string; job: Record<string, unknown> }[] = [];
  const run: WorkerRunner = async (entrypoint, job) => {
    calls.push({ entrypoint, job: job as Record<string, unknown> });
    return respond(entrypoint, job as Record<string, unknown>) as never;
  };
  return { providers: createSharePointProviders(run, credentials), calls };
}

describe("SharePoint providers (T-0855)", () => {
  it("lists sites with the §3.1 filters and the tenant's credential block", async () => {
    const { providers, calls } = harness(() => ({ tenantId: "t-a", totalCount: 0, items: [], nextCursor: null }));
    const page = await providers.sites.listSites("t-a", {
      type: "team",
      sharing: "externalUserSharingOnly",
      storagePercent: 25,
      lastActivity: "2026-07-01T00:00:00Z",
      sensitivity: "General",
      cursor: "cursor-1",
      limit: 50,
    });
    expect(page.totalCount).toBe(0);
    expect(calls[0]).toEqual({
      entrypoint: "get-sharepoint-sites.ps1",
      job: {
        tenantId: "t-a",
        credential: { credentialRef: "tenants/t-a/credential", record: expect.objectContaining({ thumbprint: "ABC" }) },
        Type: "team",
        Sharing: "externalUserSharingOnly",
        StoragePercent: "25",
        LastActivity: "2026-07-01T00:00:00Z",
        Sensitivity: "General",
        Top: 50,
        Cursor: "cursor-1",
      },
    });
  });

  it("creates a single site through the T-0007 envelope, mapping planned and created rows", async () => {
    const input = {
      name: "Team Alpha",
      alias: "alpha",
      type: "team" as const,
      owners: ["owner1@example.invalid"],
      sharing: "disabled" as const,
    };
    const planned = harness(() => ({ name: "Team Alpha", alias: "alpha", type: "team", status: "planned", id: null, error: null }));
    await expect(planned.providers.sitesCreate.createSite("t-a", input, true)).resolves.toMatchObject({
      action: "create",
      targetName: "Team Alpha",
      dryRun: true,
    });
    expect(planned.calls[0]?.entrypoint).toBe("new-sharepoint-site.ps1");
    expect(planned.calls[0]?.job).toMatchObject({
      schemaVersion: "v1",
      payload: { site: { name: "Team Alpha", alias: "alpha", type: "team", owners: ["owner1@example.invalid"], sharing: "disabled" }, dryRun: true },
    });

    const created = harness(() => ({ name: "Team Alpha", alias: "alpha", type: "team", status: "created", id: "site-1", error: null }));
    await expect(created.providers.sitesCreate.createSite("t-a", input, false)).resolves.toMatchObject({
      success: true,
      siteId: "site-1",
      plan: { dryRun: false },
    });
    expect(created.calls[0]?.job).toMatchObject({ payload: { dryRun: false } });
  });

  it("bulk-creates from CSV and from a sites array, mapping per-row results", async () => {
    const csvCall = harness(() => ({
      tenantId: "t-a",
      total: 2,
      created: 1,
      planned: 0,
      failed: 1,
      dryRun: false,
      results: [
        { row: 1, name: "Team Alpha", alias: "alpha", type: "team", status: "created", id: "site-1", error: null, before: null, after: null },
        { row: 2, name: "Team Beta", alias: "beta", type: "team", status: "failed", id: null, error: "alias already taken", before: null, after: null },
      ],
    }));
    const csv = "name,alias,type,owners,template,sharing\nTeam Alpha,alpha,team,owner1@example.invalid,,disabled";
    await expect(csvCall.providers.sitesCreate.createSitesBulk("t-a", [], csv, false)).resolves.toEqual({
      success: false,
      total: 2,
      created: 1,
      failed: 1,
      results: [
        { row: 1, name: "Team Alpha", alias: "alpha", status: "created", siteId: "site-1" },
        { row: 2, name: "Team Beta", alias: "beta", status: "failed", error: "alias already taken" },
      ],
    });
    expect(csvCall.calls[0]?.entrypoint).toBe("new-sharepoint-site-bulk.ps1");
    expect(csvCall.calls[0]?.job).toMatchObject({ schemaVersion: "v1", payload: { csv, dryRun: false } });

    const sitesCall = harness(() => ({ tenantId: "t-a", total: 1, created: 0, planned: 1, failed: 0, dryRun: true, results: [] }));
    await sitesCall.providers.sitesCreate.createSitesBulk(
      "t-a",
      [{ name: "Team Gamma", alias: "gamma", type: "communication", owners: ["owner2@example.invalid"], sharing: "externalUserSharingOnly" }],
      undefined,
      true,
    );
    expect(sitesCall.calls[0]?.job).toMatchObject({
      payload: {
        sites: [{ name: "Team Gamma", alias: "gamma", type: "communication", owners: ["owner2@example.invalid"], sharing: "externalUserSharingOnly" }],
        dryRun: true,
      },
    });
  });

  it("deletes and restores a site through the lifecycle action, mapping plan and applied results", async () => {
    const planOutput = {
      action: "delete",
      siteId: "site-1",
      targetName: "Team Alpha",
      before: { id: "site-1", state: "active" },
      after: { id: "site-1", state: "softDeleted" },
      diff: ["Soft-delete site 'Team Alpha' (site-1)"],
      valid: true,
      dryRun: true,
      requiresConfirmation: true,
    };
    const plan = harness(() => planOutput);
    await expect(plan.providers.lifecycle.deleteSite("t-a", "site-1", { preview: true }, true)).resolves.toMatchObject({
      action: "delete",
      siteId: "site-1",
      dryRun: true,
    });
    expect(plan.calls[0]?.entrypoint).toBe("invoke-sharepoint-site-action.ps1");
    expect(plan.calls[0]?.job).toMatchObject({
      schemaVersion: "v1",
      action: "delete",
      payload: { siteId: "site-1", dryRun: true, confirm: false },
    });

    const appliedOutput = {
      success: true,
      state: "succeeded",
      operation: "delete",
      siteId: "site-1",
      targetName: "Team Alpha",
      plan: planOutput,
      result: { id: "site-1", state: "softDeleted" },
      auditEvent: {
        id: "audit-1",
        tenantId: "t-a",
        action: "sharepoint.site.delete",
        targetId: "site-1",
        targetName: "Team Alpha",
        timestamp: "2026-09-28T00:00:00Z",
        result: "success",
        before: planOutput.before,
        after: planOutput.after,
        error: null,
        actor: "",
        correlationId: "corr-1",
      },
      siteOperation: { id: "op-1" },
    };
    const applied = harness(() => appliedOutput);
    await expect(applied.providers.lifecycle.deleteSite("t-a", "site-1", { confirm: true }, false)).resolves.toMatchObject({
      success: true,
      state: "succeeded",
      operation: "delete",
      siteId: "site-1",
      before: { id: "site-1", state: "active" },
      after: { id: "site-1", state: "softDeleted" },
      auditEvent: { action: "sharepoint.site.delete", actorUserId: "" },
    });
    expect(applied.calls[0]?.job).toMatchObject({ action: "delete", payload: { siteId: "site-1", dryRun: false, confirm: true } });

    const restore = harness(() => ({ ...appliedOutput, operation: "restore", auditEvent: { ...appliedOutput.auditEvent, action: "sharepoint.site.restore" } }));
    await expect(restore.providers.lifecycle.restoreSite("t-a", "site-1", {}, false)).resolves.toMatchObject({
      success: true,
      operation: "restore",
    });
    expect(restore.calls[0]?.job).toMatchObject({ action: "restore" });
  });

  it("lists the recycle bin and applies restore/empty with per-row results", async () => {
    const list = harness(() => ({
      tenantId: "t-a",
      items: [{ id: "rb-1", siteId: "rb-1", displayName: "Retired", url: null, deletedAt: "2026-09-01T00:00:00Z", daysUntilPurge: 20 }],
      nextCursor: "",
      totalCount: 1,
      retrievedAt: "2026-09-28T00:00:00Z",
    }));
    await expect(list.providers.lifecycle.listRecycleBin("t-a", { cursor: null, limit: 100 })).resolves.toMatchObject({
      tenantId: "t-a",
      totalCount: 1,
      items: [{ id: "rb-1", displayName: "Retired" }],
    });
    expect(list.calls[0]?.entrypoint).toBe("invoke-sharepoint-site-action.ps1");
    expect(list.calls[0]?.job).toMatchObject({ schemaVersion: "v1", action: "recyclebin-list" });

    const empty = harness(() => ({
      action: "empty",
      mode: "apply",
      results: [{ id: "rb-1", siteId: "rb-1", status: "emptied", before: { id: "rb-1", state: "deleted" }, after: { id: "rb-1", state: "purged" }, error: null }],
      auditEvents: [{ id: "audit-rb", tenantId: "t-a", action: "sharepoint.recyclebin.empty", targetId: "rb-1", targetName: "rb-1", timestamp: "2026-09-28T00:00:00Z", result: "success" }],
      siteOperations: [],
      summary: { total: 1, succeeded: 1, failed: 0 },
    }));
    await expect(
      empty.providers.lifecycle.recycleBinAction("t-a", { action: "empty", itemIds: ["rb-1"], confirm: true }, false),
    ).resolves.toMatchObject({
      action: "empty",
      mode: "apply",
      results: [{ id: "rb-1", status: "emptied" }],
      summary: { total: 1, succeeded: 1, failed: 0 },
    });
    expect(empty.calls[0]?.job).toMatchObject({
      action: "recyclebin-empty",
      payload: { recycleBinIds: ["rb-1"], dryRun: false, confirm: true },
    });
  });

  it("browses a site and reads its storage composition through the read workers", async () => {
    const browser = harness(() => ({
      tenantId: "t-a",
      siteId: "site-1",
      siteUrl: "https://contoso.sharepoint.com/sites/alpha",
      adminCenterUrl: "https://admin.microsoft.com/sharepoint?page=siteDetails",
      libraries: [{ id: "drive-1", name: "Documents", webUrl: "https://contoso.sharepoint.com/sites/alpha/Shared%20Documents", driveType: "documentLibrary", quotaUsedBytes: 1024, quotaTotalBytes: 2048 }],
      items: [],
      permissions: [],
      externalUsers: [],
      handoff: { permissionEdits: false, sharingPermissionsPath: "/v1/tenants/t-a/sharing/permissions", externalUsersPath: "/v1/tenants/t-a/sharing/external-users", sharingLinksRemovePath: "/v1/tenants/t-a/sharing/links/remove" },
    }));
    await expect(browser.providers.browse.browseSite("t-a", "site-1")).resolves.toMatchObject({
      siteId: "site-1",
      libraries: [{ name: "Documents" }],
    });
    expect(browser.calls[0]).toEqual({
      entrypoint: "get-site-browser.ps1",
      job: {
        tenantId: "t-a",
        credential: { credentialRef: "tenants/t-a/credential", record: expect.objectContaining({ thumbprint: "ABC" }) },
        SiteId: "site-1",
      },
    });

    const storage = harness(() => ({
      tenantId: "t-a",
      siteId: "site-1",
      documentsBytes: 1024,
      versionsBytes: 512,
      recycleBinBytes: 256,
      reclaimableBytes: 768,
      totalBytes: 1792,
      generatedAt: "2026-09-28T00:00:00.000Z",
    }));
    await expect(storage.providers.storage.getSiteStorage("t-a", "site-1")).resolves.toMatchObject({
      documentsBytes: 1024,
      reclaimableBytes: 768,
    });
    expect(storage.calls[0]?.entrypoint).toBe("get-site-storage.ps1");
  });

  it("previews and applies version cleanup with the age threshold and confirmation count", async () => {
    const plan = harness(() => ({
      jobId: "job-1",
      tenantId: "t-a",
      siteId: "site-1",
      mode: "plan",
      state: "planned",
      ageThresholdDays: 90,
      cutoffDate: "2026-06-30T00:00:00.000Z",
      versions: [{ versionId: "v1", itemId: "item-1", size: 100, lastModified: "2026-01-01T00:00:00Z", isCurrent: false, selected: true, reason: null }],
      selectedCount: 1,
      reclaimableBytes: 100,
      writes: false,
    }));
    await expect(
      plan.providers.storage.cleanupVersions("t-a", "site-1", { preview: true, ageThresholdDays: 90 }),
    ).resolves.toMatchObject({ mode: "plan", selectedCount: 1 });
    expect(plan.calls[0]?.entrypoint).toBe("invoke-version-cleanup.ps1");
    expect(plan.calls[0]?.job).toMatchObject({ SiteId: "site-1", AgeThresholdDays: 90, Mode: "Plan" });

    const apply = harness(() => ({
      jobId: "job-2",
      tenantId: "t-a",
      siteId: "site-1",
      mode: "apply",
      state: "completed",
      ageThresholdDays: 180,
      cutoffDate: "2026-03-31T00:00:00.000Z",
      results: [{ versionId: "v1", state: "applied", before: null, after: null, appliedAt: "2026-09-28T00:00:00Z", actor: "", error: null }],
      auditEvents: [],
      summary: { total: 1, removed: 1, failed: 0, skipped: 0 },
    }));
    await expect(
      apply.providers.storage.cleanupVersions("t-a", "site-1", { preview: false, ageThresholdDays: 180, confirmCount: 1 }),
    ).resolves.toMatchObject({ mode: "apply", summary: { removed: 1 } });
    expect(apply.calls[0]?.job).toMatchObject({ Mode: "Apply", ConfirmCount: 1, AgeThresholdDays: 180 });
  });

  it("reads OneDrive usage through the read worker", async () => {
    const { providers, calls } = harness(() => ({
      tenantId: "t-a",
      generatedAt: "2026-09-28T00:00:00.000Z",
      summary: { totalUsers: 1, usersWithOneDrive: 1, totalStorageUsedBytes: 1024, totalStorageQuotaBytes: 2048, usersOverQuotaWarning: 0, totalSharingLinks: 0, anonymousLinks: 0, organizationLinks: 0, userLinks: 0 },
      users: [{ userId: "u-1", displayName: "User One", userPrincipalName: "user1@example.invalid", hasOneDrive: true, storageUsedBytes: 1024, storageQuotaBytes: 2048, storageUsedPercent: 50, lastActivityDate: "2026-09-01T00:00:00Z", sharing: { total: 0, anonymous: 0, organization: 0, user: 0 }, sharingLinks: [] }],
    }));
    await expect(providers.onedrive.getUsage("t-a")).resolves.toMatchObject({
      tenantId: "t-a",
      summary: { totalUsers: 1 },
      users: [{ userPrincipalName: "user1@example.invalid" }],
    });
    expect(calls[0]?.entrypoint).toBe("get-onedrive-usage.ps1");
  });
});
