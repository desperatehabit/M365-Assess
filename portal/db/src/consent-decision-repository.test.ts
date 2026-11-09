import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openSqliteConsentDecisionRepository,
  type SqliteConsentDecisionRepository,
} from "./consent-decision-repository.js";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-consent-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function decision(overrides: Partial<Parameters<SqliteConsentDecisionRepository["appendConsentDecision"]>[0]> = {}) {
  return {
    id: "decision-1",
    tenantId: TENANT_A,
    appId: "app-1",
    decision: "approve" as const,
    by: "user@example.invalid",
    at: "2026-01-01T00:00:00.000Z",
    reason: null,
    ...overrides,
  };
}

describe("consent decision repository (T-0870)", () => {
  it("persists a decision across repository instances", async () => {
    const filename = tempDbPath();
    const first = await openSqliteConsentDecisionRepository({ filename });
    await first.appendConsentDecision(decision());
    first.close();

    const second = await openSqliteConsentDecisionRepository({ filename });
    const rows = await second.listConsentDecisions(TENANT_A);
    second.close();

    expect(rows).toEqual([decision()]);
  });

  it("scopes decisions by tenant and orders them by decision time", async () => {
    const repository = await openSqliteConsentDecisionRepository({ filename: tempDbPath() });
    await repository.appendConsentDecision(
      decision({ id: "later", at: "2026-02-01T00:00:00.000Z" }),
    );
    await repository.appendConsentDecision(
      decision({ id: "earlier", at: "2026-01-01T00:00:00.000Z" }),
    );
    await repository.appendConsentDecision(
      decision({ id: "other-tenant", tenantId: TENANT_B }),
    );

    const rows = await repository.listConsentDecisions(TENANT_A);
    expect(rows.map((row) => row.id)).toEqual(["earlier", "later"]);
    expect(await repository.listConsentDecisions(TENANT_B)).toHaveLength(1);
    repository.close();
  });

  it("persists a deny decision without a reason", async () => {
    const repository = await openSqliteConsentDecisionRepository({ filename: tempDbPath() });
    await repository.appendConsentDecision(
      decision({ id: "deny-1", decision: "deny", reason: "not approved" }),
    );
    const [row] = await repository.listConsentDecisions(TENANT_A);
    expect(row?.decision).toBe("deny");
    expect(row?.reason).toBe("not approved");
    repository.close();
  });
});
