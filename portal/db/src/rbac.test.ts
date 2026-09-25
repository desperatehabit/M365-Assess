import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { BuiltinRoleError, openSqliteRbacRepository } from "./rbac-repository.js";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-rbac-"));
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

describe("rbac migration", () => {
  it("creates the SPEC §5 entities with the stated columns", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRbacRepository({ filename });
    expect(repo.schemaVersion).toBe(2);
    repo.close();

    expect(columns(filename, "portal_users")).toEqual(
      expect.arrayContaining(["id", "upn", "displayName", "status", "preferences"]),
    );
    expect(columns(filename, "roles")).toEqual(
      expect.arrayContaining(["id", "name", "include", "exclude", "builtin"]),
    );
    expect(columns(filename, "user_scopes")).toEqual(
      expect.arrayContaining(["userId", "targetType", "targetId"]),
    );
    expect(columns(filename, "api_clients")).toEqual(
      expect.arrayContaining([
        "id",
        "name",
        "secretHash",
        "roles",
        "ipRanges",
        "rateLimit",
        "enabled",
        "lastUsedAt",
      ]),
    );
    expect(columns(filename, "access_ip_ranges")).toEqual(
      expect.arrayContaining(["id", "cidr", "scope"]),
    );
    expect(columns(filename, "permission_registry")).toEqual(
      expect.arrayContaining(["endpoint", "permission", "functionality"]),
    );
  });

  it("is forward-only and re-runnable without duplicating base roles", async () => {
    const filename = tempDbPath();
    const first = await openSqliteRbacRepository({ filename });
    const version = first.schemaVersion;
    first.close();

    const second = await openSqliteRbacRepository({ filename });
    expect(second.schemaVersion).toBe(version);
    expect(await second.listRoles()).toHaveLength(4);
    second.close();
  });

  it("stores API client secrets only as a hash, never plaintext", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRbacRepository({ filename });
    repo.close();

    const clientColumns = columns(filename, "api_clients");
    expect(clientColumns).toContain("secretHash");
    expect(clientColumns).not.toContain("secret");
    expect(clientColumns).not.toContain("secretPlaintext");
    expect(clientColumns).not.toContain("clientSecret");
  });
});

describe("base roles", () => {
  it("seeds the four §4.1 roles with builtin=true", async () => {
    const repo = await openSqliteRbacRepository({ filename: tempDbPath() });
    const roles = await repo.listRoles();

    expect(roles.map((role) => role.id).sort()).toEqual([
      "admin",
      "editor",
      "readonly",
      "superadmin",
    ]);
    for (const role of roles) expect(role.builtin).toBe(true);

    const editor = await repo.getRole("editor");
    expect(editor?.include).toEqual(["*.Read", "*.ReadWrite"]);
    expect(editor?.exclude).toEqual([
      "CIPP.Admin.*",
      "CIPP.SuperAdmin.*",
      "CIPP.AppSettings.*",
      "Remediation.Apply",
    ]);
    expect(editor?.exclude).toContain("Remediation.Apply");

    const superadmin = await repo.getRole("superadmin");
    expect(superadmin?.include).toEqual(["*"]);
    expect(superadmin?.exclude).toEqual([]);
    repo.close();
  });

  it("exposes no mutator for builtin roles", async () => {
    const repo = await openSqliteRbacRepository({ filename: tempDbPath() });

    expect("updateRole" in repo).toBe(false);
    expect("deleteRole" in repo).toBe(false);

    await expect(
      repo.upsertCustomRole({
        id: "editor",
        name: "editor",
        include: ["*"],
        exclude: [],
        builtin: false,
      }),
    ).rejects.toBeInstanceOf(BuiltinRoleError);
    await expect(repo.removeCustomRole("readonly")).rejects.toBeInstanceOf(BuiltinRoleError);

    expect(await repo.getRole("editor")).toBeDefined();
    repo.close();
  });
});

describe("custom roles", () => {
  it("creates and deletes a custom role, allowing Remediation.Apply", async () => {
    const repo = await openSqliteRbacRepository({ filename: tempDbPath() });
    const role = await repo.upsertCustomRole({
      id: "support",
      name: "Support",
      include: ["Tenant.*", "Remediation.Apply"],
      exclude: [],
      builtin: false,
    });

    expect(role.builtin).toBe(false);
    expect(role.include).toContain("Remediation.Apply");
    expect(await repo.removeCustomRole("support")).toBe(true);
    expect(await repo.getRole("support")).toBeUndefined();
    repo.close();
  });
});

describe("api clients", () => {
  it("round-trips the secret hash and never a plaintext secret", async () => {
    const repo = await openSqliteRbacRepository({ filename: tempDbPath() });
    const secretHash = "sha256:1f2e3d4c5b6a";
    const client = await repo.upsertApiClient({
      id: "client-1",
      name: "Reporting Bot",
      secretHash,
      roles: ["readonly"],
      ipRanges: ["10.0.0.0/8"],
      rateLimit: 100,
      enabled: true,
      lastUsedAt: null,
    });

    expect(client.secretHash).toBe(secretHash);
    expect(Object.keys(client)).not.toContain("secret");
    expect((await repo.getApiClient("client-1"))?.secretHash).toBe(secretHash);
    repo.close();
  });
});

describe("portal users and scopes", () => {
  it("stores a user with a base role and a tenant scope", async () => {
    const repo = await openSqliteRbacRepository({ filename: tempDbPath() });
    const user = await repo.upsertPortalUser({
      id: "user-1",
      upn: "operator@example.invalid",
      displayName: "Operator One",
      status: "active",
      preferences: { theme: "dark" },
      roleId: "readonly",
    });
    expect(user.roleId).toBe("readonly");
    expect(user.preferences).toEqual({ theme: "dark" });

    const scope = await repo.upsertUserScope({
      id: "scope-1",
      userId: "user-1",
      targetType: "tenant",
      targetId: "tenant-1",
    });
    expect(scope.targetType).toBe("tenant");
    expect(await repo.listUserScopes("user-1")).toHaveLength(1);
    repo.close();
  });
});
