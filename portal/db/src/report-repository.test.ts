import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { TenantInput } from "./repository.js";
import { openSqliteReportRepository, type GeneratedReportInput } from "./report-repository.js";
import { openSqliteRepository } from "./sqlite-repository.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const REPORT_A = "aaaaaaaa-0000-0000-0000-000000000000";
const REPORT_B = "bbbbbbbb-0000-0000-0000-000000000000";
const TEMPLATE_A = "tttttttt-0000-0000-0000-000000000000";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-reports-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function tenant(id: string): TenantInput {
  return {
    id,
    displayName: `Tenant ${id.slice(0, 4)}`,
    defaultDomain: null,
    initialDomain: null,
    source: "direct",
    status: "active",
    excluded: false,
    lastRunAt: null,
    errorCount: 0,
  };
}

function report(id: string, tenantId: string, extra: Partial<GeneratedReportInput> = {}): GeneratedReportInput {
  return {
    id,
    templateId: TEMPLATE_A,
    tenantId,
    status: "queued",
    artifactRef: null,
    createdBy: "user-0001",
    scheduleId: null,
    ...extra,
  };
}

async function openRepos(
  filename: string,
): Promise<Awaited<ReturnType<typeof openSqliteReportRepository>>> {
  const base = await openSqliteRepository({ filename });
  await base.upsertTenant(tenant(TENANT_A));
  await base.upsertTenant(tenant(TENANT_B));
  base.close();
  return openSqliteReportRepository({ filename });
}

async function seeded(
  filename: string,
): Promise<Awaited<ReturnType<typeof openSqliteReportRepository>>> {
  const repo = await openRepos(filename);
  await repo.createGeneratedReport(report(REPORT_A, TENANT_A));
  await repo.createGeneratedReport(report(REPORT_B, TENANT_B));
  return repo;
}

describe("migration 0005", () => {
  it("creates generated_reports with metadata columns and no inline-bytes column", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteReportRepository({ filename });
    expect(repo.schemaVersion).toBeGreaterThanOrEqual(5);
    repo.close();

    const raw = new Database(filename);
    const columns = (
      raw.prepare("PRAGMA table_info(generated_reports)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "id",
        "templateId",
        "tenantId",
        "status",
        "artifactRef",
        "createdBy",
        "scheduleId",
        "createdAt",
        "updatedAt",
        "deletedAt",
      ]),
    );
    expect(columns.some((name) => /bytes|content|blob|body|^data$/i.test(name))).toBe(false);
    raw.close();
  });
});

describe("generated report round-trip", () => {
  it("round-trips metadata with an artifactRef and never an inline byte field", async () => {
    const filename = tempDbPath();
    const repo = await openRepos(filename);
    const artifactRef = `runs/${TENANT_A}/run-0001/report.pdf`;
    const created = await repo.createGeneratedReport(
      report(REPORT_A, TENANT_A, { status: "ready", artifactRef, templateId: null, scheduleId: "sched-1" }),
    );

    expect(created.artifactRef).toBe(artifactRef);
    expect(created.templateId).toBeNull();
    expect(created.scheduleId).toBe("sched-1");
    expect(Object.keys(created)).not.toContain("bytes");
    expect(Object.keys(created)).not.toContain("content");

    const fetched = await repo.getGeneratedReport(TENANT_A, REPORT_A);
    expect(fetched?.artifactRef).toBe(artifactRef);
    expect(fetched?.status).toBe("ready");
    expect((await repo.listGeneratedReports(TENANT_A)).map((row) => row.id)).toEqual([REPORT_A]);
    repo.close();
  });
});

describe("tenant scoping", () => {
  it("scopes reads, status updates, and deletes to the owning tenant", async () => {
    const filename = tempDbPath();
    const repo = await seeded(filename);

    expect((await repo.listGeneratedReports(TENANT_A)).map((row) => row.id)).toEqual([REPORT_A]);
    expect((await repo.listGeneratedReports(TENANT_B)).map((row) => row.id)).toEqual([REPORT_B]);
    expect(await repo.getGeneratedReport(TENANT_B, REPORT_A)).toBeUndefined();
    expect(await repo.getGeneratedReport(TENANT_A, REPORT_A)).toBeDefined();

    expect(await repo.updateGeneratedReportStatus(TENANT_B, REPORT_A, "ready")).toBeUndefined();
    expect((await repo.getGeneratedReport(TENANT_A, REPORT_A))?.status).toBe("queued");

    expect(await repo.softDeleteGeneratedReport(TENANT_B, REPORT_A)).toBe(false);
    expect(await repo.softDeleteGeneratedReport(TENANT_A, REPORT_A)).toBe(true);
    expect((await repo.listGeneratedReports(TENANT_A))).toHaveLength(0);
    repo.close();
  });
});

describe("status transition and audit", () => {
  it("emits an audit event on create and on each status change", async () => {
    const filename = tempDbPath();
    const repo = await openRepos(filename);
    await repo.createGeneratedReport(report(REPORT_A, TENANT_A));

    const at = "2026-06-01T00:00:00.000Z";
    const updated = await repo.updateGeneratedReportStatus(TENANT_A, REPORT_A, "ready", { now: at });
    expect(updated?.status).toBe("ready");
    expect(updated?.updatedAt).toBe(at);
    await repo.updateGeneratedReportStatus(TENANT_A, REPORT_A, "ready", { now: at });
    repo.close();

    const auditor = await openSqliteRepository({ filename });
    const events = await auditor.listAuditEvents(TENANT_A);
    expect(events).toHaveLength(2);

    const created = events.find((event) => event.action === "report.generate");
    expect(created).toBeDefined();
    expect(created?.targetType).toBe("generatedReport");
    expect(created?.targetId).toBe(REPORT_A);
    expect(created?.tenantId).toBe(TENANT_A);
    expect(created?.result).toBe("success");
    expect(created?.after).toMatchObject({ status: "queued", artifactRef: null });

    const transitioned = events.find((event) => event.action === "report.status");
    expect(transitioned).toBeDefined();
    expect(transitioned?.targetId).toBe(REPORT_A);
    expect(transitioned?.timestamp).toBe(at);
    expect(transitioned?.before).toMatchObject({ status: "queued" });
    expect(transitioned?.after).toMatchObject({ status: "ready" });
    auditor.close();
  });
});

describe("soft delete", () => {
  it("hides deleted reports but keeps the row and supports includeDeleted", async () => {
    const filename = tempDbPath();
    const repo = await openRepos(filename);
    await repo.createGeneratedReport(report(REPORT_A, TENANT_A));

    expect(await repo.softDeleteGeneratedReport(TENANT_A, REPORT_A, { now: "2026-07-01T00:00:00.000Z" })).toBe(
      true,
    );
    expect(await repo.getGeneratedReport(TENANT_A, REPORT_A)).toBeUndefined();
    expect(await repo.listGeneratedReports(TENANT_A)).toHaveLength(0);
    expect((await repo.getGeneratedReport(TENANT_A, REPORT_A, { includeDeleted: true }))?.deletedAt).toBe(
      "2026-07-01T00:00:00.000Z",
    );
    expect(await repo.listGeneratedReports(TENANT_A, { includeDeleted: true })).toHaveLength(1);
    expect(await repo.softDeleteGeneratedReport(TENANT_A, REPORT_A)).toBe(false);
    repo.close();

    const raw = new Database(filename);
    expect(
      raw.prepare("SELECT COUNT(*) AS c FROM generated_reports WHERE id = ?").get(REPORT_A),
    ).toMatchObject({ c: 1 });
    raw.close();
  });
});
