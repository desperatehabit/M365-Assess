import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  openSqliteDashboardRepository,
  SqliteDashboardRepository,
  type DashboardPayload,
  type FleetPayload,
} from "./dashboard-repository.js";
import { DASHBOARD_SCHEMA_VERSION } from "../../contracts/src/dashboard.js";

const NOW = "2026-09-26T10:00:00.000Z";
const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-dashboard-repo-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function seedTenantsAndRuns(
  dbFile: string,
  data: {
    tenants?: readonly { id: string; displayName?: string; defaultDomain?: string }[];
    runs?: readonly {
      id: string;
      tenantId: string;
      status: string;
      finishedAt?: string;
      summaryCounts?: Record<string, unknown>;
    }[];
    findings?: readonly {
      id: string;
      runId: string;
      tenantId: string;
      checkId: string;
      status: string;
      severity?: string;
      category?: string;
    }[];
  }
): void {
  const raw = new Database(dbFile);
  try {
    const insertTenant = raw.prepare(
      `INSERT OR IGNORE INTO tenants (id, displayName, defaultDomain, source, status, excluded, errorCount, createdAt, updatedAt)
       VALUES (?, ?, ?, 'direct', 'active', 0, 0, ?, ?)`
    );
    for (const t of data.tenants || []) {
      insertTenant.run(t.id, t.displayName || t.id, t.defaultDomain || `${t.id}.onmicrosoft.com`, NOW, NOW);
    }

    const insertRun = raw.prepare(
      `INSERT OR IGNORE INTO runs (id, tenantId, trigger, status, finishedAt, summaryCounts, createdAt, updatedAt)
       VALUES (?, ?, 'manual', ?, ?, ?, ?, ?)`
    );
    for (const r of data.runs || []) {
      insertRun.run(
        r.id,
        r.tenantId,
        r.status,
        r.finishedAt || NOW,
        r.summaryCounts ? JSON.stringify(r.summaryCounts) : null,
        NOW,
        NOW
      );
    }

    const insertFinding = raw.prepare(
      `INSERT OR IGNORE INTO findings (id, runId, tenantId, checkId, status, severity, category, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const f of data.findings || []) {
      insertFinding.run(
        f.id,
        f.runId,
        f.tenantId,
        f.checkId,
        f.status,
        f.severity || "Medium",
        f.category || "Identity",
        NOW,
        NOW
      );
    }
  } finally {
    raw.close();
  }
}

describe("DashboardRepository", () => {
  it("returns explicit empty-state signal when a tenant has no completed run (not zeros)", async () => {
    const dbFile = tempDbPath();
    const repo = await openSqliteDashboardRepository({ filename: dbFile });

    seedTenantsAndRuns(dbFile, {
      tenants: [{ id: "tenant-empty", displayName: "Empty Tenant", defaultDomain: "empty.com" }],
      // A queued run is NOT a completed run
      runs: [{ id: "run-queued", tenantId: "tenant-empty", status: "queued" }],
    });

    const payload: DashboardPayload = await repo.getTenantDashboard("tenant-empty");

    expect(payload.schemaVersion).toBe(DASHBOARD_SCHEMA_VERSION);
    expect(payload.tenantId).toBe("tenant-empty");
    expect(payload.tenantInfo.displayName).toBe("Empty Tenant");

    // Acceptance criterion: A tenant with no completed run produces a payload that signals "empty" rather than zeros.
    expect(payload.isEmpty).toBe(true);
    expect(payload.emptyState).not.toBeNull();
    expect(payload.emptyState?.reason).toBe("no_completed_run");
    expect(payload.emptyState?.message).toContain("No completed assessment run");

    // Must be null, NOT zeros!
    expect(payload.score).toBeNull();
    expect(payload.assessment).toBeNull();
    expect(payload.metrics).toBeNull();
    expect(payload.alerts).toBeNull();
    expect(payload.authMethods).toBeNull();
    expect(payload.mfa).toBeNull();
    expect(payload.licenses).toBeNull();

    repo.close();
  });

  it("aggregates persisted runs and findings for a populated tenant", async () => {
    const dbFile = tempDbPath();
    const repo = await openSqliteDashboardRepository({ filename: dbFile });

    seedTenantsAndRuns(dbFile, {
      tenants: [{ id: "tenant-contoso", displayName: "Contoso Corp", defaultDomain: "contoso.com" }],
      runs: [
        {
          id: "run-contoso-001",
          tenantId: "tenant-contoso",
          status: "succeeded",
          finishedAt: "2026-09-26T10:15:00.000Z",
          summaryCounts: { pass: 18, fail: 2, warning: 1, review: 1, skipped: 0, notLicensed: 0, total: 22 },
        },
      ],
      findings: [
        { id: "f-1", runId: "run-contoso-001", tenantId: "tenant-contoso", checkId: "MFA-001", status: "Pass", severity: "High", category: "Identity" },
        { id: "f-2", runId: "run-contoso-001", tenantId: "tenant-contoso", checkId: "MFA-002", status: "Fail", severity: "Critical", category: "Identity" },
        { id: "f-3", runId: "run-contoso-001", tenantId: "tenant-contoso", checkId: "EXO-001", status: "Fail", severity: "High", category: "Email" },
        { id: "f-4", runId: "run-contoso-001", tenantId: "tenant-contoso", checkId: "INT-001", status: "Warning", severity: "Medium", category: "Intune" },
      ],
    });

    const payload: DashboardPayload = await repo.getTenantDashboard("tenant-contoso");

    expect(payload.isEmpty).toBe(false);
    expect(payload.emptyState).toBeNull();

    // Score: 18 pass / (18 + 2 + 1 evaluated) = 85.7% -> 86%
    expect(payload.score).not.toBeNull();
    expect(payload.score?.percentage).toBe(86);
    expect(payload.score?.max).toBe(100);

    // Assessment card
    expect(payload.assessment?.runId).toBe("run-contoso-001");
    expect(payload.assessment?.headlineScore).toBe(86);
    expect(payload.assessment?.summaryCounts.pass).toBe(18);
    expect(payload.assessment?.summaryCounts.fail).toBe(2);

    // Alerts: 1 critical, 1 high, 1 medium
    expect(payload.alerts).not.toBeNull();
    expect(payload.alerts?.critical).toBe(1);
    expect(payload.alerts?.high).toBe(1);
    expect(payload.alerts?.medium).toBe(1);
    expect(payload.alerts?.total).toBe(3);

    // Metrics grid has 6 metrics
    expect(payload.metrics?.metrics.length).toBe(6);

    repo.close();
  });

  it("filters fleet dashboard strictly by caller tenant scope (preventing scope leakage)", async () => {
    const dbFile = tempDbPath();
    const repo = await openSqliteDashboardRepository({ filename: dbFile });

    seedTenantsAndRuns(dbFile, {
      tenants: [
        { id: "tenant-alpha", displayName: "Alpha Corp" },
        { id: "tenant-beta", displayName: "Beta Ltd" },
        { id: "tenant-secret", displayName: "Secret Tenant" },
      ],
      runs: [
        {
          id: "run-alpha-1",
          tenantId: "tenant-alpha",
          status: "succeeded",
          summaryCounts: { pass: 10, fail: 0, warning: 0, total: 10 },
        },
        {
          id: "run-beta-1",
          tenantId: "tenant-beta",
          status: "succeeded",
          summaryCounts: { pass: 8, fail: 2, warning: 0, total: 10 },
        },
        {
          id: "run-secret-1",
          tenantId: "tenant-secret",
          status: "succeeded",
          summaryCounts: { pass: 20, fail: 0, warning: 0, total: 20 },
        },
      ],
    });

    // 1. Caller with scope only for Alpha and Beta
    const restrictedFleet: FleetPayload = await repo.getFleetDashboard({
      all: false,
      tenantIds: ["tenant-alpha", "tenant-beta"],
    });

    expect(restrictedFleet.total).toBe(2);
    expect(restrictedFleet.items.map((i) => i.tenantId)).toEqual(["tenant-alpha", "tenant-beta"]);
    // Secret tenant MUST NOT be present
    expect(restrictedFleet.items.some((i) => i.tenantId === "tenant-secret")).toBe(false);

    // 2. Caller with scope all: true
    const allFleet: FleetPayload = await repo.getFleetDashboard({ all: true });
    expect(allFleet.total).toBe(3);
    expect(allFleet.items.some((i) => i.tenantId === "tenant-secret")).toBe(true);

    // 3. Array scope shorthand
    const singleFleet: FleetPayload = await repo.getFleetDashboard(["tenant-beta"]);
    expect(singleFleet.total).toBe(1);
    expect(singleFleet.items[0]!.tenantId).toBe("tenant-beta");

    // 4. Per-tenant call with forbidden scope rejects
    await expect(
      repo.getTenantDashboard("tenant-secret", { all: false, tenantIds: ["tenant-alpha"] })
    ).rejects.toThrow(/outside caller scope/);

    repo.close();
  });

  it("handles fleet items with and without completed runs accurately", async () => {
    const dbFile = tempDbPath();
    const repo = await openSqliteDashboardRepository({ filename: dbFile });

    seedTenantsAndRuns(dbFile, {
      tenants: [
        { id: "tenant-active", displayName: "Active Tenant" },
        { id: "tenant-new", displayName: "New Tenant" },
      ],
      runs: [
        {
          id: "run-active-1",
          tenantId: "tenant-active",
          status: "succeeded",
          summaryCounts: { pass: 15, fail: 5, warning: 0, total: 20 },
        },
      ],
    });

    const fleet = await repo.getFleetDashboard();
    expect(fleet.items.length).toBe(2);

    const activeItem = fleet.items.find((i) => i.tenantId === "tenant-active")!;
    expect(activeItem.hasCompletedRun).toBe(true);
    expect(activeItem.score).toBe(75);
    expect(activeItem.findingCounts?.pass).toBe(15);
    expect(activeItem.findingCounts?.fail).toBe(5);

    const newItem = fleet.items.find((i) => i.tenantId === "tenant-new")!;
    expect(newItem.hasCompletedRun).toBe(false);
    expect(newItem.score).toBeNull();
    expect(newItem.complianceRate).toBeNull();
    expect(newItem.findingCounts).toBeNull();

    repo.close();
  });
});
