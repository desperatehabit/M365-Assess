import { describe, expect, it } from "vitest";
import type { AuditRepository } from "@m365-assess/db";
import type { CredentialRecord, CredentialStoreRow } from "../routes/credentials.js";
import { createAuditProviders } from "./audit-logs.js";
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
  getCredential: async (tenantId) => ({ ...CREDENTIAL, tenantId }),
  upsertCredential: async (input) => input,
  appendAuditEvent: async () => undefined,
};

type Row = Record<string, unknown>;

function harness(handler: (entrypoint: string, job: Row) => unknown) {
  const calls: Array<{ entrypoint: string; job: Row }> = [];
  const run: WorkerRunner = async <T>(entrypoint: string, job: Row): Promise<T> => {
    calls.push({ entrypoint, job });
    return handler(entrypoint, job) as T;
  };
  return { calls, providers: createAuditProviders(run, credentials) };
}

function payloadOf(job: Row): Row {
  return (job["payload"] ?? {}) as Row;
}

describe("Audit providers (T-0862)", () => {
  it("runs a manual search through the envelope worker", async () => {
    const { calls, providers } = harness(() => ({
      tenantId: "t-a",
      searchId: "search-1",
      workloads: ["Exchange"],
      totalCount: 1,
      results: [
        {
          timestamp: "2026-09-20T10:00:00Z",
          user: "alex@example.invalid",
          activity: "Send",
          workload: "Exchange",
          object: "message-1",
          result: "Success",
        },
      ],
    }));

    const run = await providers.search.search("t-a", {
      startDate: "2026-09-01T00:00:00Z",
      endDate: "2026-09-30T00:00:00Z",
      user: "alex",
      workloads: ["Exchange"],
      top: 50,
    });

    expect(run.searchId).toBe("search-1");
    expect(run.results[0]?.object).toBe("message-1");
    expect(calls[0]!.entrypoint).toBe("search-audit.ps1");
    expect(payloadOf(calls[0]!.job)).toMatchObject({
      action: "search",
      startDate: "2026-09-01T00:00:00Z",
      endDate: "2026-09-30T00:00:00Z",
      user: "alex",
      workloads: ["Exchange"],
      top: 50,
    });
    expect(calls[0]!.job["credential"]).toMatchObject({ record: { tenantId: "t-a" } });
  });

  it("reads directory audits through the envelope worker", async () => {
    const { calls, providers } = harness(() => ({
      tenantId: "t-a",
      category: "UserManagement",
      totalCount: 1,
      entries: [
        {
          timestamp: "2026-09-20T10:00:00Z",
          activity: "Add user",
          initiatedBy: "admin",
          target: "alex",
          result: "Success",
        },
      ],
    }));

    const run = await providers.search.listDirectory("t-a", {
      category: "UserManagement",
      top: 25,
    });

    expect(run.entries[0]?.activity).toBe("Add user");
    expect(payloadOf(calls[0]!.job)).toMatchObject({
      action: "directory",
      category: "UserManagement",
      top: 25,
    });
  });

  it("re-dispatches a saved search and returns a completed job", async () => {
    const { calls, providers } = harness((_entrypoint, job) => ({
      searchId: "search-saved",
      tenantId: job["tenantId"],
      workloads: [payloadOf(job)["workload"]],
      totalCount: 0,
      results: [],
    }));

    const job = await providers.savedSearch.startSearch(
      "t-a",
      { user: "alex", workload: "Directory", startDate: "2026-09-01T00:00:00Z" },
      "user-1",
    );

    expect(job.id).toBe("search-saved");
    expect(job.state).toBe("completed");
    expect(job.createdBy).toBe("user-1");
    expect(payloadOf(calls[0]!.job)).toMatchObject({
      action: "search",
      user: "alex",
      workload: "Directory",
    });
  });

  it("computes coverage with the portal-side lastSearchAt and finding", async () => {
    const { calls, providers } = harness(() => ({
      tenantId: "t-a",
      auditEnabled: false,
      lastSearchAt: "2026-09-20T00:00:00Z",
      gaps: [
        {
          checkId: "COMPLIANCE-AUDIT-001",
          title: "Audit logging disabled",
          description: "Unified audit logging is off.",
          remediation: "Enable unified audit logging.",
          findingId: "finding-1",
          runId: "run-1",
        },
      ],
    }));

    const coverage = await providers.coverage.getAuditCoverage("t-a", {
      lastSearchAt: "2026-09-20T00:00:00Z",
      finding: { id: "finding-1", runId: "run-1", checkId: "COMPLIANCE-AUDIT-001" },
    });

    expect(coverage.auditEnabled).toBe(false);
    expect(coverage.gaps[0]?.checkId).toBe("COMPLIANCE-AUDIT-001");
    expect(calls[0]!.entrypoint).toBe("get-audit-coverage.ps1");
    expect(calls[0]!.job).toMatchObject({
      lastSearchAt: "2026-09-20T00:00:00Z",
      finding: { id: "finding-1" },
    });
  });
});

describe("Webhook provider mirroring (T-0862)", () => {
  function makeStore() {
    const rows = new Map<string, Row>();
    const store: Pick<
      AuditRepository,
      | "getWebhookSubscription"
      | "createWebhookSubscription"
      | "updateWebhookSubscription"
      | "softDeleteWebhookSubscription"
    > = {
      async getWebhookSubscription(tenantId, subscriptionId) {
        const row = rows.get(`${tenantId}/${subscriptionId}`);
        return row as never;
      },
      async createWebhookSubscription(input) {
        rows.set(`${input.tenantId}/${input.id}`, { ...input });
        return input as never;
      },
      async updateWebhookSubscription(tenantId, subscriptionId, update) {
        const key = `${tenantId}/${subscriptionId}`;
        const row = { ...(rows.get(key) ?? {}), ...update };
        rows.set(key, row);
        return row as never;
      },
      async softDeleteWebhookSubscription(tenantId, subscriptionId) {
        rows.delete(`${tenantId}/${subscriptionId}`);
        return true;
      },
    };
    return { store, rows };
  }

  function providers(handler: (entrypoint: string, job: Row) => unknown) {
    const calls: Array<{ entrypoint: string; job: Row }> = [];
    const run: WorkerRunner = async <T>(entrypoint: string, job: Row): Promise<T> => {
      calls.push({ entrypoint, job });
      return handler(entrypoint, job) as T;
    };
    const { store, rows } = makeStore();
    return { calls, rows, provider: createAuditProviders(run, credentials, { webhookStore: store }).webhooks };
  }

  it("lists subscriptions and mirrors them into the repository", async () => {
    const { calls, rows, provider } = providers(() => ({
      success: true,
      tenantId: "t-a",
      subscriptions: [
        {
          id: "sub-1",
          tenantId: "t-a",
          resource: "users",
          notificationUrl: "https://portal.example/v1/webhooks/notify",
          expirationDateTime: "2026-11-20T00:00:00Z",
          state: "active",
        },
      ],
    }));

    const list = await provider.list("t-a");
    expect(list.subscriptions[0]?.state).toBe("active");
    expect(calls[0]!.entrypoint).toBe("manage-webhooks.ps1");
    expect(calls[0]!.job).toMatchObject({ action: "list" });
    expect(rows.get("t-a/sub-1")).toMatchObject({
      resource: "users",
      expiresOn: "2026-11-20T00:00:00Z",
    });
  });

  it("creates, renews, and deletes through the worker and the repository", async () => {
    const { calls, rows, provider } = providers((_entrypoint, job) => {
      const action = job["action"];
      if (action === "create") {
        return {
          success: true,
          subscription: {
            id: "sub-1",
            tenantId: "t-a",
            resource: "groups",
            notificationUrl: "https://portal.example/v1/webhooks/notify",
            expirationDateTime: "2026-11-20T00:00:00Z",
            state: "active",
            clientState: "state-1",
          },
          auditEvent: { id: "audit-1", tenantId: "t-a", action: "webhook.subscription.create" },
        };
      }
      if (action === "renew") {
        return {
          success: true,
          subscription: {
            id: "sub-1",
            tenantId: "t-a",
            resource: "groups",
            notificationUrl: "https://portal.example/v1/webhooks/notify",
            expirationDateTime: "2026-11-27T00:00:00Z",
            state: "active",
          },
          auditEvent: { id: "audit-2", tenantId: "t-a", action: "webhook.subscription.renew" },
        };
      }
      return { success: true, deleted: "sub-1", auditEvent: { id: "audit-3", tenantId: "t-a" } };
    });

    const created = await provider.create("t-a", {
      resource: "groups",
      notificationUrl: "https://portal.example/v1/webhooks/notify",
    });
    expect(created.subscription?.id).toBe("sub-1");
    expect(rows.get("t-a/sub-1")).toMatchObject({ resource: "groups" });

    const renewed = await provider.renew("t-a", "sub-1");
    expect(renewed.subscription?.expirationDateTime).toBe("2026-11-27T00:00:00Z");
    expect(rows.get("t-a/sub-1")).toMatchObject({ state: "active" });

    const removed = await provider.remove("t-a", "sub-1");
    expect(removed.success).toBe(true);
    expect(removed.deleted).toBe("sub-1");
    expect(rows.has("t-a/sub-1")).toBe(false);
    expect(calls.map((call) => call.job["action"])).toEqual(["create", "renew", "delete"]);
  });

  it("reports a failed renewal without throwing", async () => {
    const { provider } = providers(() => ({
      success: false,
      error: "expired",
      alertEvent: {
        kind: "webhook.renewal_failed",
        severity: "high",
        tenantId: "t-a",
        subscriptionId: "sub-1",
        resource: "users",
        reason: "expired",
        timestamp: "2026-11-08T00:00:00Z",
      },
    }));

    const renewed = await provider.renew("t-a", "sub-1");
    expect(renewed.success).toBe(false);
    expect(renewed.alertEvent?.kind).toBe("webhook.renewal_failed");
  });
});
