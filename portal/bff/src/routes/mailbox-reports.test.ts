import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import {
  MAILBOX_REPORTS_PATH,
  createMailboxReportsRoute,
  parseMailboxReportFilter,
  type MailboxReportFilter,
  type MailboxReportsCaller,
  type MailboxReportsProvider,
} from "./mailbox-reports.js";
import { MAILBOXES_READ_PERMISSION } from "./mailboxes.js";

const TENANT = "tenant-test";

class FakeMailboxReportsProvider implements MailboxReportsProvider {
  readonly calls: Array<{ tenantId: string; filter: MailboxReportFilter }> = [];

  async getMailboxReport(
    tenantId: string,
    filter: MailboxReportFilter,
  ): Promise<{ rows: readonly Record<string, unknown>[]; nextCursor: string | null; retrievedAt: string }> {
    this.calls.push({ tenantId, filter });
    return {
      rows: [{ mailbox: "Support Desk", permissionType: "FullAccess" }],
      nextCursor: null,
      retrievedAt: "2026-09-28T00:00:00.000Z",
    };
  }
}

describe("Mailbox reports route (T-0381)", () => {
  it("exposes GET /v1/tenants/:tenantId/mailbox-reports", () => {
    const route = createMailboxReportsRoute({
      provider: new FakeMailboxReportsProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [MAILBOXES_READ_PERMISSION],
      }),
    });
    expect(route.method).toBe("GET");
    expect(route.path).toBe(MAILBOX_REPORTS_PATH);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const route = createMailboxReportsRoute({
      provider: new FakeMailboxReportsProvider(),
      resolveCaller: () => undefined,
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mailbox-reports`,
        params: { tenantId: TENANT },
        query: new URLSearchParams("report=permissions"),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const route = createMailboxReportsRoute({
      provider: new FakeMailboxReportsProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [MAILBOXES_READ_PERMISSION],
      }),
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mailbox-reports`,
        params: { tenantId: TENANT },
        query: new URLSearchParams("report=permissions"),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing Mailboxes.Mailbox.Read with 403", async () => {
    const route = createMailboxReportsRoute({
      provider: new FakeMailboxReportsProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Identity.User.Read"],
      }),
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mailbox-reports`,
        params: { tenantId: TENANT },
        query: new URLSearchParams("report=mailflow"),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("serves the §3.7 report set through the provider with no M365 call of its own", async () => {
    const provider = new FakeMailboxReportsProvider();
    const caller: MailboxReportsCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [MAILBOXES_READ_PERMISSION],
    };
    const route = createMailboxReportsRoute({ provider, resolveCaller: () => caller });

    for (const report of ["statistics", "activity", "permissions", "calendarPermissions", "forwarding", "mailflow"]) {
      const response = await route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mailbox-reports`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(`report=${report}`),
        headers: {},
      });
      expect(response.status).toBe(200);
      const body = response.body as { report: string; rows: unknown[]; retrievedAt: string };
      expect(body.report).toBe(report);
      expect(body.rows).toHaveLength(1);
      expect(body.retrievedAt).toBe("2026-09-28T00:00:00.000Z");
    }
    expect(provider.calls).toHaveLength(6);
  });

  it("rejects a missing or unknown report name with 400", async () => {
    const caller: MailboxReportsCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [MAILBOXES_READ_PERMISSION],
    };
    const route = createMailboxReportsRoute({
      provider: new FakeMailboxReportsProvider(),
      resolveCaller: () => caller,
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mailbox-reports`,
        params: { tenantId: TENANT },
        query: new URLSearchParams("report=retention"),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mailbox-reports`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(() => parseMailboxReportFilter(new URLSearchParams("report=retention"))).toThrow(AppError);
  });
});
