import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { AppError, ErrorCodes } from "../errors.js";
import {
  DEFENDER_POLICY_AREAS,
  type DefenderDeploymentTemplateInput,
  createInMemoryDefenderDeploymentTemplateRepository,
  SqliteDefenderDeploymentTemplateRepository,
  validatePolicyAreas,
  validatePolicyJson,
} from "./defender-deployment-templates.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const TEMPLATE_A = "aaaaaaaa-0000-0000-0000-000000000000";

function input(
  overrides: Partial<DefenderDeploymentTemplateInput> = {},
): DefenderDeploymentTemplateInput {
  return {
    id: TEMPLATE_A,
    tenantId: TENANT_A,
    name: "Recommended baseline",
    policyAreas: ["av", "edr"],
    policyJson: { av: { realTimeProtection: true } },
    ...overrides,
  };
}

describe("defender deployment template repository", () => {
  it("round-trips the SPEC §5 fields", async () => {
    const repo = createInMemoryDefenderDeploymentTemplateRepository();
    const created = await repo.create(input());

    expect(created).toMatchObject({
      id: TEMPLATE_A,
      tenantId: TENANT_A,
      name: "Recommended baseline",
      policyAreas: ["av", "edr"],
      policyJson: { av: { realTimeProtection: true } },
      deletedAt: null,
    });
    expect(created.createdAt).toEqual(expect.any(String));
    expect(created.updatedAt).toEqual(expect.any(String));

    const loaded = await repo.get(TENANT_A, TEMPLATE_A);
    expect(loaded).toEqual(created);
  });

  it("validates policyAreas against the registry", async () => {
    const repo = createInMemoryDefenderDeploymentTemplateRepository();

    for (const policyAreas of [[], ["firewall"], ["av", "av"], ["av", 7]]) {
      await expect(repo.create(input({ policyAreas: policyAreas as string[] }))).rejects.toMatchObject(
        { code: ErrorCodes.validationFailed },
      );
    }

    await expect(repo.create(input({ policyAreas: ["av"] }))).resolves.toMatchObject({
      policyAreas: ["av"],
    });
    expect(DEFENDER_POLICY_AREAS).toContain("av");
  });

  it("validates policyJson as well-formed", async () => {
    const repo = createInMemoryDefenderDeploymentTemplateRepository();

    await expect(
      repo.create(input({ policyJson: "{ not json" as unknown as Record<string, unknown> })),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      repo.create(input({ policyJson: ["not", "an", "object"] as unknown as Record<string, unknown> })),
    ).rejects.toMatchObject({ code: ErrorCodes.validationFailed });

    const parsed = await repo.create(
      input({ policyJson: '{"asr":"block"}' as unknown as Record<string, unknown> }),
    );
    expect(parsed.policyJson).toEqual({ asr: "block" });
  });

  it("scopes templates to their tenant", async () => {
    const repo = createInMemoryDefenderDeploymentTemplateRepository();
    await repo.create(input());

    expect(await repo.get(TENANT_A, TEMPLATE_A)).toBeDefined();
    expect(await repo.get(TENANT_B, TEMPLATE_A)).toBeUndefined();
    expect(await repo.list(TENANT_A)).toHaveLength(1);
    expect(await repo.list(TENANT_B)).toHaveLength(0);
  });

  it("filters list by policy area", async () => {
    const repo = createInMemoryDefenderDeploymentTemplateRepository();
    await repo.create(input({ id: TEMPLATE_A, policyAreas: ["av"] }));
    await repo.create(
      input({ id: "bbbbbbbb-0000-0000-0000-000000000000", policyAreas: ["edr"] }),
    );

    expect(await repo.list(TENANT_A, { policyArea: "edr" })).toHaveLength(1);
    expect(await repo.list(TENANT_A, { policyArea: "asr" })).toHaveLength(0);
  });

  it("soft-deletes through the repository", async () => {
    const repo = createInMemoryDefenderDeploymentTemplateRepository();
    await repo.create(input());

    expect(await repo.softDelete(TENANT_A, TEMPLATE_A)).toBe(true);
    expect(await repo.get(TENANT_A, TEMPLATE_A)).toBeUndefined();
    expect(await repo.list(TENANT_A)).toHaveLength(0);

    const hidden = await repo.get(TENANT_A, TEMPLATE_A, { includeDeleted: true });
    expect(hidden?.deletedAt).not.toBeNull();
    expect(await repo.list(TENANT_A, { includeDeleted: true })).toHaveLength(1);
    expect(await repo.softDelete(TENANT_A, TEMPLATE_A)).toBe(false);
    expect(await repo.softDelete(TENANT_B, TEMPLATE_A)).toBe(false);
  });

  it("updates an existing template and validates the patch", async () => {
    const repo = createInMemoryDefenderDeploymentTemplateRepository();
    await repo.create(input());

    const updated = await repo.update(TENANT_A, TEMPLATE_A, {
      name: "Tighter baseline",
      policyAreas: ["av", "asr"],
      policyJson: { asr: "block" },
    });
    expect(updated).toMatchObject({
      name: "Tighter baseline",
      policyAreas: ["av", "asr"],
      policyJson: { asr: "block" },
    });

    await expect(
      repo.update(TENANT_A, TEMPLATE_A, { policyAreas: ["firewall"] }),
    ).rejects.toMatchObject({ code: ErrorCodes.validationFailed });
    await expect(repo.update(TENANT_B, TEMPLATE_A, { name: "nope" })).resolves.toBeUndefined();

    await repo.softDelete(TENANT_A, TEMPLATE_A);
    await expect(repo.update(TENANT_A, TEMPLATE_A, { name: "nope" })).resolves.toBeUndefined();
  });
});

describe("defender template validation helpers", () => {
  it("accepts an injected policy-area registry", () => {
    expect(validatePolicyAreas(["firewall"], { policyAreas: ["firewall"] })).toEqual(["firewall"]);
    expect(() => validatePolicyAreas(["av"], { policyAreas: ["firewall"] })).toThrow(AppError);
  });

  it("reports every invalid policy area", () => {
    try {
      validatePolicyAreas(["av", "firewall", "smartScreen"]);
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).details).toHaveLength(2);
    }
  });

  it("rejects policyJson that is not an object", () => {
    expect(() => validatePolicyJson(null)).toThrow(AppError);
    expect(() => validatePolicyJson("42")).toThrow(AppError);
    expect(validatePolicyJson({ av: true })).toEqual({ av: true });
  });
});

// ---------------------------------------------------------------------------
// SQLite adapter (T-0849)
// ---------------------------------------------------------------------------

function migration(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../db/migrations/${name}`, import.meta.url)),
    "utf8",
  );
}

function openSqlite(): { db: Database.Database; repo: SqliteDefenderDeploymentTemplateRepository } {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(migration("0001_init.sql"));
  db.exec(migration("0022_defender_deployment_templates.sql"));
  const insertTenant = db.prepare(
    "INSERT INTO tenants (id, displayName, createdAt, updatedAt) VALUES (?, ?, ?, ?)",
  );
  insertTenant.run(TENANT_A, "Tenant A", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  insertTenant.run(TENANT_B, "Tenant B", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  return { db, repo: new SqliteDefenderDeploymentTemplateRepository(db) };
}

describe("SQLite defender deployment template repository (T-0849)", () => {
  it("persists, lists, updates, and soft-deletes a template", async () => {
    const { db, repo } = openSqlite();
    try {
      const created = await repo.create(input());
      expect(created).toMatchObject({
        id: TEMPLATE_A,
        tenantId: TENANT_A,
        name: "Recommended baseline",
        policyAreas: ["av", "edr"],
        policyJson: { av: { realTimeProtection: true } },
        deletedAt: null,
      });

      expect(await repo.get(TENANT_A, TEMPLATE_A)).toEqual(created);
      expect(await repo.get(TENANT_B, TEMPLATE_A)).toBeUndefined();
      expect(await repo.list(TENANT_A)).toHaveLength(1);
      expect(await repo.list(TENANT_B)).toHaveLength(0);
      expect(await repo.list(TENANT_A, { policyArea: "edr" })).toHaveLength(1);
      expect(await repo.list(TENANT_A, { policyArea: "asr" })).toHaveLength(0);

      const updated = await repo.update(TENANT_A, TEMPLATE_A, {
        name: "Tighter baseline",
        policyAreas: ["av", "asr"],
        policyJson: { asr: "block" },
      });
      expect(updated).toMatchObject({
        name: "Tighter baseline",
        policyAreas: ["av", "asr"],
        policyJson: { asr: "block" },
      });

      expect(await repo.softDelete(TENANT_A, TEMPLATE_A)).toBe(true);
      expect(await repo.get(TENANT_A, TEMPLATE_A)).toBeUndefined();
      expect(await repo.list(TENANT_A)).toHaveLength(0);
      expect(await repo.get(TENANT_A, TEMPLATE_A, { includeDeleted: true })).toMatchObject({
        deletedAt: expect.any(String),
      });
      expect(await repo.softDelete(TENANT_A, TEMPLATE_A)).toBe(false);
      expect(await repo.update(TENANT_A, TEMPLATE_A, { name: "nope" })).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("rejects an unsupported policy area before writing", async () => {
    const { db, repo } = openSqlite();
    try {
      await expect(repo.create(input({ policyAreas: ["firewall"] }))).rejects.toMatchObject({
        code: ErrorCodes.validationFailed,
      });
    } finally {
      db.close();
    }
  });
});
