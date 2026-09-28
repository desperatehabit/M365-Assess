import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  APP_DEPLOYMENT_STATES,
  APP_DEPLOYMENT_TRANSITIONS,
  AppDeploymentValidationError,
  MAX_APP_DEPLOYMENT_JSON_BYTES,
  SqliteAppDeploymentRepository,
  type AppDeploymentInput,
} from "./app-deployments.js";

function migration(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../db/migrations/${name}`, import.meta.url)), "utf8");
}

const BASE_MIGRATION = migration("0001_init.sql");
const MIGRATION = migration("0082_app_deployments.sql");

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const NOW = "2026-09-28T00:00:00.000Z";
const LATER = "2026-09-28T00:05:00.000Z";

const openDbs: Database.Database[] = [];

function open(): { db: Database.Database; repo: SqliteAppDeploymentRepository } {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(BASE_MIGRATION);
  db.exec(MIGRATION);
  const seed = db.prepare(
    `INSERT INTO tenants (id, source, status, excluded, errorCount, createdAt, updatedAt)
     VALUES (?, 'direct', 'active', 0, 0, ?, ?)`,
  );
  seed.run(TENANT_A, NOW, NOW);
  seed.run(TENANT_B, NOW, NOW);
  openDbs.push(db);
  return { db, repo: new SqliteAppDeploymentRepository(db, 82) };
}

function input(extra: Partial<AppDeploymentInput> = {}): AppDeploymentInput {
  return {
    id: "dep-1",
    tenantId: TENANT_A,
    appType: "win32",
    payload: { displayName: "7-Zip", packageId: "pkg-1", installCommand: "setup.exe /S" },
    createdBy: "operator-1",
    createdAt: NOW,
    ...extra,
  };
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

describe("0082_app_deployments migration (T-0322)", () => {
  it("is idempotent", () => {
    const { db } = open();
    expect(() => db.exec(MIGRATION)).not.toThrow();
  });

  it("rejects an unknown state and a tenant that does not exist", () => {
    const { db } = open();
    const insert = db.prepare(
      `INSERT INTO app_deployments (id, tenantId, appType, state, payload, createdBy, createdAt, updatedAt)
       VALUES (?, ?, 'win32', ?, '{}', 'u', ?, ?)`,
    );
    expect(() => insert.run("x", TENANT_A, "exploded", NOW, NOW)).toThrow(/CHECK/);
    expect(() => insert.run("y", "no-such-tenant", "queued", NOW, NOW)).toThrow(/FOREIGN KEY/);
  });
});

describe("SqliteAppDeploymentRepository (T-0322)", () => {
  it("round-trips the SPEC §5 fields and starts queued", async () => {
    const { repo } = open();
    const saved = await repo.createDeployment(input());
    expect(saved).toEqual({
      id: "dep-1",
      tenantId: TENANT_A,
      appType: "win32",
      state: "queued",
      payload: { displayName: "7-Zip", packageId: "pkg-1", installCommand: "setup.exe /S" },
      results: null,
      createdBy: "operator-1",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(await repo.getDeployment(TENANT_A, "dep-1")).toEqual(saved);
  });

  it("scopes every read and write by tenant", async () => {
    const { repo } = open();
    await repo.createDeployment(input());
    await repo.createDeployment(input({ id: "dep-b", tenantId: TENANT_B }));
    expect(await repo.getDeployment(TENANT_B, "dep-1")).toBeUndefined();
    expect((await repo.listDeployments(TENANT_A)).map((d) => d.id)).toEqual(["dep-1"]);
    expect(await repo.transitionDeployment(TENANT_B, "dep-1", "uploading", LATER)).toBeUndefined();
    expect((await repo.getDeployment(TENANT_A, "dep-1"))!.state).toBe("queued");
  });

  it("lists newest first and filters by state", async () => {
    const { repo } = open();
    await repo.createDeployment(input({ id: "old" }));
    await repo.createDeployment(input({ id: "new", createdAt: LATER }));
    await repo.transitionDeployment(TENANT_A, "old", "uploading", LATER);
    expect((await repo.listDeployments(TENANT_A)).map((d) => d.id)).toEqual(["new", "old"]);
    expect((await repo.listDeployments(TENANT_A, { state: "uploading" })).map((d) => d.id)).toEqual(["old"]);
  });

  it("walks the queue to success, recording results", async () => {
    const { repo } = open();
    await repo.createDeployment(input());
    await repo.transitionDeployment(TENANT_A, "dep-1", "uploading", LATER);
    await repo.transitionDeployment(TENANT_A, "dep-1", "committing", LATER, { uploadedBytes: 1024 });
    const done = await repo.transitionDeployment(TENANT_A, "dep-1", "succeeded", LATER, {
      graphAppId: "app-123",
    });
    expect(done).toMatchObject({ state: "succeeded", results: { graphAppId: "app-123" }, updatedAt: LATER });
  });

  it("keeps earlier results when a transition records none", async () => {
    const { repo } = open();
    await repo.createDeployment(input());
    await repo.transitionDeployment(TENANT_A, "dep-1", "uploading", LATER, { attempt: 1 });
    const failed = await repo.transitionDeployment(TENANT_A, "dep-1", "failed", LATER);
    expect(failed!.results).toEqual({ attempt: 1 });
  });

  it("re-queues a failed deployment but never leaves a terminal state", async () => {
    const { repo } = open();
    await repo.createDeployment(input());
    await repo.transitionDeployment(TENANT_A, "dep-1", "failed", LATER, { error: "upload timed out" });
    const retried = await repo.transitionDeployment(TENANT_A, "dep-1", "queued", LATER);
    expect(retried!.state).toBe("queued");
    await repo.transitionDeployment(TENANT_A, "dep-1", "cancelled", LATER);
    await expect(repo.transitionDeployment(TENANT_A, "dep-1", "queued", LATER)).rejects.toBeInstanceOf(
      AppDeploymentValidationError,
    );
  });

  it("rejects a transition the queue does not allow", async () => {
    const { repo } = open();
    await repo.createDeployment(input());
    await expect(repo.transitionDeployment(TENANT_A, "dep-1", "succeeded", LATER)).rejects.toThrow(
      /from 'queued' to 'succeeded'/,
    );
  });

  it("defines a transition list for every state", () => {
    for (const state of APP_DEPLOYMENT_STATES) expect(APP_DEPLOYMENT_TRANSITIONS[state], state).toBeDefined();
  });

  it("refuses app types v1 does not deploy", async () => {
    const { repo } = open();
    await expect(repo.createDeployment(input({ appType: "office" }))).rejects.toThrow(/not supported/);
  });

  it.each([
    ["a top-level secret", { clientSecret: "s3cret" }],
    ["a nested password", { install: { runAs: { password: "p" } } }],
    ["a token in an array", { steps: [{ accessToken: "t" }] }],
  ])("refuses a payload carrying %s", async (_label, payload) => {
    const { db, repo } = open();
    await expect(repo.createDeployment(input({ payload }))).rejects.toThrow(/must not carry credentials/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM app_deployments").get()).toEqual({ n: 0 });
  });

  it("refuses package-sized payloads and results", async () => {
    const { repo } = open();
    const blob = "A".repeat(MAX_APP_DEPLOYMENT_JSON_BYTES);
    await expect(repo.createDeployment(input({ payload: { content: blob } }))).rejects.toThrow(/artifact tier/);
    await repo.createDeployment(input());
    await expect(
      repo.transitionDeployment(TENANT_A, "dep-1", "uploading", LATER, { content: blob }),
    ).rejects.toThrow(/artifact tier/);
  });
});
