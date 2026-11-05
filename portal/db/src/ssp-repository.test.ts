import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteSspRepository, type SspPracticeResponseUpsert } from "./ssp-repository.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-ssp-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function response(overrides: Partial<SspPracticeResponseUpsert> = {}): SspPracticeResponseUpsert {
  return {
    tenantId: TENANT_A,
    practiceId: "3.10.1",
    implementationStatus: "implemented",
    responsibility: "shared",
    narrative: "Badge readers on every entrance.",
    evidence: ["Facility access policy v3"],
    owner: "Facilities",
    plannedCompletion: null,
    updatedBy: "consultant-1",
    ...overrides,
  };
}

function auditActions(filename: string): string[] {
  const raw = new Database(filename, { readonly: true });
  try {
    return (raw.prepare("SELECT action FROM audit_events ORDER BY rowid").all() as { action: string }[]).map((row) => row.action);
  } finally {
    raw.close();
  }
}

describe("SqliteSspRepository", () => {
  it("upserts and reads a tenant's system profile", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteSspRepository({ filename });
    try {
      expect(await repo.getProfile(TENANT_A)).toBeUndefined();
      await repo.upsertProfile({
        tenantId: TENANT_A,
        organizationName: "Contoso Defense",
        systemName: "Contoso CUI enclave",
        systemOwner: "CIO",
        securityContact: "security@contoso.example",
        description: "Microsoft 365 GCC High tenant",
        boundary: "M365 tenant and 40 managed laptops",
        environment: "Two offices",
        interconnections: "None",
        cuiCategories: "CTI",
        updatedBy: "consultant-1",
      });
      const updated = await repo.upsertProfile({ ...(await repo.getProfile(TENANT_A))!, systemOwner: "CISO", updatedBy: "consultant-2" });
      expect(updated).toMatchObject({ systemName: "Contoso CUI enclave", systemOwner: "CISO", updatedBy: "consultant-2" });
      expect(await repo.getProfile(TENANT_B)).toBeUndefined();
    } finally {
      repo.close();
    }
    expect(auditActions(filename)).toEqual(["ssp.profile.update", "ssp.profile.update"]);
  });

  it("stores one answer per tenant and practice, overwriting on re-save", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteSspRepository({ filename });
    try {
      await repo.upsertPracticeResponse(response());
      await repo.upsertPracticeResponse(response({ implementationStatus: "partially-implemented", plannedCompletion: "2027-01-31", evidence: ["a", "b"] }));
      await repo.upsertPracticeResponse(response({ tenantId: TENANT_B }));

      const rows = await repo.listPracticeResponses(TENANT_A);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        practiceId: "3.10.1",
        implementationStatus: "partially-implemented",
        plannedCompletion: "2027-01-31",
        evidence: ["a", "b"],
      });
      expect(await repo.listPracticeResponses(TENANT_B)).toHaveLength(1);
    } finally {
      repo.close();
    }
  });

  it("clears an answer and audits the change", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteSspRepository({ filename });
    try {
      await repo.upsertPracticeResponse(response());
      expect(await repo.deletePracticeResponse(TENANT_A, "3.10.1", "consultant-1")).toBe(true);
      expect(await repo.deletePracticeResponse(TENANT_A, "3.10.1", "consultant-1")).toBe(false);
      expect(await repo.getPracticeResponse(TENANT_A, "3.10.1")).toBeUndefined();
    } finally {
      repo.close();
    }
    expect(auditActions(filename)).toEqual(["ssp.practice.update", "ssp.practice.clear"]);
  });
});
