import type { JobEnvelope } from "@m365-assess/contracts";
import {
  SqliteAlertingRepository,
  SqliteRepository,
  loadMigrations,
  runMigrations,
  type AlertEventInsert,
  type AlertEventQuery,
} from "@m365-assess/db";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { seedAlertingDefaults } from "../adapters/alerting.js";
import {
  CREDENTIAL_EXPIRY_COMMAND,
  createCredentialExpiryCommand,
  createMaintenanceRunner,
} from "../scheduler/maintenance.js";
import {
  CREDENTIAL_EXPIRY_ALERT_RULE_ID,
  CREDENTIAL_EXPIRY_WARNING_DAYS,
  deriveCredentialExpiryDetail,
  deriveCredentialState,
  scanCredentialExpiry,
  type CredentialExpiryAlertEvent,
  type CredentialExpiryCredential,
  type CredentialExpiryTenant,
} from "./expiry.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");

function daysFromNow(days: number): string {
  return new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function makeFakeDeps(input: {
  tenants: readonly CredentialExpiryTenant[];
  credentials: Readonly<Record<string, CredentialExpiryCredential | undefined>>;
  events?: CredentialExpiryAlertEvent[];
  now?: Date | string | (() => Date | string);
  pageSize?: number;
}) {
  const events: CredentialExpiryAlertEvent[] = [...(input.events ?? [])];
  let seq = 0;

  return {
    events,
    deps: {
      tenants: {
        listTenants: async () => input.tenants,
      },
      credentials: {
        getTenantCredential: async (tenantId: string) => input.credentials[tenantId],
      },
      alerting: {
        listEvents: async (query: AlertEventQuery) => {
          const filtered = events.filter(
            (event) =>
              (query.tenantId === undefined || event.tenantId === query.tenantId) &&
              (query.ruleId === undefined || event.ruleId === query.ruleId) &&
              (query.state === undefined || event.state === query.state),
          );
          const offset = query.cursor ? Number(query.cursor) : 0;
          const limit = input.pageSize ?? query.limit;
          const items = filtered.slice(offset, offset + limit);
          const nextOffset = offset + items.length;
          return {
            items,
            nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
          };
        },
        createEvent: async (entry: AlertEventInsert) => {
          seq += 1;
          const created: CredentialExpiryAlertEvent = {
            id: entry.id ?? `evt-${seq}`,
            ruleId: entry.ruleId,
            tenantId: entry.tenantId,
            firedAt: entry.firedAt,
            severity: entry.severity,
            payload: entry.payload ?? null,
            state: entry.state ?? "open",
            snoozeUntil: entry.snoozeUntil ?? null,
            deletedAt: null,
          };
          events.push(created);
          return created;
        },
      },
      ...(input.now !== undefined ? { now: input.now } : { now: NOW }),
    },
  };
}

function maintenanceEnvelope(command = CREDENTIAL_EXPIRY_COMMAND): JobEnvelope {
  return {
    schemaVersion: "v1",
    jobId: "job-cred-1",
    jobType: "maintenance",
    tenantId: "all",
    runId: "run-cred-1",
    requestId: "req-cred-1",
    correlationId: "corr-cred-1",
    createdAt: NOW.toISOString(),
    payload: {
      contextRef: "schedules/system-credential-expiry/context.json",
      outputRef: "schedules/system-credential-expiry/run-cred-1",
      credentialRef: "schedules/system-credential-expiry/credential",
      sectionRefs: [],
      artifactRefs: [],
      command,
    },
  } as JobEnvelope;
}

describe("deriveCredentialState", () => {
  it("returns missing when there is no credential row", () => {
    expect(deriveCredentialState(null, NOW)).toBe("missing");
    expect(deriveCredentialState(undefined, NOW)).toBe("missing");
  });

  it("returns valid for a credential without an expiry", () => {
    expect(deriveCredentialState({ expiresOn: null }, NOW)).toBe("valid");
    expect(deriveCredentialState({ expiresOn: undefined }, NOW)).toBe("valid");
  });

  it("returns valid when expiry is beyond the warning window", () => {
    expect(deriveCredentialState({ expiresOn: daysFromNow(31) }, NOW)).toBe("valid");
    expect(deriveCredentialState({ expiresOn: daysFromNow(365) }, NOW)).toBe("valid");
  });

  it("returns expiring at or inside the 30-day window", () => {
    expect(CREDENTIAL_EXPIRY_WARNING_DAYS).toBe(30);
    expect(deriveCredentialState({ expiresOn: daysFromNow(30) }, NOW)).toBe("expiring");
    expect(deriveCredentialState({ expiresOn: daysFromNow(1) }, NOW)).toBe("expiring");
  });

  it("returns expired once the expiry has passed", () => {
    expect(deriveCredentialState({ expiresOn: daysFromNow(-1) }, NOW)).toBe("expired");
    expect(deriveCredentialState({ expiresOn: NOW.toISOString() }, NOW)).toBe("expired");
  });
});

describe("deriveCredentialExpiryDetail", () => {
  it("computes normalized expiresAt and daysRemaining across states", () => {
    expect(deriveCredentialExpiryDetail(null, NOW)).toEqual({
      state: "missing",
      expiresAt: null,
      daysRemaining: null,
    });
    expect(deriveCredentialExpiryDetail({ expiresOn: null }, NOW)).toEqual({
      state: "valid",
      expiresAt: null,
      daysRemaining: null,
    });
    expect(deriveCredentialExpiryDetail({ expiresOn: daysFromNow(14) }, NOW)).toEqual({
      state: "expiring",
      expiresAt: daysFromNow(14),
      daysRemaining: 14,
    });
    expect(deriveCredentialExpiryDetail({ expiresOn: daysFromNow(-3) }, NOW)).toEqual({
      state: "expired",
      expiresAt: daysFromNow(-3),
      daysRemaining: -3,
    });
  });
});

describe("scanCredentialExpiry (T-0874)", () => {
  it("raises a Medium alert for expiring credentials and skips valid/missing/excluded tenants", async () => {
    const { deps, events } = makeFakeDeps({
      tenants: [
        { id: "t-expiring", displayName: "Contoso", excluded: false, status: "active" },
        { id: "t-valid", displayName: "Fabrikam", excluded: false, status: "active" },
        { id: "t-no-expiry", displayName: "Northwind", excluded: false, status: "active" },
        { id: "t-missing", displayName: "Adventure", excluded: false, status: "active" },
        { id: "t-excluded", displayName: "Excluded Co", excluded: true, status: "excluded" },
        { id: "t-deleted", displayName: "Deleted Co", excluded: false, status: "active", deletedAt: "2026-05-01T00:00:00.000Z" },
      ],
      credentials: {
        "t-expiring": { expiresOn: daysFromNow(10), authMethod: "certificate-pfx" },
        "t-valid": { expiresOn: daysFromNow(60), authMethod: "certificate-pfx" },
        "t-no-expiry": { expiresOn: null, authMethod: "certificate-thumbprint" },
        "t-excluded": { expiresOn: daysFromNow(2), authMethod: "client-secret" },
        "t-deleted": { expiresOn: daysFromNow(2), authMethod: "client-secret" },
      },
    });

    const result = await scanCredentialExpiry(deps);

    expect(result).toEqual({
      scannedCount: 4,
      expiringCount: 1,
      expiredCount: 0,
      alertsRaised: 1,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ruleId: CREDENTIAL_EXPIRY_ALERT_RULE_ID,
      tenantId: "t-expiring",
      firedAt: NOW.toISOString(),
      severity: "Medium",
      state: "open",
      payload: {
        title: "Tenant credential expiring in 10 days for Contoso",
        detail: {
          state: "expiring",
          expiresAt: daysFromNow(10),
          daysRemaining: 10,
          authMethod: "certificate-pfx",
        },
      },
    });
  });

  it("raises a High alert for expired credentials", async () => {
    const { deps, events } = makeFakeDeps({
      tenants: [{ id: "t-expired", displayName: "Woodgrove", excluded: false, status: "active" }],
      credentials: {
        "t-expired": { expiresOn: daysFromNow(-5), authMethod: "client-secret" },
      },
    });

    const result = await scanCredentialExpiry(deps);

    expect(result).toEqual({
      scannedCount: 1,
      expiringCount: 0,
      expiredCount: 1,
      alertsRaised: 1,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ruleId: CREDENTIAL_EXPIRY_ALERT_RULE_ID,
      tenantId: "t-expired",
      severity: "High",
      state: "open",
      payload: {
        title: "Tenant credential expired for Woodgrove",
        detail: {
          state: "expired",
          expiresAt: daysFromNow(-5),
          daysRemaining: -5,
          authMethod: "client-secret",
        },
      },
    });
  });

  it("deduplicates repeated scans for open or snoozed alerts of the same state", async () => {
    const { deps, events } = makeFakeDeps({
      tenants: [{ id: "t-1", displayName: "Contoso", excluded: false, status: "active" }],
      credentials: {
        "t-1": { expiresOn: daysFromNow(5), authMethod: "certificate-pfx" },
      },
      pageSize: 1,
    });

    const first = await scanCredentialExpiry(deps);
    expect(first).toEqual({ scannedCount: 1, expiringCount: 1, expiredCount: 0, alertsRaised: 1 });
    expect(events).toHaveLength(1);

    // Second scan while open must not raise a duplicate.
    const second = await scanCredentialExpiry(deps);
    expect(second).toEqual({ scannedCount: 1, expiringCount: 1, expiredCount: 0, alertsRaised: 0 });
    expect(events).toHaveLength(1);

    // Snoozed alert with matching detail.state must also suppress duplicates.
    events[0] = { ...events[0]!, state: "snoozed", snoozeUntil: daysFromNow(3) };
    const whileSnoozed = await scanCredentialExpiry(deps);
    expect(whileSnoozed.alertsRaised).toBe(0);
    expect(events).toHaveLength(1);

    // Transitioning from expiring to expired raises a new High alert.
    const later = await scanCredentialExpiry({
      ...deps,
      now: new Date(NOW.getTime() + 6 * 24 * 60 * 60 * 1000),
    });
    expect(later).toEqual({ scannedCount: 1, expiringCount: 0, expiredCount: 1, alertsRaised: 1 });
    expect(events).toHaveLength(2);
    expect(events[1]?.severity).toBe("High");
    expect((events[1]?.payload?.["detail"] as Record<string, unknown>)["state"]).toBe("expired");
  });

  it("raises a fresh alert if the prior alert for the same state was resolved", async () => {
    const { deps, events } = makeFakeDeps({
      tenants: [{ id: "t-1", displayName: "Contoso", excluded: false }],
      credentials: {
        "t-1": { expiresOn: daysFromNow(7), authMethod: "certificate-pfx" },
      },
      events: [
        {
          id: "evt-resolved",
          ruleId: CREDENTIAL_EXPIRY_ALERT_RULE_ID,
          tenantId: "t-1",
          firedAt: "2026-05-20T00:00:00.000Z",
          severity: "Medium",
          payload: { title: "old", detail: { state: "expiring" } },
          state: "resolved",
          snoozeUntil: null,
        },
      ],
    });

    const result = await scanCredentialExpiry(deps);
    expect(result.alertsRaised).toBe(1);
    expect(events).toHaveLength(2);
  });

  it("persists and deduplicates events against SqliteRepository and SqliteAlertingRepository", async () => {
    const db = new Database(":memory:");
    try {
      const version = runMigrations(db, loadMigrations());
      const repo = new SqliteRepository(db, version, "memory");
      const alerting = new SqliteAlertingRepository(db, version);
      await seedAlertingDefaults(alerting);

      await repo.upsertTenant({
        id: "t-sqlite-exp",
        displayName: "SQLite Expiring",
        defaultDomain: "exp.example",
        initialDomain: "exp.onmicrosoft.com",
        source: "direct",
        status: "active",
        excluded: false,
        lastRunAt: null,
        errorCount: 0,
      });
      await repo.upsertTenantCredential({
        id: "cred-sqlite-1",
        tenantId: "t-sqlite-exp",
        authMethod: "certificate-pfx",
        clientId: "client-1",
        secretRef: "tenants/t-sqlite-exp/credential",
        thumbprint: null,
        environment: "commercial",
        expiresOn: daysFromNow(12),
        lastValidated: null,
      });

      const first = await scanCredentialExpiry({
        tenants: repo,
        credentials: repo,
        alerting,
        now: NOW,
      });
      expect(first).toEqual({ scannedCount: 1, expiringCount: 1, expiredCount: 0, alertsRaised: 1 });

      const second = await scanCredentialExpiry({
        tenants: repo,
        credentials: repo,
        alerting,
        now: NOW,
      });
      expect(second).toEqual({ scannedCount: 1, expiringCount: 1, expiredCount: 0, alertsRaised: 0 });

      const stored = await alerting.listEvents({
        tenantId: "t-sqlite-exp",
        ruleId: CREDENTIAL_EXPIRY_ALERT_RULE_ID,
        cursor: null,
        limit: 10,
      });
      expect(stored.totalCount).toBe(1);
      expect(stored.items[0]).toMatchObject({
        ruleId: CREDENTIAL_EXPIRY_ALERT_RULE_ID,
        tenantId: "t-sqlite-exp",
        severity: "Medium",
        state: "open",
        source: "credentials",
        payload: {
          title: "Tenant credential expiring in 12 days for SQLite Expiring",
          detail: {
            state: "expiring",
            expiresAt: daysFromNow(12),
            daysRemaining: 12,
            authMethod: "certificate-pfx",
          },
        },
      });
    } finally {
      db.close();
    }
  });
});

describe("credential expiry maintenance command (T-0874)", () => {
  it("runs scanCredentialExpiry through createMaintenanceRunner", async () => {
    expect(CREDENTIAL_EXPIRY_COMMAND).toBe("Invoke-CredentialExpiryScan");
    const { deps, events } = makeFakeDeps({
      tenants: [
        { id: "t-1", displayName: "One", excluded: false },
        { id: "t-2", displayName: "Two", excluded: false },
        { id: "t-3", displayName: "Three", excluded: false },
      ],
      credentials: {
        "t-1": { expiresOn: daysFromNow(5), authMethod: "certificate-pfx" },
        "t-2": { expiresOn: daysFromNow(-2), authMethod: "client-secret" },
        "t-3": { expiresOn: daysFromNow(90), authMethod: "certificate-pfx" },
      },
      now: () => NOW,
    });

    const runner = createMaintenanceRunner({
      handlers: {
        [CREDENTIAL_EXPIRY_COMMAND]: createCredentialExpiryCommand(deps),
      },
    });
    const result = await runner(maintenanceEnvelope(), new AbortController().signal);

    expect(result).toMatchObject({
      jobType: "maintenance",
      status: "succeeded",
      exitCode: 0,
      artifactRefs: ["schedules/system-credential-expiry/run-cred-1"],
    });
    expect(events).toHaveLength(2);
    expect(events.map((event) => [event.tenantId, event.severity])).toEqual([
      ["t-1", "Medium"],
      ["t-2", "High"],
    ]);
  });

  it("reports failure when cancelled or when a store throws", async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps } = makeFakeDeps({ tenants: [], credentials: {} });
    const command = createCredentialExpiryCommand(deps);

    const aborted = await command(maintenanceEnvelope(), controller.signal);
    expect(aborted.status).toBe("failed");
    expect(aborted.exitCode).toBe(1);

    const failing = createCredentialExpiryCommand({
      ...deps,
      tenants: {
        listTenants: async () => {
          throw new Error("database unavailable");
        },
      },
    });
    const failed = await failing(maintenanceEnvelope(), new AbortController().signal);
    expect(failed).toEqual({
      status: "failed",
      exitCode: 1,
      message: "database unavailable",
    });
  });
});
