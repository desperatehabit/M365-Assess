// T-0603 — improvement action -> registry check mapping (EPIC-031 SPEC §11.1).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSecureScoreRepository } from "../../repository/secure-score.js";
import {
  defaultMapping,
  deriveActionCheckMap,
  parseMappingOverrides,
  persistResolvedMapping,
  resolveFixTarget,
  type ModuleRegistryCheck,
} from "./mapping.js";

const BASE_MIGRATION = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0001_init.sql", import.meta.url)),
  "utf8",
);
const MIGRATION = readFileSync(
  fileURLToPath(new URL("../../../../db/migrations/0039_secure_score.sql", import.meta.url)),
  "utf8",
);

const CHECKS: ModuleRegistryCheck[] = [
  {
    check: "ENTRA-AUTHMETHOD-003",
    frameworks: { "cisa-scuba": { controlId: "MS.AAD.3.5v2" } },
  },
  {
    check: "CA-MFA-ADMIN-001",
    frameworks: { "cisa-scuba": { controlId: "MS.AAD.3.1v1" } },
  },
  {
    check: "CA-PHISHRES-001",
    frameworks: { "cisa-scuba": { controlId: "MS.AAD.3.1v1" } },
  },
  {
    check: "ENTRA-PASSWORD-001",
    frameworks: { "cis-m365-v6": { controlId: "5.2.3.1" } },
  },
  {
    check: "ENTRA-SECDEFAULT-001",
    frameworks: { eidsca: { controlId: "EIDSCA.AM01" } },
  },
];

const openDbs: Database.Database[] = [];

function open(): { db: Database.Database; repo: SqliteSecureScoreRepository } {
  const db = new Database(":memory:");
  db.exec(BASE_MIGRATION);
  db.exec(MIGRATION);
  openDbs.push(db);
  return { db, repo: new SqliteSecureScoreRepository(db, 39) };
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

describe("deriveActionCheckMap", () => {
  it("links an action id to the registry check that carries it", () => {
    const map = deriveActionCheckMap(CHECKS);
    expect(map.get("ms.aad.3.5v2")).toEqual({
      check: "ENTRA-AUTHMETHOD-003",
      standardKey: "cisa-scuba",
    });
    expect(map.get("eidsca.am01")).toEqual({
      check: "ENTRA-SECDEFAULT-001",
      standardKey: "eidsca",
    });
  });

  it("ignores frameworks whose control ids are not Secure Score action ids", () => {
    const map = deriveActionCheckMap(CHECKS);
    expect(map.has("5.2.3.1")).toBe(false);
  });

  it("breaks a shared-control-id collision deterministically by check id", () => {
    const map = deriveActionCheckMap(CHECKS);
    expect(map.get("ms.aad.3.1v1")?.check).toBe("CA-MFA-ADMIN-001");
    const reversed = deriveActionCheckMap([...CHECKS].reverse());
    expect(reversed.get("ms.aad.3.1v1")?.check).toBe("CA-MFA-ADMIN-001");
  });
});

describe("resolveFixTarget", () => {
  const options = { map: deriveActionCheckMap(CHECKS), overrides: [] };

  it("resolves a derived mapping to check + standard", () => {
    expect(resolveFixTarget({ actionId: "MS.AAD.3.5v2" }, options)).toEqual({
      kind: "mapped",
      actionId: "MS.AAD.3.5v2",
      check: "ENTRA-AUTHMETHOD-003",
      standardKey: "cisa-scuba",
      source: "derived",
    });
  });

  it("matches case-insensitively", () => {
    const target = resolveFixTarget({ actionId: "ms.aad.3.5v2" }, options);
    expect(target).toMatchObject({ kind: "mapped", check: "ENTRA-AUTHMETHOD-003" });
  });

  it("resolves an action the derivation cannot, from a curated override", () => {
    const overrides = parseMappingOverrides([
      { actionId: "MFARegistrationV2", check: "ENTRA-MFA-001", standardKey: "cis-m365-v6" },
    ]);
    expect(resolveFixTarget({ actionId: "MFARegistrationV2" }, options).kind).toBe("unmapped");
    expect(resolveFixTarget({ actionId: "MFARegistrationV2" }, { ...options, overrides })).toEqual({
      kind: "mapped",
      actionId: "MFARegistrationV2",
      check: "ENTRA-MFA-001",
      standardKey: "cis-m365-v6",
      source: "override",
    });
  });

  it("lets an override win over the derived entry", () => {
    const overrides = parseMappingOverrides([
      { actionId: "MS.AAD.3.5v2", check: "CA-MFA-ADMIN-001", standardKey: "cis-m365-v6" },
    ]);
    const target = resolveFixTarget({ actionId: "MS.AAD.3.5v2" }, { ...options, overrides });
    expect(target).toMatchObject({ kind: "mapped", check: "CA-MFA-ADMIN-001", source: "override" });
  });

  it("resolves a standard-only override to a portal standard reference", () => {
    const overrides = parseMappingOverrides([
      { actionId: "windowsHelloForBusiness", standardKey: "cis-m365-v6" },
    ]);
    expect(resolveFixTarget({ actionId: "windowsHelloForBusiness" }, { ...options, overrides })).toEqual(
      {
        kind: "standard",
        actionId: "windowsHelloForBusiness",
        standardKey: "cis-m365-v6",
        source: "override",
      },
    );
  });

  it("returns an explicit unmapped result, not an error", () => {
    expect(resolveFixTarget({ actionId: "totallyUnknownAction" }, options)).toEqual({
      kind: "unmapped",
      actionId: "totallyUnknownAction",
      reason: "no-automated-remediation",
    });
  });
});

describe("shipped registry mapping", () => {
  it("derives a mapping from the module registry", () => {
    expect(resolveFixTarget({ actionId: "MS.AAD.3.5v2" })).toEqual({
      kind: "mapped",
      actionId: "MS.AAD.3.5v2",
      check: "ENTRA-AUTHMETHOD-003",
      standardKey: "cisa-scuba",
      source: "derived",
    });
  });

  it("resolves a shipped override the derivation cannot", () => {
    const derivationOnly = resolveFixTarget(
      { actionId: "MFARegistrationV2" },
      { map: defaultMapping().map, overrides: [] },
    );
    expect(derivationOnly.kind).toBe("unmapped");

    expect(resolveFixTarget({ actionId: "MFARegistrationV2" })).toEqual({
      kind: "mapped",
      actionId: "MFARegistrationV2",
      check: "ENTRA-MFA-001",
      standardKey: "cis-m365-v6",
      source: "override",
    });
  });

  it("resolves a shipped standard-only override to a portal standard reference", () => {
    expect(resolveFixTarget({ actionId: "windowsHelloForBusiness" })).toEqual({
      kind: "standard",
      actionId: "windowsHelloForBusiness",
      standardKey: "cis-m365-v6",
      source: "override",
    });
  });
});

describe("parseMappingOverrides", () => {
  it("rejects an override without an actionId or standardKey", () => {
    expect(() => parseMappingOverrides([{ check: "CA-MFA-ADMIN-001" }])).toThrow(/actionId/);
    expect(() => parseMappingOverrides([{ actionId: "a" }])).toThrow(/standardKey/);
  });
});

describe("persistResolvedMapping", () => {
  it("persists a mapped target and writes an audit event", async () => {
    const { db, repo } = open();
    const target = resolveFixTarget(
      { actionId: "MS.AAD.3.5v2" },
      { map: deriveActionCheckMap(CHECKS), overrides: [] },
    );

    expect(await persistResolvedMapping(repo, target, { by: "operator-1" })).toBe(true);

    expect(await repo.getMapping("MS.AAD.3.5v2")).toMatchObject({
      actionId: "MS.AAD.3.5v2",
      check: "ENTRA-AUTHMETHOD-003",
      standardKey: "cisa-scuba",
    });
    const events = db.prepare("SELECT * FROM audit_events").all() as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: "operator-1",
      actorType: "user",
      action: "secureScore.mapping.change",
      targetType: "scoreActionMapping",
      targetId: "MS.AAD.3.5v2",
    });
  });

  it("does not persist or audit an unmapped target", async () => {
    const { db, repo } = open();
    const target = resolveFixTarget({ actionId: "totallyUnknownAction" }, { map: new Map(), overrides: [] });

    expect(await persistResolvedMapping(repo, target)).toBe(false);

    expect(await repo.getMapping("totallyUnknownAction")).toBeUndefined();
    const count = db.prepare("SELECT COUNT(*) AS c FROM audit_events").get() as { c: number };
    expect(count.c).toBe(0);
  });
});
