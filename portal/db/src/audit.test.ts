import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  openSqliteAuditRepository,
  type AuditCoverageInput,
  type AuditExclusionWindowInput,
  type AuditSearchInput,
  type WebhookSubscriptionInput,
} from "./audit-repository.js";
import { openSqliteRepository } from "./sqlite-repository.js";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-audit-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function columns(filename: string, table: string): string[] {
  const raw = new Database(filename);
  try {
    return (
      raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).map((row) => row.name);
  } finally {
    raw.close();
  }
}

async function seedTenant(filename: string, tenantId: string): Promise<void> {
  const repo = await openSqliteRepository({ filename });
  await repo.upsertTenant({
    id: tenantId,
    displayName: null,
    defaultDomain: null,
    initialDomain: null,
    source: "direct",
    status: "active",
    excluded: false,
    lastRunAt: null,
    errorCount: 0,
  });
  repo.close();
}

function searchInput(extra: Partial<AuditSearchInput> = {}): AuditSearchInput {
  return {
    id: "search-1",
    tenantId: TENANT_A,
    name: "Sign-ins for the last day",
    filters: { workload: "signIns", range: "24h" },
    saved: true,
    scheduleId: null,
    lastRunAt: null,
    createdBy: "analyst-1",
    ...extra,
  };
}

function coverageInput(extra: Partial<AuditCoverageInput> = {}): AuditCoverageInput {
  return {
    tenantId: TENANT_A,
    auditEnabled: true,
    lastSearchAt: null,
    gaps: [],
    ...extra,
  };
}

function subscriptionInput(extra: Partial<WebhookSubscriptionInput> = {}): WebhookSubscriptionInput {
  return {
    id: "sub-1",
    tenantId: TENANT_A,
    resource: "users",
    expiresOn: "2026-10-01T00:00:00.000Z",
    state: "active",
    notificationUrl: "https://example.invalid/webhooks/users",
    ...extra,
  };
}

function windowInput(extra: Partial<AuditExclusionWindowInput> = {}): AuditExclusionWindowInput {
  return {
    id: "window-1",
    tenantId: TENANT_A,
    startsAt: "2026-07-01T00:00:00.000Z",
    endsAt: "2026-07-07T00:00:00.000Z",
    reason: "vacation",
    ...extra,
  };
}

describe("audit migration", () => {
  it("creates the SPEC §5 columns for searches, coverage, subscriptions, and windows", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteAuditRepository({ filename });
    expect(repo.schemaVersion).toBeGreaterThanOrEqual(40);
    repo.close();

    expect(columns(filename, "audit_searches")).toEqual(
      expect.arrayContaining([
        "id",
        "tenantId",
        "name",
        "filters",
        "saved",
        "scheduleId",
        "lastRunAt",
        "createdBy",
        "deletedAt",
      ]),
    );
    expect(columns(filename, "audit_coverage")).toEqual(
      expect.arrayContaining(["tenantId", "auditEnabled", "lastSearchAt", "gaps"]),
    );
    expect(columns(filename, "webhook_subscriptions")).toEqual(
      expect.arrayContaining([
        "id",
        "tenantId",
        "resource",
        "expiresOn",
        "state",
        "notificationUrl",
      ]),
    );
    expect(columns(filename, "audit_exclusion_windows")).toEqual(
      expect.arrayContaining(["id", "tenantId", "startsAt", "endsAt", "reason", "deletedAt"]),
    );
  });
});

describe("audit repository", () => {
  it("round-trips a saved search and hides it after soft delete", async () => {
    const filename = tempDbPath();
    await seedTenant(filename, TENANT_A);

    const repo = await openSqliteAuditRepository({ filename });
    const created = await repo.createAuditSearch(searchInput());
    expect(created.filters).toEqual({ workload: "signIns", range: "24h" });
    expect(created.saved).toBe(true);

    expect(await repo.getAuditSearch(TENANT_A, "search-1")).toEqual(created);
    expect(await repo.listAuditSearches(TENANT_A)).toHaveLength(1);

    const updated = await repo.updateAuditSearch(TENANT_A, "search-1", {
      name: "Renamed search",
      lastRunAt: "2026-09-25T00:00:00.000Z",
    });
    expect(updated?.name).toBe("Renamed search");
    expect(updated?.lastRunAt).toBe("2026-09-25T00:00:00.000Z");

    expect(await repo.softDeleteAuditSearch(TENANT_A, "search-1")).toBe(true);
    expect(await repo.getAuditSearch(TENANT_A, "search-1")).toBeUndefined();
    expect(await repo.listAuditSearches(TENANT_A)).toHaveLength(0);
    expect(await repo.getAuditSearch(TENANT_A, "search-1", { includeDeleted: true })).toBeTruthy();

    repo.close();
  });

  it("upserts a coverage row and round-trips it", async () => {
    const filename = tempDbPath();
    await seedTenant(filename, TENANT_A);

    const repo = await openSqliteAuditRepository({ filename });
    const created = await repo.upsertAuditCoverage(
      coverageInput({ auditEnabled: false, gaps: ["COMPLIANCE-AUDIT-001"] }),
    );
    expect(created.auditEnabled).toBe(false);
    expect(created.gaps).toEqual(["COMPLIANCE-AUDIT-001"]);

    const updated = await repo.upsertAuditCoverage(
      coverageInput({ auditEnabled: true, lastSearchAt: "2026-09-25T00:00:00.000Z", gaps: [] }),
    );
    expect(updated.auditEnabled).toBe(true);
    expect(updated.gaps).toEqual([]);

    expect((await repo.getAuditCoverage(TENANT_A))?.tenantId).toBe(TENANT_A);
    repo.close();
  });

  it("round-trips a subscription and returns only rows expiring inside a window", async () => {
    const filename = tempDbPath();
    await seedTenant(filename, TENANT_A);

    const repo = await openSqliteAuditRepository({ filename });
    const inside = await repo.createWebhookSubscription(subscriptionInput());
    await repo.createWebhookSubscription(
      subscriptionInput({ id: "sub-outside", expiresOn: "2027-01-01T00:00:00.000Z" }),
    );
    await repo.createWebhookSubscription(subscriptionInput({ id: "sub-null", expiresOn: null }));

    expect(await repo.getWebhookSubscription(TENANT_A, "sub-1")).toEqual(inside);
    expect(await repo.listWebhookSubscriptions(TENANT_A)).toHaveLength(3);

    const expiring = await repo.listWebhookSubscriptionsExpiringBetween(
      TENANT_A,
      "2026-09-01T00:00:00.000Z",
      "2026-11-01T00:00:00.000Z",
    );
    expect(expiring.map((sub) => sub.id)).toEqual(["sub-1"]);
    repo.close();
  });

  it("round-trips an exclusion window and hides it after soft delete", async () => {
    const filename = tempDbPath();
    await seedTenant(filename, TENANT_A);

    const repo = await openSqliteAuditRepository({ filename });
    const created = await repo.createAuditExclusionWindow(windowInput());
    expect(created.reason).toBe("vacation");

    expect(await repo.getAuditExclusionWindow(TENANT_A, "window-1")).toEqual(created);
    expect(await repo.listAuditExclusionWindows(TENANT_A)).toHaveLength(1);

    const updated = await repo.updateAuditExclusionWindow(TENANT_A, "window-1", {
      endsAt: "2026-07-10T00:00:00.000Z",
    });
    expect(updated?.endsAt).toBe("2026-07-10T00:00:00.000Z");

    expect(await repo.softDeleteAuditExclusionWindow(TENANT_A, "window-1")).toBe(true);
    expect(await repo.getAuditExclusionWindow(TENANT_A, "window-1")).toBeUndefined();
    expect(await repo.listAuditExclusionWindows(TENANT_A)).toHaveLength(0);

    repo.close();
  });

  it("enforces tenant scoping so a cross-tenant read returns nothing", async () => {
    const filename = tempDbPath();
    await seedTenant(filename, TENANT_A);
    await seedTenant(filename, TENANT_B);

    const repo = await openSqliteAuditRepository({ filename });
    await repo.createAuditSearch(searchInput());
    await repo.upsertAuditCoverage(coverageInput());
    await repo.createWebhookSubscription(subscriptionInput());
    await repo.createAuditExclusionWindow(windowInput());

    expect(await repo.getAuditSearch(TENANT_B, "search-1")).toBeUndefined();
    expect(await repo.listAuditSearches(TENANT_B)).toHaveLength(0);
    expect(await repo.getAuditCoverage(TENANT_B)).toBeUndefined();
    expect(await repo.getWebhookSubscription(TENANT_B, "sub-1")).toBeUndefined();
    expect(await repo.listWebhookSubscriptions(TENANT_B)).toHaveLength(0);
    expect(
      await repo.listWebhookSubscriptionsExpiringBetween(
        TENANT_B,
        "2026-09-01T00:00:00.000Z",
        "2026-11-01T00:00:00.000Z",
      ),
    ).toHaveLength(0);
    expect(await repo.getAuditExclusionWindow(TENANT_B, "window-1")).toBeUndefined();
    expect(await repo.listAuditExclusionWindows(TENANT_B)).toHaveLength(0);

    repo.close();
  });
});
