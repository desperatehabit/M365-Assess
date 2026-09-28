// Tests for the Intune app upload queue routes and job runner (T-0323).
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import { SqliteAppDeploymentRepository } from "../repository/app-deployments.js";
import type { RequestContext } from "../server.js";
import { AppPackageStore } from "../storage/app-packages.js";
import {
  APP_UPLOAD_ENTRYPOINT,
  INTUNE_APPS_QUEUE_PATH,
  INTUNE_APPS_QUEUE_RERUN_PATH,
  INTUNE_APPS_UPLOAD_PATH,
  createIntuneAppsQueueRoutes,
  parseAppUploadRequest,
  planAppUpload,
  runAppUploadJob,
  type AppUploadCaller,
  type AppUploadJob,
  type AppUploadProgress,
  type IntuneAppsQueueRoutesOptions,
  type RunAppUploadJobOptions,
} from "./intune-apps-queue.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const T0 = new Date("2026-09-28T12:00:00.000Z");
const SECRET = "s".repeat(32);

function migration(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../db/migrations/${name}`, import.meta.url)), "utf8");
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function harness(overrides: Partial<IntuneAppsQueueRoutesOptions> = {}) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(migration("0001_init.sql"));
  db.exec(migration("0082_app_deployments.sql"));
  const seed = db.prepare(
    `INSERT INTO tenants (id, source, status, excluded, errorCount, createdAt, updatedAt)
     VALUES (?, 'direct', 'active', 0, 0, ?, ?)`,
  );
  seed.run(TENANT, T0.toISOString(), T0.toISOString());
  seed.run(OTHER, T0.toISOString(), T0.toISOString());
  const root = mkdtempSync(path.join(tmpdir(), "app-queue-"));
  cleanups.push(() => db.close(), () => rmSync(root, { recursive: true, force: true }));

  let n = 0;
  const newId = () => `id-${++n}`;
  const repository = new SqliteAppDeploymentRepository(db, 82);
  const packages = new AppPackageStore({ artifactRoot: root, signingSecret: SECRET, now: () => T0, newId: () => "pkg-1" });
  await packages.storePackage(TENANT, "7zip.intunewin", Readable.from([Buffer.from("encrypted-bytes")]));

  const enqueued: AppUploadJob[] = [];
  const audits: Array<Record<string, unknown>> = [];
  let caller: AppUploadCaller | undefined = {
    userId: "operator-1",
    permissions: ["Endpoint.Application.ReadWrite"],
    tenantScope: tenantScope([TENANT]),
  };
  const routes = createIntuneAppsQueueRoutes({
    repository,
    packages,
    queue: { enqueue: async (job) => (enqueued.push(job), job.jobId) },
    resolveCaller: () => caller,
    recordAudit: async (e) => void audits.push(e),
    now: () => T0,
    newId,
    ...overrides,
  });
  const route = (method: string, p: string) => routes.find((r) => r.method === method && r.path === p)!;
  return {
    db,
    repository,
    packages,
    enqueued,
    audits,
    upload: route("POST", INTUNE_APPS_UPLOAD_PATH),
    queue: route("GET", INTUNE_APPS_QUEUE_PATH),
    rerun: route("POST", INTUNE_APPS_QUEUE_RERUN_PATH),
    setCaller: (c: AppUploadCaller | undefined) => {
      caller = c;
    },
  };
}

function ctx(options: { body?: unknown; query?: Record<string, string>; params?: Record<string, string> } = {}): RequestContext {
  return {
    correlationId: "corr-1",
    method: "POST",
    path: "/",
    params: { tenantId: TENANT, ...options.params },
    query: new URLSearchParams(options.query ?? {}),
    headers: {},
    ...(options.body !== undefined ? { body: options.body } : {}),
  };
}

const WIN32 = {
  appType: "win32",
  packageId: "pkg-1",
  displayName: "7-Zip",
  publisher: "Igor Pavlov",
  installCommandLine: "7z.exe /S",
  uninstallCommandLine: "uninstall.exe /S",
  detectionRules: [{ type: "file", path: "C:\\Program Files\\7-Zip", fileOrFolderName: "7z.exe" }],
};

const STORE = {
  appType: "store",
  packageIdentifier: "9WZDNCRFJ3PZ",
  displayName: "Company Portal",
  publisher: "Microsoft",
};

describe("parseAppUploadRequest (T-0323)", () => {
  it("fills win32 defaults", () => {
    expect(parseAppUploadRequest(WIN32)).toMatchObject({
      runAsAccount: "system",
      deviceRestartBehavior: "basedOnReturnCode",
      applicableArchitectures: ["x64"],
      minimumSupportedWindowsRelease: "1607",
    });
  });

  it.each([
    ["no appType", { ...WIN32, appType: undefined }, /appType/],
    ["no package", { ...WIN32, packageId: "" }, /packageId/],
    ["no detection rule", { ...WIN32, detectionRules: [] }, /detection rule/],
    ["an unknown detection type", { ...WIN32, detectionRules: [{ type: "wmi" }] }, /type must be/],
    ["an unknown architecture", { ...WIN32, applicableArchitectures: ["ia64"] }, /applicableArchitectures/],
    ["an unknown run-as account", { ...WIN32, runAsAccount: "admin" }, /runAsAccount/],
    ["a store app without an identifier", { ...STORE, packageIdentifier: " " }, /packageIdentifier/],
  ])("rejects a request with %s", (_label, body, message) => {
    expect(() => parseAppUploadRequest(body)).toThrow(message);
  });

  it("returns 501 for a known but unsupported type", () => {
    expect(() => parseAppUploadRequest({ ...STORE, appType: "office" })).toThrow(
      expect.objectContaining({ status: 501, code: "intune.app-type.unsupported" }),
    );
  });

  it("plans the Graph content-upload sequence for win32 and a single create for store", () => {
    expect(planAppUpload(parseAppUploadRequest(WIN32))).toEqual([
      "createApp",
      "downloadPackage",
      "createContentVersion",
      "createContentFile",
      "uploadContent",
      "commitContentFile",
      "setCommittedContentVersion",
    ]);
    expect(planAppUpload(parseAppUploadRequest(WIN32), "app-1")[0]).toBe("reuseApp");
    expect(planAppUpload(parseAppUploadRequest(STORE))).toEqual(["createApp"]);
  });
});

describe("POST /v1/tenants/:tenantId/apps/upload (T-0323)", () => {
  it("queues a win32 upload, returns a deployment id, and audits it", async () => {
    const h = await harness();
    const res = await h.upload.handler(ctx({ body: WIN32 }));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ deploymentId: "id-1", jobId: "id-3", state: "queued" });
    expect(h.enqueued).toEqual([{ jobId: "id-3", tenantId: TENANT, deploymentId: "id-1", correlationId: "corr-1" }]);
    const row = await h.repository.getDeployment(TENANT, "id-1");
    expect(row).toMatchObject({ state: "queued", appType: "win32", createdBy: "operator-1" });
    expect(row!.payload).toMatchObject({ packageId: "pkg-1", displayName: "7-Zip" });
    expect(h.audits).toEqual([
      expect.objectContaining({ action: "intune.app.upload.queued", targetId: "id-1", actor: "operator-1", to: "queued" }),
    ]);
  });

  it("queues a store app without a package", async () => {
    const h = await harness();
    const res = await h.upload.handler(ctx({ body: STORE }));
    expect(res.status).toBe(202);
    expect((res.body as { steps: string[] }).steps).toEqual(["createApp"]);
  });

  it("previews the plan without persisting or queueing", async () => {
    const h = await harness();
    const res = await h.upload.handler(ctx({ body: { ...WIN32, preview: true } }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ preview: true, package: { fileName: "7zip.intunewin", size: 15 } });
    expect(JSON.stringify(res.body)).not.toMatch(/app-packages|sig=/);
    expect(h.enqueued).toHaveLength(0);
    expect(await h.repository.listDeployments(TENANT)).toEqual([]);
  });

  it("returns 404 for a package that is not on the artifact tier", async () => {
    const h = await harness();
    await expect(h.upload.handler(ctx({ body: { ...WIN32, packageId: "pkg-9" } }))).rejects.toMatchObject({
      status: 404,
      code: "app-upload.package_not_found",
    });
  });

  it("will not read another tenant's package", async () => {
    const h = await harness();
    h.setCaller({ userId: "u", permissions: ["*"], tenantScope: tenantScope([OTHER]) });
    await expect(
      h.upload.handler(ctx({ body: WIN32, params: { tenantId: OTHER } })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a payload that carries credentials", async () => {
    const h = await harness();
    await expect(
      h.upload.handler(ctx({ body: { ...WIN32, detectionRules: [{ type: "script", clientSecret: "x" }] } })),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.enqueued).toHaveLength(0);
  });

  it("requires the write permission or Remediation.Apply", async () => {
    const h = await harness();
    h.setCaller({ userId: "u", permissions: ["Endpoint.Application.Read"], tenantScope: tenantScope([TENANT]) });
    await expect(h.upload.handler(ctx({ body: WIN32 }))).rejects.toMatchObject({ status: 403 });
    h.setCaller({ userId: "u", permissions: ["Remediation.Apply"], tenantScope: tenantScope([TENANT]) });
    await expect(h.upload.handler(ctx({ body: WIN32 }))).resolves.toMatchObject({ status: 202 });
  });

  it("rejects an unauthenticated caller and a tenant outside scope", async () => {
    const h = await harness();
    h.setCaller(undefined);
    await expect(h.upload.handler(ctx({ body: WIN32 }))).rejects.toMatchObject({ status: 401 });
    h.setCaller({ userId: "u", permissions: ["*"], tenantScope: tenantScope([OTHER]) });
    await expect(h.upload.handler(ctx({ body: WIN32 }))).rejects.toMatchObject({ status: 403 });
  });
});

describe("GET /v1/tenants/:tenantId/apps/queue (T-0323)", () => {
  it("reports per-item state from the persisted rows", async () => {
    const h = await harness();
    await h.upload.handler(ctx({ body: WIN32 }));
    await h.repository.transitionDeployment(TENANT, "id-1", "failed", T0.toISOString(), {
      appId: "app-9",
      steps: [{ step: "createApp", status: "succeeded" }, { step: "uploadContent", status: "failed", error: "timeout" }],
      error: "timeout",
    });
    const res = await h.queue.handler(ctx());
    expect(res.body).toEqual({
      tenantId: TENANT,
      totalCount: 1,
      items: [
        {
          deploymentId: "id-1",
          appType: "win32",
          displayName: "7-Zip",
          state: "failed",
          rerunnable: true,
          appId: "app-9",
          steps: [
            { step: "createApp", status: "succeeded" },
            { step: "uploadContent", status: "failed", error: "timeout" },
          ],
          error: "timeout",
          createdBy: "operator-1",
          createdAt: T0.toISOString(),
          updatedAt: T0.toISOString(),
        },
      ],
    });
  });

  it("filters by state and rejects an unknown one", async () => {
    const h = await harness();
    await h.upload.handler(ctx({ body: WIN32 }));
    expect((await h.queue.handler(ctx({ query: { state: "failed" } }))).body).toMatchObject({ totalCount: 0 });
    await expect(h.queue.handler(ctx({ query: { state: "done" } }))).rejects.toMatchObject({ status: 400 });
  });

  it("lets a read-only caller see the queue", async () => {
    const h = await harness();
    h.setCaller({ userId: "u", permissions: ["Endpoint.Application.Read"], tenantScope: tenantScope([TENANT]) });
    await expect(h.queue.handler(ctx())).resolves.toMatchObject({ status: 200 });
    h.setCaller({ userId: "u", permissions: ["Endpoint.Intune.Read"], tenantScope: tenantScope([TENANT]) });
    await expect(h.queue.handler(ctx())).rejects.toMatchObject({ status: 403 });
  });
});

describe("POST /v1/tenants/:tenantId/apps/queue/:deploymentId/rerun (T-0323)", () => {
  it("re-queues a failed item and audits the move", async () => {
    const h = await harness();
    await h.upload.handler(ctx({ body: WIN32 }));
    await h.repository.transitionDeployment(TENANT, "id-1", "failed", T0.toISOString(), { error: "x" });
    const res = await h.rerun.handler(ctx({ params: { deploymentId: "id-1" } }));
    expect(res).toMatchObject({ status: 202, body: { deploymentId: "id-1", state: "queued" } });
    expect(h.enqueued).toHaveLength(2);
    expect(h.audits.at(-1)).toMatchObject({ action: "intune.app.upload.rerun", from: "failed", to: "queued" });
  });

  it("refuses to re-run an item that has not failed", async () => {
    const h = await harness();
    await h.upload.handler(ctx({ body: WIN32 }));
    await expect(h.rerun.handler(ctx({ params: { deploymentId: "id-1" } }))).rejects.toMatchObject({
      status: 409,
      code: "app-upload.not_rerunnable",
    });
    await expect(h.rerun.handler(ctx({ params: { deploymentId: "nope" } }))).rejects.toMatchObject({ status: 404 });
  });
});

describe("runAppUploadJob (T-0323)", () => {
  async function queued(body: Record<string, unknown> = WIN32) {
    const h = await harness();
    await h.upload.handler(ctx({ body }));
    const job = h.enqueued[0]!;
    const progress: AppUploadProgress[] = [];
    const workerCalls: Array<{ entrypoint: string; job: Record<string, unknown> }> = [];
    const run = (worker: (job: Record<string, unknown>) => unknown, extra: Partial<RunAppUploadJobOptions> = {}) =>
      runAppUploadJob(job, {
        repository: h.repository,
        packages: h.packages,
        packageBaseUrl: "http://127.0.0.1:8080",
        runWorker: async (entrypoint, workerJob) => {
          workerCalls.push({ entrypoint, job: workerJob });
          return worker(workerJob);
        },
        onProgress: (e) => progress.push(e),
        recordAudit: async (e) => void h.audits.push(e),
        now: () => T0,
        ...extra,
      });
    return { h, job, progress, workerCalls, run };
  }

  it("walks the row through every queue state on success and records results", async () => {
    const { h, progress, workerCalls, run } = await queued();
    const final = await run(() => ({
      state: "succeeded",
      appId: "app-1",
      contentVersionId: "1",
      steps: [{ step: "createApp", status: "succeeded" }],
      auditEvents: [{ action: "intune.app.create", targetId: "app-1" }],
    }));
    expect(final).toMatchObject({ state: "succeeded", results: { appId: "app-1", contentVersionId: "1" } });
    expect(progress.map((p) => p.state)).toEqual(["uploading", "committing", "succeeded"]);
    expect(workerCalls[0]!.entrypoint).toBe(APP_UPLOAD_ENTRYPOINT);
    const actions = h.audits.map((a) => a.action);
    expect(actions).toContain("intune.app.create");
    expect(actions.filter((a) => String(a).startsWith("intune.app.upload."))).toEqual([
      "intune.app.upload.queued",
      "intune.app.upload.uploading",
      "intune.app.upload.committing",
      "intune.app.upload.succeeded",
    ]);
  });

  it("hands the worker an absolute signed URL, never a path, and keeps it out of progress and results", async () => {
    const { h, progress, workerCalls, run } = await queued();
    const final = await run(() => ({ state: "succeeded", appId: "app-1" }));
    const url = new URL(String(workerCalls[0]!.job["packageUrl"]));
    expect(url.origin).toBe("http://127.0.0.1:8080");
    expect(url.pathname).toBe("/v1/app-packages/pkg-1");
    expect(h.packages.verifySignedUrl("pkg-1", url.searchParams)).toEqual({ tenantId: TENANT, packageId: "pkg-1" });
    expect(workerCalls[0]!.job).toMatchObject({ packageSize: 15, appType: "win32", resumeAppId: null });
    const leaked = JSON.stringify([progress, final, h.audits]);
    expect(leaked).not.toContain("sig=");
    expect(leaked).not.toContain("encrypted-bytes");
  });

  it("does not sign anything for a store app", async () => {
    const { workerCalls, run } = await queued(STORE);
    await run(() => ({ state: "succeeded", appId: "app-2" }));
    expect(workerCalls[0]!.job["packageUrl"]).toBeUndefined();
  });

  it("marks the row failed with the worker's steps and error", async () => {
    const { progress, run } = await queued();
    const final = await run(() => ({
      state: "failed",
      appId: "app-1",
      steps: [{ step: "uploadContent", status: "failed", error: "block upload timed out" }],
      error: "block upload timed out",
    }));
    expect(final).toMatchObject({ state: "failed", results: { appId: "app-1", error: "block upload timed out" } });
    expect(progress.at(-1)).toMatchObject({ state: "failed", message: "block upload timed out" });
  });

  it("fails the row when the worker throws or prints nothing usable", async () => {
    const a = await queued();
    expect(await a.run(() => { throw new Error("pwsh exited 1"); })).toMatchObject({
      state: "failed",
      results: { error: "pwsh exited 1" },
    });
    const b = await queued();
    expect(await b.run(() => "not json")).toMatchObject({ state: "failed", results: { error: "worker returned no result" } });
  });

  it("fails the row when the package has gone from the artifact tier", async () => {
    const { h, workerCalls, run } = await queued();
    await h.packages.deletePackage(TENANT, "pkg-1");
    expect(await run(() => ({ state: "succeeded" }))).toMatchObject({ state: "failed" });
    expect(workerCalls).toHaveLength(0);
  });

  it("re-runs a failed item against the same Graph app", async () => {
    const { h, job, workerCalls, run } = await queued();
    await run(() => ({ state: "failed", appId: "app-1", error: "commit failed" }));
    await h.rerun.handler(ctx({ params: { deploymentId: job.deploymentId } }));
    const final = await run(() => ({ state: "succeeded", appId: "app-1", contentVersionId: "2" }));
    expect(workerCalls[1]!.job["resumeAppId"]).toBe("app-1");
    expect(final).toMatchObject({ state: "succeeded", results: { appId: "app-1", contentVersionId: "2" } });
  });

  it("leaves a row that is no longer queued alone", async () => {
    const { h, job, workerCalls, run } = await queued();
    await h.repository.transitionDeployment(TENANT, job.deploymentId, "cancelled", T0.toISOString());
    expect(await run(() => ({ state: "succeeded" }))).toMatchObject({ state: "cancelled" });
    expect(workerCalls).toHaveLength(0);
  });
});
