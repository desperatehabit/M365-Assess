import { SqliteRepository, loadMigrations, runMigrations } from "@m365-assess/db";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../pagination.js";
import type { CredentialRecord, CredentialStoreRow } from "../routes/credentials.js";
import type { VacationSchedule } from "../routes/vacation-schedules.js";
import { FeatureWorkerError } from "../jobs/feature-worker.js";
import {
  MAILFLOW_REPORT_UNAVAILABLE,
  RETENTION_TAG_READ_UNAVAILABLE,
  RETENTION_TAG_WRITE_UNAVAILABLE,
  createMailboxProviders,
  createSqliteVacationScheduleStore,
} from "./mailboxes.js";
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

type Job = Record<string, unknown>;

async function memoryDb(): Promise<Database.Database> {
  const db = new Database(":memory:");
  const version = runMigrations(db, loadMigrations());
  const tenants = new SqliteRepository(db, version, "memory");
  await tenants.upsertTenant({
    id: "t-a",
    displayName: null,
    defaultDomain: null,
    initialDomain: null,
    source: "direct",
    status: "active",
    excluded: false,
    lastRunAt: null,
    errorCount: 0,
  });
  return db;
}

async function harness(respond: (entrypoint: string, job: Job) => unknown | Promise<unknown>) {
  const calls: { entrypoint: string; job: Job }[] = [];
  const run: WorkerRunner = async (entrypoint, job) => {
    calls.push({ entrypoint, job: job as Job });
    return (await respond(entrypoint, job as Job)) as never;
  };
  const db = await memoryDb();
  return { providers: createMailboxProviders(run, credentials, db), calls, db };
}

function permissionRow(mailboxId: string, scope: "mailbox" | "calendar", principal: string, smtp = `${mailboxId}@example.invalid`) {
  return {
    mailboxId,
    mailboxDisplayName: mailboxId,
    mailboxPrimarySmtp: smtp,
    scope,
    permissionType: scope === "calendar" ? "Calendar" : "FullAccess",
    principal,
    accessRights: scope === "calendar" ? ["Reviewer"] : ["FullAccess"],
    automap: true,
    inherited: false,
  };
}

const RETRIEVED = "2026-10-01T00:00:00.000Z";

describe("mailbox permissions (T-0850)", () => {
  it("sends the mailbox id to the worker and returns only that mailbox's rows", async () => {
    const { providers, calls } = await harness(() => ({
      tenantId: "t-a",
      // A worker that ignored the mailbox filter would return every mailbox; none may leak.
      items: [
        permissionRow("mbx-1", "mailbox", "alice@example.invalid"),
        permissionRow("mbx-2", "mailbox", "bob@example.invalid"),
        permissionRow("mbx-1", "calendar", "Default"),
        permissionRow("mbx-3", "calendar", "carol@example.invalid"),
      ],
      nextCursor: "",
      totalCount: 4,
      retrievedAt: RETRIEVED,
    }));

    const result = await providers.mailboxPermissions.listPermissions("t-a", "mbx-1");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.entrypoint).toBe("get-mailbox-permissions.ps1");
    expect(calls[0]!.job).toMatchObject({ tenantId: "t-a", mailboxId: "mbx-1", scope: "" });
    expect(result.permissions.map((p) => p.principal)).toEqual(["alice@example.invalid"]);
    expect(result.calendarPermissions.map((p) => p.principal)).toEqual(["Default"]);
    expect(result.retrievedAt).toBe(RETRIEVED);
  });

  it("matches the mailbox by primary SMTP address case-insensitively", async () => {
    const { providers } = await harness(() => ({
      tenantId: "t-a",
      items: [
        permissionRow("mbx-1", "mailbox", "alice@example.invalid", "Shared@Example.invalid"),
        permissionRow("mbx-2", "mailbox", "bob@example.invalid"),
      ],
      nextCursor: "",
      totalCount: 2,
      retrievedAt: RETRIEVED,
    }));

    const result = await providers.mailboxPermissions.listPermissions("t-a", "shared@example.invalid");

    expect(result.permissions.map((p) => p.principal)).toEqual(["alice@example.invalid"]);
  });

  it("pages until the worker is exhausted instead of stopping at one page", async () => {
    const { providers, calls } = await harness((_entrypoint, job) =>
      job["cursor"] === ""
        ? {
            tenantId: "t-a",
            items: [permissionRow("mbx-1", "mailbox", "first@example.invalid")],
            nextCursor: "page-2",
            totalCount: 2,
            retrievedAt: RETRIEVED,
          }
        : {
            tenantId: "t-a",
            items: [permissionRow("mbx-1", "mailbox", "second@example.invalid")],
            nextCursor: "",
            totalCount: 2,
            retrievedAt: RETRIEVED,
          },
    );

    const result = await providers.mailboxPermissions.listPermissions("t-a", "mbx-1");

    expect(calls.map((c) => c.job["cursor"])).toEqual(["", "page-2"]);
    expect(result.permissions.map((p) => p.principal)).toEqual(["first@example.invalid", "second@example.invalid"]);
  });

  it("maps a worker not-found failure to 404", async () => {
    const { providers } = await harness(() => {
      throw new FeatureWorkerError("worker.failed", "worker failed", 1, "NotFound: Mailbox 'x' not found");
    });

    await expect(providers.mailboxPermissions.listPermissions("t-a", "x")).rejects.toMatchObject({
      status: 404,
      code: "mailboxes.not_found",
    });
  });

  it("lets other worker failures surface as 502", async () => {
    const { providers } = await harness(() => {
      throw new FeatureWorkerError("worker.failed", "worker failed", 1, "EXO unreachable");
    });

    await expect(providers.mailboxPermissions.listPermissions("t-a", "mbx-1")).rejects.toMatchObject({ status: 502 });
  });

  it("serves the tenant-wide report from one worker read with scope, search, and cursor", async () => {
    const { providers, calls } = await harness(() => ({
      tenantId: "t-a",
      items: [permissionRow("mbx-1", "calendar", "Default")],
      nextCursor: "",
      totalCount: 1,
      retrievedAt: RETRIEVED,
    }));

    const page = await providers.mailboxPermissionsReport.listMailboxPermissions("t-a", {
      scope: "calendar",
      search: "def",
      cursor: encodeCursor(5),
      limit: 1000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.job).toMatchObject({ scope: "calendar", search: "def", cursor: encodeCursor(5), top: 999 });
    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(1);
  });
});

describe("mailbox reports (T-0850)", () => {
  const mailboxRows = Array.from({ length: 6 }, (_, i) => ({
    id: `mbx-${i}`,
    displayName: `Mailbox ${i}`,
    primarySmtpAddress: `m${i}@example.invalid`,
    type: "user",
    quotaUsed: "1 GB",
    quotaPercent: 10,
    archive: false,
    hold: false,
    forwarding: false,
    forwardingTo: null,
    deliverToMailboxAndForward: false,
    lastActivity: null,
  }));

  /** A worker that pages exactly like get-mailboxes.ps1: row-offset cursor, empty string at the end. */
  function pagingWorker(job: Job) {
    const payload = job["payload"] as Job;
    const start = decodeCursor((payload["cursor"] as string) || null);
    const top = payload["top"] as number;
    const items = mailboxRows.slice(start, start + top);
    const next = start + items.length;
    return {
      tenantId: "t-a",
      items,
      nextCursor: next < mailboxRows.length ? encodeCursor(next) : "",
      totalCount: mailboxRows.length,
      retrievedAt: RETRIEVED,
    };
  }

  it("applies the cursor exactly once for statistics, activity, and forwarding", async () => {
    for (const report of ["statistics", "activity", "forwarding"] as const) {
      const { providers, calls } = await harness((_entrypoint, job) => pagingWorker(job));

      const first = await providers.mailboxReports.getMailboxReport("t-a", { report, cursor: null, limit: 2 });
      expect(first.rows.map((r) => r["id"])).toEqual(["mbx-0", "mbx-1"]);
      expect(first.nextCursor).toBe(encodeCursor(2));

      const second = await providers.mailboxReports.getMailboxReport("t-a", { report, cursor: first.nextCursor, limit: 2 });
      // Page 2 starts at row 2; applying the cursor twice would start at row 4.
      expect(second.rows.map((r) => r["id"])).toEqual(["mbx-2", "mbx-3"]);
      expect(second.nextCursor).toBe(encodeCursor(4));

      const last = await providers.mailboxReports.getMailboxReport("t-a", { report, cursor: second.nextCursor, limit: 2 });
      expect(last.rows.map((r) => r["id"])).toEqual(["mbx-4", "mbx-5"]);
      expect(last.nextCursor).toBeNull();
      expect(calls).toHaveLength(3);
      expect((calls[1]!.job["payload"] as Job)["cursor"]).toBe(encodeCursor(2));
    }
  });

  it("never asks the worker for more than its 999-row page", async () => {
    const { providers, calls } = await harness((_entrypoint, job) => pagingWorker(job));

    await providers.mailboxReports.getMailboxReport("t-a", { report: "statistics", cursor: null, limit: 1000 });

    expect((calls[0]!.job["payload"] as Job)["top"]).toBe(999);
  });

  it("projects only the columns each report promises", async () => {
    const { providers } = await harness((_entrypoint, job) => pagingWorker(job));

    const activity = await providers.mailboxReports.getMailboxReport("t-a", { report: "activity", cursor: null, limit: 1 });
    expect(Object.keys(activity.rows[0]!).sort()).toEqual(["displayName", "id", "lastActivity", "primarySmtpAddress"]);
  });

  it("forwards mailboxId, scope, and cursor to the permissions reports", async () => {
    const { providers, calls } = await harness(() => ({
      tenantId: "t-a",
      items: [permissionRow("mbx-1", "mailbox", "alice@example.invalid")],
      nextCursor: "next",
      totalCount: 9,
      retrievedAt: RETRIEVED,
    }));

    const page = await providers.mailboxReports.getMailboxReport("t-a", {
      report: "permissions",
      mailboxId: "mbx-1",
      cursor: "abc",
      limit: 25,
    });

    expect(calls[0]!.job).toMatchObject({ scope: "mailbox", mailboxId: "mbx-1", cursor: "abc", top: 25 });
    expect(page.nextCursor).toBe("next");
  });

  it("refuses the mail-flow report with 501 instead of an empty success", async () => {
    const { providers, calls } = await harness(() => ({}));

    await expect(
      providers.mailboxReports.getMailboxReport("t-a", { report: "mailflow", cursor: null, limit: 10 }),
    ).rejects.toMatchObject({ status: 501, code: MAILFLOW_REPORT_UNAVAILABLE });
    expect(calls).toHaveLength(0);
  });

  it("propagates worker error payloads with their status", async () => {
    const { providers } = await harness(() => ({ error: "mailbox.throttled", message: "slow down", statusCode: 429 }));

    await expect(
      providers.mailboxReports.getMailboxReport("t-a", { report: "statistics", cursor: null, limit: 10 }),
    ).rejects.toMatchObject({ status: 429, code: "mailbox.throttled" });
  });
});

describe("mailbox detail and rules (T-0850)", () => {
  it("lists rules from the mailbox detail", async () => {
    const { providers } = await harness(() => ({
      tenantId: "t-a",
      mailboxId: "mbx-1",
      settings: { id: "mbx-1" },
      permissions: [],
      calendarPermissions: [],
      rules: [{ identity: "r1", name: "Forward", enabled: true, priority: 1, forwardTo: null, forwardAsAttachmentTo: null, redirectTo: null, deleteMessage: false }],
      retrievedAt: RETRIEVED,
    }));

    const list = await providers.mailboxRules.listRules("t-a", "mbx-1");

    expect(list.rules.map((r) => r.name)).toEqual(["Forward"]);
    expect(list.retrievedAt).toBe(RETRIEVED);
  });

  it("returns 404 for rules of an unknown mailbox, not an empty list", async () => {
    const { providers } = await harness(() => {
      throw new FeatureWorkerError("worker.failed", "worker failed", 1, "The operation couldn't be performed because object 'x' couldn't be found");
    });

    await expect(providers.mailboxRules.listRules("t-a", "x")).rejects.toMatchObject({ status: 404 });
    await expect(providers.mailboxes.getMailbox("t-a", "x")).resolves.toBeNull();
  });

  it("treats a worker result without settings as not found", async () => {
    const { providers } = await harness(() => ({ tenantId: "t-a" }));

    await expect(providers.mailboxRules.listRules("t-a", "x")).rejects.toMatchObject({ status: 404 });
  });

  it("propagates other worker failures instead of hiding them behind an empty list", async () => {
    const { providers } = await harness(() => {
      throw new FeatureWorkerError("worker.failed", "worker failed", 1, "EXO unreachable");
    });

    await expect(providers.mailboxRules.listRules("t-a", "mbx-1")).rejects.toMatchObject({ status: 502 });
  });

  it("propagates worker error payloads from the detail read", async () => {
    const { providers } = await harness(() => ({ error: "mailbox.forbidden", message: "no access", statusCode: 403 }));

    await expect(providers.mailboxRules.listRules("t-a", "mbx-1")).rejects.toMatchObject({ status: 403 });
  });

  it("normalizes the worker's empty last-page cursor to null on list reads", async () => {
    const { providers } = await harness(() => ({ tenantId: "t-a", items: [], nextCursor: "", totalCount: 0, retrievedAt: RETRIEVED }));

    const page = await providers.mailboxes.listMailboxes("t-a", { cursor: null, limit: 100 });

    expect(page.nextCursor).toBeNull();
  });
});

describe("retention (T-0850)", () => {
  it("refuses tag reads and writes with 501 because no worker backs them", async () => {
    const { providers, calls } = await harness(() => ({}));

    expect(() => providers.retention.listTags("t-a")).toThrow(
      expect.objectContaining({ status: 501, code: RETENTION_TAG_READ_UNAVAILABLE }),
    );
    expect(() => providers.retention.createTag("t-a", { name: "x" }, true)).toThrow(
      expect.objectContaining({ status: 501, code: RETENTION_TAG_WRITE_UNAVAILABLE }),
    );
    expect(() => providers.retention.editTag("t-a", "tag-1", { name: "x" }, true)).toThrow(
      expect.objectContaining({ status: 501, code: RETENTION_TAG_WRITE_UNAVAILABLE }),
    );
    expect(calls).toHaveLength(0);
  });

  it("lists policies through the worker payload and follows its cursor", async () => {
    const { providers, calls } = await harness((_entrypoint, job) => {
      const payload = job["payload"] as Job;
      return payload["cursor"] === ""
        ? { tenantId: "t-a", items: [{ id: "p1", name: "Policy 1", state: "enabled" }], nextCursor: "c2", totalCount: 2, retrievedAt: RETRIEVED }
        : { tenantId: "t-a", items: [{ id: "p2", name: "Policy 2", state: "disabled" }], nextCursor: "", totalCount: 2, retrievedAt: RETRIEVED };
    });

    const policies = await providers.retention.listPolicies("t-a");

    expect(policies.map((p) => [p.id, p.enabled])).toEqual([["p1", true], ["p2", false]]);
    expect(calls[0]!.job).toMatchObject({ schemaVersion: "v1", payload: { top: 999, cursor: "" } });
  });
});

describe("deleted mailboxes (T-0850)", () => {
  it("lists soft-deleted mailboxes through the restore worker with a normalized cursor", async () => {
    const { providers, calls } = await harness(() => ({
      tenantId: "t-a",
      items: [{ id: "d1", displayName: "Gone", primarySmtpAddress: "gone@example.invalid", mailboxType: "UserMailbox", deletedAt: null, daysUntilPurge: 12 }],
      nextCursor: "",
      totalCount: 1,
      retrievedAt: RETRIEVED,
    }));

    const page = await providers.deletedMailboxes.listDeletedMailboxes("t-a", { search: "gone", cursor: null, limit: 1000 });

    expect(calls[0]!.entrypoint).toBe("restore-mailbox.ps1");
    expect(calls[0]!.job).toMatchObject({ action: "list", search: "gone", top: 999 });
    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(1);
  });

  it("restores through a confirmed apply and a dry-run preview", async () => {
    const { providers, calls } = await harness(() => ({ success: true }));

    await providers.deletedMailboxes.restoreMailbox("t-a", "d1", { preview: true, confirm: true }, true);
    await providers.deletedMailboxes.restoreMailbox("t-a", "d1", { preview: false, confirm: true }, false);

    expect(calls[0]!.job).toMatchObject({ action: "restore", mailboxId: "d1", dryRun: true, confirmed: false });
    expect(calls[1]!.job).toMatchObject({ action: "restore", mailboxId: "d1", dryRun: false, confirmed: true });
  });

  it("maps the worker's not-soft-deleted refusal to the route's 404", async () => {
    const { providers } = await harness(() => {
      throw new FeatureWorkerError("worker.failed", "worker failed", 1, "NotFound: Mailbox 'm' is not in the soft-deleted set");
    });

    await expect(
      providers.deletedMailboxes.restoreMailbox("t-a", "m", { preview: false, confirm: true }, false),
    ).rejects.toMatchObject({ status: 404, code: "deleted-mailboxes.not_soft_deleted" });
  });
});

describe("vacation apply (T-0850)", () => {
  const SCHEDULE: VacationSchedule = {
    id: "vac-1",
    tenantId: "t-a",
    mailboxId: "mbx-1",
    startsAt: "2026-10-01T00:00:00.000Z",
    endsAt: "2026-10-08T00:00:00.000Z",
    oooMessage: "Out.",
    forwardTo: "cover@example.invalid",
    state: "scheduled",
    createdAt: "",
    updatedAt: "",
  };

  it("sends a confirmed enable job bounded by the window end", async () => {
    const { providers, calls } = await harness(() => ({ success: true, scheduleState: "active" }));

    await providers.vacationApply.applyVacationPhase("t-a", SCHEDULE, "enable");

    expect(calls[0]!.entrypoint).toBe("invoke-vacation-schedule.ps1");
    expect(calls[0]!.job).toMatchObject({
      scheduleId: "vac-1",
      phase: "enable",
      mailboxId: "mbx-1",
      forwardTo: "cover@example.invalid",
      notAfter: SCHEDULE.endsAt,
      confirmed: true,
    });
  });

  it("surfaces the worker's alertEvent as the route's alert on a failed revert", async () => {
    const alertEvent = { kind: "vacation.revert", severity: "High", tenantId: "t-a", scheduleId: "vac-1", mailboxId: "mbx-1", reason: "boom", timestamp: RETRIEVED };
    const { providers } = await harness(() => ({ success: false, scheduleState: "failed", alertEvent, alerted: true }));

    const outcome = await providers.vacationApply.applyVacationPhase("t-a", { ...SCHEDULE, state: "active" }, "revert");

    expect(outcome.success).toBe(false);
    expect(outcome.alert).toEqual(alertEvent);
  });
});

describe("vacation schedule store SQL (T-0850)", () => {
  const INPUT = {
    id: "vac-1",
    tenantId: "t-a",
    mailboxId: "mbx-1",
    startsAt: "2026-10-01T00:00:00.000Z",
    endsAt: "2026-10-08T00:00:00.000Z",
    oooMessage: "Out.",
    forwardTo: null,
    state: "scheduled" as const,
  };

  it("creates, reads, lists, and updates rows scoped to the tenant", async () => {
    const db = await memoryDb();
    const store = createSqliteVacationScheduleStore(db);

    const created = await store.createVacationSchedule(INPUT);
    expect(created).toMatchObject({ id: "vac-1", state: "scheduled", forwardTo: null });
    await store.createVacationSchedule({ ...INPUT, id: "vac-0", startsAt: "2026-09-01T00:00:00.000Z", forwardTo: "cover@example.invalid" });

    expect((await store.listVacationSchedules("t-a")).map((s) => s.id)).toEqual(["vac-0", "vac-1"]);
    expect(await store.listVacationSchedules("t-other")).toEqual([]);
    expect(await store.getVacationSchedule("t-other", "vac-1")).toBeUndefined();

    const updated = await store.updateVacationSchedule("t-a", "vac-1", { state: "active" });
    expect(updated?.state).toBe("active");
    expect((await store.getVacationSchedule("t-a", "vac-1"))?.state).toBe("active");
    expect(await store.updateVacationSchedule("t-other", "vac-1", { state: "ended" })).toBeUndefined();
    expect((await store.getVacationSchedule("t-a", "vac-1"))?.state).toBe("active");
  });

  it("appends an audit event for every create and state change", async () => {
    const db = await memoryDb();
    const store = createSqliteVacationScheduleStore(db);

    await store.createVacationSchedule(INPUT);
    await store.updateVacationSchedule("t-a", "vac-1", { state: "ended" });

    const rows = db
      .prepare("SELECT action, targetType, targetId, tenantId, before, after FROM audit_events WHERE targetId = ? ORDER BY timestamp, rowid")
      .all("vac-1") as { action: string; targetType: string; tenantId: string; before: string | null; after: string }[];
    expect(rows.map((r) => r.action)).toEqual(["vacation.schedule.create", "vacation.schedule.update"]);
    expect(rows[0]).toMatchObject({ targetType: "vacation_schedule", tenantId: "t-a", before: null });
    expect(JSON.parse(rows[1]!.before as string)).toMatchObject({ state: "scheduled" });
    expect(JSON.parse(rows[1]!.after)).toMatchObject({ state: "ended" });
  });

  it("rejects a state outside the table's check constraint", async () => {
    const db = await memoryDb();
    const store = createSqliteVacationScheduleStore(db);
    await store.createVacationSchedule(INPUT);

    await expect(
      store.updateVacationSchedule("t-a", "vac-1", { state: "bogus" as never }),
    ).rejects.toThrow();
  });
});

describe("mailbox rule recipients (T-0895)", () => {
  const plan = { action: "create", mailboxId: "mbx-1" };

  it("sends array recipient fields to the worker as arrays of addresses", async () => {
    const { providers, calls } = await harness(() => plan);

    await providers.mailboxRules.createRule(
      "t-a",
      "mbx-1",
      {
        name: "Fan out",
        forwardTo: ["a@example.invalid", "b@example.invalid"],
        forwardAsAttachmentTo: ["c@example.invalid"],
        redirectTo: ["d@example.invalid", "e@example.invalid"],
      },
      true,
    );

    const payload = calls[0]?.job as Job;
    expect(calls[0]?.entrypoint).toBe("set-mailbox-rule.ps1");
    expect(payload["forwardTo"]).toEqual(["a@example.invalid", "b@example.invalid"]);
    expect(payload["forwardAsAttachmentTo"]).toEqual(["c@example.invalid"]);
    expect(payload["redirectTo"]).toEqual(["d@example.invalid", "e@example.invalid"]);
  });

  it("turns a single or delimited string into a list and trims blanks", async () => {
    const { providers, calls } = await harness(() => plan);

    await providers.mailboxRules.editRule(
      "t-a",
      "mbx-1",
      "rule-1",
      { forwardTo: "a@example.invalid", redirectTo: " b@example.invalid ; c@example.invalid, " },
      true,
    );

    const payload = calls[0]?.job as Job;
    expect(payload["forwardTo"]).toEqual(["a@example.invalid"]);
    expect(payload["redirectTo"]).toEqual(["b@example.invalid", "c@example.invalid"]);
  });

  it("leaves absent recipient fields out of the job", async () => {
    const { providers, calls } = await harness(() => plan);

    await providers.mailboxRules.editRule("t-a", "mbx-1", "rule-1", { name: "Renamed" }, true);

    const payload = calls[0]?.job as Job;
    expect(payload).not.toHaveProperty("forwardTo");
    expect(payload).not.toHaveProperty("forwardAsAttachmentTo");
    expect(payload).not.toHaveProperty("redirectTo");
  });

  it("refuses a recipient value that is neither an address nor a list of addresses, with no worker call", async () => {
    const { providers, calls } = await harness(() => plan);

    await expect(
      providers.mailboxRules.createRule("t-a", "mbx-1", { name: "Bad", forwardTo: { address: "a@example.invalid" } }, true),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      providers.mailboxRules.editRule("t-a", "mbx-1", "rule-1", { redirectTo: ["a@example.invalid", 42] }, true),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });
});
