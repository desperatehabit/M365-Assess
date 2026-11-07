import { describe, expect, it } from "vitest";
import type { Finding, Run } from "@m365-assess/db";
import { AppError } from "../errors.js";
import type { CredentialRecord, CredentialStoreRow } from "../routes/credentials.js";
import type { TenantRecord } from "../routes/tenants.js";
import {
  createCheckAlertsProvider,
  createIncidentProviders,
  type IncidentDetailReadStore,
} from "./incidents.js";
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
  const store: IncidentDetailReadStore = {
    listIncidentNotes: async () => [
      { id: "note-1", incidentId: "inc-1", body: "Investigating", author: "analyst", at: "2026-01-01T00:00:00Z" },
    ],
    listAlertStateChanges: async () => [
      {
        id: "chg-1",
        alertId: "alert-1",
        incidentId: "inc-1",
        from: "new",
        to: "inProgress",
        by: "analyst",
        at: "2026-01-01T01:00:00Z",
        reason: "triaged",
      },
    ],
  };
  return { calls, run, store, providers: createIncidentProviders(run, credentials, store) };
}

describe("incident providers (T-0858)", () => {
  it("lists incidents through get-incidents.ps1 with the route filters", async () => {
    const { calls, run } = harness(() => ({
      tenantId: "t-a",
      totalCount: 1,
      items: [{ id: "inc-1", title: "Suspicious sign-in", severity: "high", status: "active", classification: "truePositive", assignedTo: "", alertCount: 2, lastUpdated: "2026-01-01T00:00:00Z", tenantId: "t-a" }],
      nextCursor: null,
    }));
    const providers = createIncidentProviders(run, credentials, {
      listIncidentNotes: async () => [],
      listAlertStateChanges: async () => [],
    });

    const page = await providers.incidents.listIncidents("t-a", {
      severity: "high",
      status: "active",
      cursor: null,
      limit: 25,
    });

    expect(page).toMatchObject({ tenantId: "t-a", totalCount: 1, nextCursor: null });
    expect(page.items[0]).toMatchObject({ id: "inc-1", severity: "high" });
    expect(calls[0]!.entrypoint).toBe("get-incidents.ps1");
    expect(calls[0]!.job).toMatchObject({ tenantId: "t-a", severity: "high", status: "active", top: 25 });
    expect(calls[0]!.job["credential"]).toMatchObject({ record: { tenantId: "t-a" } });
  });

  it("merges portal notes and alert state changes into the detail worker job", async () => {
    const { calls, run } = harness(() => ({
      tenantId: "t-a",
      incidentId: "inc-1",
      overview: {},
      alerts: [],
      entities: [],
      timeline: [],
      notes: [],
      retrievedAt: "2026-01-01T00:00:00Z",
    }));
    const providers = createIncidentProviders(run, credentials, {
      listIncidentNotes: async () => [{ id: "note-1", incidentId: "inc-1", body: "Investigating", author: "analyst", at: "2026-01-01T00:00:00Z" }],
      listAlertStateChanges: async () => [
        { id: "chg-1", alertId: "alert-1", incidentId: "inc-1", from: "new", to: "inProgress", by: "analyst", at: "2026-01-01T01:00:00Z", reason: "triaged" },
      ],
    });

    await providers.detail.getIncident("t-a", "inc-1");

    expect(calls[0]!.entrypoint).toBe("get-incident-detail.ps1");
    expect(calls[0]!.job).toMatchObject({
      incidentId: "inc-1",
      portalNotes: [{ id: "note-1", body: "Investigating" }],
      stateChanges: [{ id: "chg-1", from: "new", to: "inProgress" }],
    });
  });

  it("runs incident actions through the T-0007 envelope worker", async () => {
    const { calls, run } = harness(() => ({
      status: "applied",
      writeBack: true,
      from: "active",
      to: "resolved",
      before: null,
      after: null,
      note: null,
      error: null,
    }));
    const providers = createIncidentProviders(run, credentials, {
      listIncidentNotes: async () => [],
      listAlertStateChanges: async () => [],
    });

    await providers.actions.executeAction("t-a", "inc-1", "status", {
      value: "resolved",
      comment: "",
      reason: "duplicate",
      dryRun: false,
    });

    expect(calls[0]!.entrypoint).toBe("invoke-incident-action.ps1");
    expect(calls[0]!.job).toMatchObject({
      schemaVersion: "v1",
      tenantId: "t-a",
      payload: { incidentId: "inc-1", action: "status", value: "resolved", reason: "duplicate", confirm: true },
    });
  });

  it("lists tenant alerts through get-alerts.ps1", async () => {
    const { calls, run } = harness(() => ({
      tenantId: "t-a",
      totalCount: 1,
      items: [{ id: "alert-1", source: "defender", title: "Alert", severity: "high", status: "new" }],
      nextCursor: null,
    }));
    const providers = createIncidentProviders(run, credentials, {
      listIncidentNotes: async () => [],
      listAlertStateChanges: async () => [],
    });

    const page = await providers.alerts.listAlerts("t-a", { source: "defender", cursor: null, limit: 10 });

    expect(page.items).toHaveLength(1);
    expect(calls[0]!.entrypoint).toBe("get-alerts.ps1");
    expect(calls[0]!.job).toMatchObject({ source: "defender", top: 10 });
  });

  it("runs alert actions and turns the worker's unsupported error into a result", async () => {
    let unsupported = false;
    const run: WorkerRunner = async <T>(entrypoint: string, job: Record<string, unknown>): Promise<T> => {
      if (entrypoint === "invoke-alert-action.ps1" && (job["payload"] as { action?: string }).action === "create-incident") {
        unsupported = true;
        throw new AppError("worker.failed", "alerts.unsupported_action: action 'create-incident' is not supported");
      }
      return { status: "applied", writeBack: true, from: "new", to: "inProgress", before: null, after: null, note: null } as T;
    };
    const providers = createIncidentProviders(run, credentials, {
      listIncidentNotes: async () => [],
      listAlertStateChanges: async () => [],
    });

    const supported = await providers.alertActions.executeAction("t-a", "alert-1", "status", {
      value: "inProgress",
      comment: "",
      reason: "triage",
      dryRun: false,
    });
    const refused = await providers.alertActions.executeAction("t-a", "alert-1", "create-incident", {
      value: "",
      comment: "",
      reason: "promote",
      dryRun: false,
    });

    expect(supported.status).toBe("applied");
    expect(refused.status).toBe("unsupported");
    expect(unsupported).toBe(true);
  });
});

function tenant(id: string, extra: Partial<TenantRecord> = {}): TenantRecord {
  return {
    id,
    displayName: id,
    defaultDomain: `${id}.example`,
    initialDomain: `${id}.onmicrosoft.com`,
    source: "direct",
    status: "active",
    excluded: false,
    excludeReason: null,
    excludeDate: null,
    environment: "global",
    lastRunAt: null,
    errorCount: 0,
    lastError: null,
    ...extra,
  } as TenantRecord;
}

function runRecord(id: string, tenantId: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    tenantId,
    parentRunId: null,
    trigger: "manual",
    sections: [],
    options: null,
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:10:00Z",
    status: "succeeded",
    artifactPath: null,
    summaryCounts: null,
    provenance: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:10:00Z",
    ...overrides,
  };
}

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: "finding-1",
    runId: "run-1",
    tenantId: "t-a",
    checkId: "CA-1",
    controlName: "Require MFA",
    category: "Identity",
    collector: "ConditionalAccess",
    status: "Fail",
    severity: "High",
    currentValue: null,
    recommendedValue: null,
    evidence: null,
    frameworkRefs: [],
    remediationMode: "manual",
    createdAt: "2026-01-01T00:05:00Z",
    updatedAt: "2026-01-01T00:05:00Z",
    ...overrides,
  };
}

describe("check alerts provider (T-0858)", () => {
  it("reads non-passing findings from each included tenant's latest finished run", async () => {
    const provider = createCheckAlertsProvider({
      tenants: { listTenants: async () => [tenant("t-a"), tenant("t-b"), tenant("t-excluded", { status: "excluded", excluded: true })] },
      findings: {
        listRuns: async (tenantId) =>
          tenantId === "t-a"
            ? [runRecord("run-old", tenantId, { finishedAt: "2025-12-01T00:00:00Z" }), runRecord("run-new", tenantId)]
            : [],
        listFindings: async (_tenantId, runId) =>
          runId === "run-new"
            ? [
                finding({ id: "f-fail", status: "Fail", severity: "High" }),
                finding({ id: "f-pass", status: "Pass", severity: "High" }),
                finding({ id: "f-warn", status: "Warning", severity: "Low", checkId: "CA-2", controlName: null }),
              ]
            : [],
      },
    });

    const page = await provider.listCheckAlerts({ cursor: null, limit: 10 });

    expect(page.totalCount).toBe(2);
    expect(page.items.map((item) => item.id)).toEqual(["f-fail", "f-warn"]);
    expect(page.items[1]).toMatchObject({ checkId: "CA-2", title: "CA-2", status: "Warning", severity: "Low" });
  });

  it("filters by severity and status and paginates", async () => {
    const provider = createCheckAlertsProvider({
      tenants: { listTenants: async () => [tenant("t-a")] },
      findings: {
        listRuns: async (tenantId) => [runRecord("run-1", tenantId)],
        listFindings: async () => [
          finding({ id: "f-1", status: "Fail", severity: "Critical" }),
          finding({ id: "f-2", status: "Fail", severity: "Low" }),
          finding({ id: "f-3", status: "Warning", severity: "Critical" }),
        ],
      },
    });

    const page = await provider.listCheckAlerts({ severity: "Critical", cursor: null, limit: 1 });

    expect(page.totalCount).toBe(2);
    expect(page.items.map((item) => item.id)).toEqual(["f-1"]);
    expect(page.nextCursor).not.toBeNull();

    const next = await provider.listCheckAlerts({ severity: "Critical", cursor: page.nextCursor, limit: 1 });
    expect(next.items.map((item) => item.id)).toEqual(["f-3"]);
    expect(next.nextCursor).toBeNull();
  });
});
