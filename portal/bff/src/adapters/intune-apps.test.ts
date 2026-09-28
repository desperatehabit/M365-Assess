// Tests for the EPIC-017 worker-backed providers and the app upload queue (T-0844).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { parseJobEnvelope, type JobEnvelope } from "@m365-assess/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteAppDeploymentRepository } from "../repository/app-deployments.js";
import {
  APP_PACKAGES_UNCONFIGURED,
  createAppUploadQueue,
  createAppUploadRunner,
  createIntuneAppProviders,
  createTemplateVariableReader,
  unconfiguredPackageStore,
} from "./intune-apps.js";
import type { TenantWorkerCall } from "./workers.js";

const T1 = "11111111-1111-1111-1111-111111111111";

function harness(respond: (entrypoint: string, fields: Record<string, unknown>) => unknown = () => ({})) {
  const calls: { entrypoint: string; tenantId: string; fields: Record<string, unknown> }[] = [];
  const call: TenantWorkerCall = async (entrypoint, tenantId, fields) => {
    calls.push({ entrypoint, tenantId, fields });
    return respond(entrypoint, fields) as never;
  };
  return { providers: createIntuneAppProviders(call), calls, call };
}

const openDbs: Database.Database[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

describe("EPIC-017 providers (T-0844)", () => {
  it("maps the app list filter to the worker job and normalises a one-item list", async () => {
    const { providers, calls } = harness(() => ({ view: "catalog", totalCount: 1, items: { id: "a" }, unsupported: { appType: "office", count: 1 }, nextCursor: null }));
    const page = await providers.apps.listApps(T1, { view: "catalog", appType: "win32", assigned: false, search: "zip", cursor: "20", limit: 10 });
    expect(calls[0]).toEqual({ entrypoint: "get-intune-apps.ps1", tenantId: T1, fields: { view: "catalog", appType: "win32", assigned: false, search: "zip", top: 10, cursor: "20" } });
    expect(page.items).toEqual([{ id: "a" }]);
    expect(page.view === "catalog" && page.unsupported).toEqual([{ appType: "office", count: 1 }]);
  });

  it("raises a structured worker error from a read the route does not inspect", async () => {
    const { providers } = harness(() => ({ error: "intune.app-type.unsupported", message: "no", statusCode: 501 }));
    await expect(providers.apps.listApps(T1, { view: "catalog", cursor: null, limit: 10 })).rejects.toMatchObject({ status: 501 });
    await expect(providers.enrollment.list(T1)).rejects.toMatchObject({ status: 501 });
  });

  it("passes structured errors through for writes whose routes map them", async () => {
    const error = { error: "intune.app.not_found", message: "gone", statusCode: 404 };
    const { providers } = harness(() => error);
    await expect(providers.crud.getApp(T1, "x")).resolves.toEqual(error);
    await expect(providers.assign.assign(T1, "x", { assignments: [], mode: "replace", preview: true, confirmPlan: null, actor: "u" })).resolves.toEqual(error);
  });

  it("sends each worker the fields it reads", async () => {
    const { providers, calls } = harness(() => ({ items: [] }));
    await providers.crud.changeApp(T1, "app-1", { action: "delete", confirmName: "7-Zip", preview: false, actor: "u" });
    await providers.assign.assign(T1, "app-1", { assignments: [{ target: "allUsers", intent: "available" }], mode: "merge", preview: false, confirmPlan: "h", actor: "u" });
    await providers.templatePreflight.preflight(T1, { displayName: "%A%" }, { A: "x" });
    await providers.autopilot.importDevices(T1, { source: "csv", csv: "a,b", preview: true, actor: "u" });
    await providers.autopilotWrite.write(T1, { action: "assign", profileId: "p1", addGroupIds: ["g"], preview: true, actor: "u" });
    await providers.enrollment.write(T1, { action: "assign", platform: "apple-ade", depOnboardingSettingId: "dep-1", profileId: "ios-1", serialNumbers: ["S"], preview: true, actor: "u" });
    await providers.status.enrollmentStatuses(T1);
    expect(calls.map((c) => [c.entrypoint, c.fields])).toEqual([
      ["set-intune-app.ps1", { action: "delete", appId: "app-1", confirmName: "7-Zip", preview: false, actor: "u" }],
      ["set-intune-app-assignment.ps1", { appId: "app-1", assignments: [{ target: "allUsers", intent: "available" }], mode: "merge", preview: false, confirmPlan: "h", actor: "u" }],
      ["deploy-application-template.ps1", { config: { displayName: "%A%" }, values: { A: "x" } }],
      ["import-autopilot-devices.ps1", { action: "import", source: "csv", csv: "a,b", preview: true, actor: "u" }],
      ["set-autopilot-profile.ps1", { action: "assign", profileId: "p1", addGroupIds: ["g"], preview: true, actor: "u" }],
      ["set-enrollment-profile.ps1", { action: "assign", platform: "apple-ade", depOnboardingSettingId: "dep-1", profileId: "ios-1", serialNumbers: ["S"], preview: true, actor: "u" }],
      ["get-intune-app-status.ps1", { action: "enrollment" }],
    ]);
  });

  it("normalises Autopilot and status lists that PowerShell unrolled", async () => {
    const { providers } = harness((entrypoint) =>
      entrypoint === "get-intune-app-status.ps1" ? { items: { deviceId: "d1" } } : { totalCount: 1, items: { id: "ap-1" }, nextCursor: null },
    );
    expect((await providers.autopilot.listDevices(T1, { cursor: null, limit: 5 })).items).toEqual([{ id: "ap-1" }]);
    expect(await providers.status.appDeviceStatuses(T1)).toEqual([{ deviceId: "d1" }]);
  });
});

describe("template variable reader (T-0844)", () => {
  it("splits global and the tenant's own variables and keeps the secret flag", async () => {
    const read = createTemplateVariableReader({
      listVariables: async () => [
        { id: "1", tenantId: null, name: "Ring", value: "Broad", isSecret: false, createdAt: "", updatedAt: "" },
        { id: "2", tenantId: T1, name: "Pkg", value: "pkg-1", isSecret: false, createdAt: "", updatedAt: "" },
        { id: "3", tenantId: T1, name: "Key", value: "s", isSecret: true, createdAt: "", updatedAt: "" },
        { id: "4", tenantId: "other", name: "Pkg", value: "pkg-9", isSecret: false, createdAt: "", updatedAt: "" },
      ],
    });
    expect(await read(T1)).toEqual({
      global: [{ name: "Ring", value: "Broad", isSecret: false }],
      tenant: [{ name: "Pkg", value: "pkg-1", isSecret: false }, { name: "Key", value: "s", isSecret: true }],
    });
  });
});

describe("unconfigured package store (T-0844)", () => {
  it("answers every package operation with a 503 naming the setting", async () => {
    const store = unconfiguredPackageStore(1024);
    expect(store.maxBytes).toBe(1024);
    await expect(store.getPackage(T1, "p")).rejects.toMatchObject({ status: 503, code: APP_PACKAGES_UNCONFIGURED, message: expect.stringMatching(/M365_BFF_APP_PACKAGE_SECRET/) });
    expect(() => store.verifySignedUrl("p", new URLSearchParams())).toThrow(expect.objectContaining({ status: 503 }));
  });
});

describe("app upload queue and runner (T-0844)", () => {
  it("enqueues a valid reference-only app-upload envelope", async () => {
    const sent: unknown[] = [];
    const queue = createAppUploadQueue({ enqueue: async (e) => (sent.push(e), "job-1") }, () => new Date("2026-09-28T00:00:00Z"));
    await queue.enqueue({ jobId: "job-1", tenantId: T1, deploymentId: "dep-1", correlationId: "corr" });
    const envelope = parseJobEnvelope(sent[0]);
    expect(envelope).toMatchObject({ jobType: "app-upload", tenantId: T1, runId: "dep-1", payload: { contextRef: "app-deployments/dep-1" } });
  });

  it("runs the deployment and reports the queue result from its final state", async () => {
    const db = new Database(":memory:");
    openDbs.push(db);
    const dir = (name: string) => readFileSync(fileURLToPath(new URL(`../../../db/migrations/${name}`, import.meta.url)), "utf8");
    db.exec(dir("0001_init.sql"));
    db.exec(dir("0082_app_deployments.sql"));
    db.prepare("INSERT INTO tenants (id, source, status, excluded, errorCount, createdAt, updatedAt) VALUES (?, 'direct', 'active', 0, 0, '', '')").run(T1);
    const repository = new SqliteAppDeploymentRepository(db, 82);
    await repository.createDeployment({ id: "dep-1", tenantId: T1, appType: "store", payload: { displayName: "CP", packageIdentifier: "9WZ" }, createdBy: "u", createdAt: "2026-09-28T00:00:00Z" });

    let outcome: Record<string, unknown> = { state: "failed", error: "Graph said no" };
    const { call, calls } = harness(() => outcome);
    const run = createAppUploadRunner({ call, repository, packages: unconfiguredPackageStore(1), packageBaseUrl: "http://127.0.0.1:8080" });
    const envelope = (await new Promise<JobEnvelope>((resolve) => {
      void createAppUploadQueue({ enqueue: async (e) => (resolve(parseJobEnvelope(e)), "job-1") }).enqueue({ jobId: "job-1", tenantId: T1, deploymentId: "dep-1", correlationId: "corr" });
    }));

    const failed = await run(envelope, new AbortController().signal);
    expect(failed).toMatchObject({ status: "failed", exitCode: 1, error: { message: "Graph said no", retryable: true } });
    expect(calls[0]).toMatchObject({ entrypoint: "queue-intune-app-upload.ps1", tenantId: T1, fields: { deploymentId: "dep-1", appType: "store" } });
    expect(calls[0]!.fields).not.toHaveProperty("tenantId");

    await repository.transitionDeployment(T1, "dep-1", "queued", "2026-09-28T00:01:00Z");
    outcome = { state: "succeeded", appId: "graph-1" };
    const succeeded = await run(envelope, new AbortController().signal);
    expect(succeeded).toMatchObject({ status: "succeeded", exitCode: 0, jobType: "app-upload" });
    expect(calls[1]!.fields["resumeAppId"]).toBeNull();
  });
});
