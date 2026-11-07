import { describe, expect, it } from "vitest";
import type { CredentialRecord, CredentialStoreRow } from "../routes/credentials.js";
import { createSharingProviders } from "./sharing.js";
import type { WorkerRunner } from "./workers.js";

const CREDENTIAL: CredentialRecord = {
  id: "c-1",
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
  getCredential: async (tenantId) => (tenantId === "t-a" ? CREDENTIAL : undefined),
  upsertCredential: async (input) => input,
  appendAuditEvent: async () => undefined,
};

interface Call {
  readonly entrypoint: string;
  readonly job: Record<string, unknown>;
}

function harness(handler: (entrypoint: string, job: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const run: WorkerRunner = async <T>(entrypoint: string, job: Record<string, unknown>): Promise<T> => {
    calls.push({ entrypoint, job });
    return handler(entrypoint, job) as T;
  };
  return { calls, providers: createSharingProviders(run, credentials) };
}

describe("Sharing providers (T-0857)", () => {
  it("reads the sharing-links report with the flat worker job", async () => {
    const { calls, providers } = harness(() => ({
      tenantId: "t-a",
      totalCount: 1,
      items: [
        {
          siteId: "site-1",
          siteName: "Team Alpha",
          siteUrl: "https://contoso.example.invalid/sites/alpha",
          itemId: "item-1",
          itemName: "Report.docx",
          itemUrl: "https://contoso.example.invalid/report.docx",
          driveId: "drive-1",
          linkId: "link-1",
          linkType: "anonymous",
          permissions: "view",
          createdBy: "owner@example.invalid",
          created: "2026-01-01T00:00:00Z",
          expires: null,
        },
      ],
      nextCursor: "",
    }));

    const page = await providers.sharingReport.listLinks("t-a", {
      linkType: "anonymous",
      permissions: "view",
      site: "alpha",
      createdAfter: "2026-01-01T00:00:00Z",
      anonymousOnly: true,
      cursor: null,
      limit: 50,
    });

    expect(page.nextCursor).toBeNull();
    expect(page.items[0]?.linkId).toBe("link-1");
    expect(calls[0]!.entrypoint).toBe("get-sharing-report.ps1");
    expect(calls[0]!.job).toMatchObject({
      linkType: "anonymous",
      permissions: "view",
      site: "alpha",
      createdAfter: "2026-01-01T00:00:00Z",
      anonymousOnly: true,
      top: 50,
      cursor: "",
    });
    expect(calls[0]!.job["credential"]).toMatchObject({ record: { tenantId: "t-a" } });
  });

  it("reads the permissions report with the flat worker job", async () => {
    const { calls, providers } = harness(() => ({
      tenantId: "t-a",
      totalCount: 0,
      items: [],
      nextCursor: "",
    }));

    const page = await providers.permissionsReport.listPermissions("t-a", {
      role: "owner",
      principalType: "group",
      cursor: null,
      limit: 100,
    });

    expect(page.nextCursor).toBeNull();
    expect(calls[0]!.entrypoint).toBe("get-permissions-report.ps1");
    expect(calls[0]!.job).toMatchObject({ role: "owner", principalType: "group", top: 100, cursor: "" });
  });

  it("reads external users and their access drill-through through the envelope", async () => {
    const { calls, providers } = harness((_entrypoint, job) => {
      const payload = job["payload"] as Record<string, unknown>;
      if (payload["externalUserId"]) {
        return {
          tenantId: "t-a",
          externalUserId: payload["externalUserId"],
          totalCount: 1,
          items: [{ siteId: "site-1", siteName: "Alpha", siteUrl: "https://alpha", roles: ["read"], linkType: "anonymous", invitedBy: null, invitedAt: null, lastAccess: null }],
          nextCursor: "",
        };
      }
      return {
        tenantId: "t-a",
        totalCount: 1,
        items: [
          {
            externalUserId: "ext-1",
            externalUser: "Partner",
            email: "partner@example.invalid",
            sites: ["Alpha"],
            siteCount: 1,
            accessCount: 2,
            lastAccess: null,
            invitedBy: null,
          },
        ],
        nextCursor: "",
      };
    });

    const list = await providers.externalUsers.listExternalUsers("t-a", {
      search: "partner",
      cursor: null,
      limit: 100,
    });
    expect(list.items[0]?.email).toBe("partner@example.invalid");

    const access = await providers.externalUsers.listExternalUserAccess("t-a", "ext-1", {
      cursor: null,
      limit: 100,
    });
    expect(access.externalUserId).toBe("ext-1");
    expect(access.items[0]?.siteName).toBe("Alpha");

    expect(calls[0]!.entrypoint).toBe("get-external-users.ps1");
    expect(calls[0]!.job["payload"]).toMatchObject({ search: "partner", top: 100, cursor: "" });
    expect(calls[1]!.job["payload"]).toMatchObject({ externalUserId: "ext-1" });
  });

  it("removes one sharing link through the worker and maps its result", async () => {
    const { calls, providers } = harness(() => ({
      jobId: "job-1",
      tenantId: "t-a",
      mode: "apply",
      state: "completed",
      results: [
        {
          linkId: "link-1",
          state: "removed",
          before: { linkId: "link-1" },
          after: null,
          appliedAt: "2026-11-07T00:00:00Z",
          actor: "",
          error: null,
        },
      ],
      summary: { total: 1, removed: 1, failed: 0, skipped: 0 },
    }));

    const outcome = await providers.linkRemoval.removeLink("t-a", {
      linkId: "link-1",
      itemId: "item-1",
      driveId: "drive-1",
      linkType: "anonymous",
      resourceName: "Report.docx",
    });

    expect(outcome.status).toBe("removed");
    expect(outcome.before).toEqual({ linkId: "link-1" });
    expect(calls[0]!.entrypoint).toBe("remove-sharing-links.ps1");
    expect(calls[0]!.job).toMatchObject({ mode: "Apply", confirmCount: 1 });
    expect(calls[0]!.job["links"]).toEqual([
      {
        linkId: "link-1",
        itemId: "item-1",
        driveId: "drive-1",
        linkType: "anonymous",
        resourceName: "Report.docx",
      },
    ]);
  });
});
