// Tests for the application template routes and repository (T-0327).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import { SqliteAppDeploymentRepository } from "../repository/app-deployments.js";
import { SqliteApplicationTemplateRepository } from "../repository/application-templates.js";
import type { RequestContext } from "../server.js";
import { AppPackageStore } from "../storage/app-packages.js";
import type { AppUploadJob } from "./intune-apps-queue.js";
import {
  APP_TEMPLATES_PATH,
  APP_TEMPLATE_DEPLOY_PATH,
  APP_TEMPLATE_PATH,
  createApplicationTemplateRoutes,
  resolveTemplateValues,
  templateTokens,
  type AppTemplateCaller,
  type ApplicationTemplateRoutesOptions,
  type TemplatePreflightResult,
  type TemplateVariableScopes,
} from "./application-templates.js";

const T1 = "11111111-1111-1111-1111-111111111111";
const T2 = "22222222-2222-2222-2222-222222222222";
const T3 = "33333333-3333-3333-3333-333333333333";
const NOW = new Date("2026-09-28T12:00:00.000Z");

function migration(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../db/migrations/${name}`, import.meta.url)), "utf8");
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const WIN32_CONFIG = {
  displayName: "%AppName% (%Ring%)",
  publisher: "Igor Pavlov",
  packageId: "%SevenZipPackage%",
  installCommandLine: "7z.exe /S",
  uninstallCommandLine: "uninstall.exe /S",
  detectionRules: [{ type: "file", path: "C:\\Program Files\\7-Zip", fileOrFolderName: "7z.exe" }],
};

/** A stand-in for deploy-application-template.ps1: substitutes with the same token rule. */
function substituteLikeWorker(config: unknown, values: Record<string, string>): unknown {
  if (typeof config === "string") return config.replace(/%([A-Za-z0-9_][A-Za-z0-9_.-]*)%/g, (m, n: string) => values[n] ?? m);
  if (Array.isArray(config)) return config.map((c) => substituteLikeWorker(c, values));
  if (config && typeof config === "object") {
    return Object.fromEntries(Object.entries(config).map(([k, v]) => [k, substituteLikeWorker(v, values)]));
  }
  return config;
}

async function harness(overrides: Partial<ApplicationTemplateRoutesOptions> = {}) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(migration("0001_init.sql"));
  db.exec(migration("0082_app_deployments.sql"));
  db.exec(migration("0083_application_templates.sql"));
  const seed = db.prepare(
    `INSERT INTO tenants (id, source, status, excluded, errorCount, createdAt, updatedAt) VALUES (?, 'direct', 'active', 0, 0, ?, ?)`,
  );
  for (const t of [T1, T2, T3]) seed.run(t, NOW.toISOString(), NOW.toISOString());
  const root = mkdtempSync(path.join(tmpdir(), "app-templates-"));
  cleanups.push(() => db.close(), () => rmSync(root, { recursive: true, force: true }));

  let pkgN = 0;
  const packages = new AppPackageStore({ artifactRoot: root, signingSecret: "k".repeat(32), newId: () => `pkg-${++pkgN}` });
  await packages.storePackage(T1, "7zip.intunewin", Readable.from([Buffer.from("x")]));
  await packages.storePackage(T2, "7zip.intunewin", Readable.from([Buffer.from("y")]));

  const variables: Record<string, TemplateVariableScopes> = {};
  const globals = [{ name: "AppName", value: "7-Zip", isSecret: false }];
  variables[T1] = { global: globals, tenant: [{ name: "SevenZipPackage", value: "pkg-1", isSecret: false }] };
  variables[T2] = { global: globals, tenant: [{ name: "SevenZipPackage", value: "pkg-2", isSecret: false }, { name: "Ring", value: "Broad", isSecret: false }] };
  variables[T3] = { global: globals, tenant: [] };

  const preflightCalls: Array<{ tenantId: string; values: Record<string, string> }> = [];
  const existing: Record<string, string> = {};
  const enqueued: AppUploadJob[] = [];
  const audits: Array<Record<string, unknown>> = [];
  let n = 0;
  let caller: AppTemplateCaller | undefined = {
    userId: "operator-1",
    permissions: ["Endpoint.Application.ReadWrite"],
    tenantScope: tenantScope([T1, T2, T3]),
  };
  const templates = new SqliteApplicationTemplateRepository(db, 83);
  const deployments = new SqliteAppDeploymentRepository(db, 82);
  const routes = createApplicationTemplateRoutes({
    templates,
    deployments,
    packages,
    queue: { enqueue: async (job) => (enqueued.push(job), job.jobId) },
    preflight: {
      preflight: async (tenantId, config, values): Promise<TemplatePreflightResult> => {
        preflightCalls.push({ tenantId, values });
        const request = substituteLikeWorker(config, values) as Record<string, unknown>;
        const existingAppId = existing[tenantId] ?? null;
        return { tenantId, request, conflict: existingAppId !== null, existingAppId, issues: [] };
      },
    },
    variables: async (tenantId) => variables[tenantId] ?? { global: [], tenant: [] },
    resolveCaller: () => caller,
    recordAudit: async (e) => void audits.push(e),
    now: () => NOW,
    newId: () => `id-${++n}`,
    ...overrides,
  });
  const route = (method: string, p: string) => routes.find((r) => r.method === method && r.path === p)!;
  return {
    templates,
    deployments,
    variables,
    existing,
    preflightCalls,
    enqueued,
    audits,
    list: route("GET", APP_TEMPLATES_PATH),
    create: route("POST", APP_TEMPLATES_PATH),
    get: route("GET", APP_TEMPLATE_PATH),
    patch: route("PATCH", APP_TEMPLATE_PATH),
    remove: route("DELETE", APP_TEMPLATE_PATH),
    deploy: route("POST", APP_TEMPLATE_DEPLOY_PATH),
    setCaller: (c: AppTemplateCaller | undefined) => {
      caller = c;
    },
  };
}

function ctx(body?: unknown, params: Record<string, string> = {}): RequestContext {
  return { correlationId: "corr", method: "POST", path: "/", params, query: new URLSearchParams(), headers: {}, ...(body !== undefined ? { body } : {}) };
}

const TEMPLATE_BODY = {
  name: "7-Zip ring deploy",
  appType: "win32",
  config: WIN32_CONFIG,
  variables: [{ name: "Ring", description: "Deployment ring", defaultValue: "Pilot" }, { name: "SevenZipPackage" }],
};

async function withTemplate() {
  const h = await harness();
  const created = await h.create.handler(ctx(TEMPLATE_BODY));
  return { h, id: (created.body as { id: string }).id };
}

describe("template tokens and values (T-0327)", () => {
  it("collects tokens from every string in the config", () => {
    expect(templateTokens(WIN32_CONFIG)).toEqual(["AppName", "Ring", "SevenZipPackage"]);
  });

  it("layers template default < global < tenant < request override", () => {
    const template = { config: { a: "%A%", b: "%B%", c: "%C%", d: "%D%" }, variables: [{ name: "A", defaultValue: "default" }, { name: "B", defaultValue: "default" }, { name: "C", defaultValue: "default" }, { name: "D", defaultValue: "default" }] };
    const scopes = {
      global: [{ name: "B", value: "global", isSecret: false }, { name: "C", value: "global", isSecret: false }, { name: "D", value: "global", isSecret: false }],
      tenant: [{ name: "C", value: "tenant", isSecret: false }, { name: "D", value: "tenant", isSecret: false }],
    };
    expect(resolveTemplateValues(template, scopes, { D: "override" })).toEqual({
      values: { A: "default", B: "global", C: "tenant", D: "override" },
      missing: [],
      secret: [],
    });
  });

  it("reports unknown tokens and refuses secret variables", () => {
    const template = { config: { a: "%Missing%", b: "%Key%" }, variables: [] };
    const scopes = { global: [], tenant: [{ name: "Key", value: "s3cret", isSecret: true }] };
    const result = resolveTemplateValues(template, scopes);
    expect(result).toEqual({ values: {}, missing: ["Missing"], secret: ["Key"] });
    expect(JSON.stringify(result)).not.toContain("s3cret");
  });
});

describe("application template CRUD (T-0327)", () => {
  it("creates, reads, lists, updates, and deletes, round-tripping the §5 fields with audit", async () => {
    const { h, id } = await withTemplate();
    const read = (await h.get.handler(ctx(undefined, { id }))).body as Record<string, unknown>;
    expect(read).toMatchObject({ id, name: "7-Zip ring deploy", appType: "win32", config: WIN32_CONFIG, variables: TEMPLATE_BODY.variables, createdBy: "operator-1" });
    expect(read["tokens"]).toEqual(["AppName", "Ring", "SevenZipPackage"]);
    expect((await h.list.handler(ctx())).body).toMatchObject({ totalCount: 1 });

    const patched = await h.patch.handler(ctx({ name: "7-Zip broad" }, { id }));
    expect(patched.body).toMatchObject({ name: "7-Zip broad", config: WIN32_CONFIG });

    expect((await h.remove.handler(ctx(undefined, { id }))).status).toBe(204);
    await expect(h.get.handler(ctx(undefined, { id }))).rejects.toMatchObject({ status: 404 });
    expect(h.audits.map((a) => a.action)).toEqual(["intune.app.template.create", "intune.app.template.update", "intune.app.template.delete"]);
  });

  it.each([
    ["an unknown app type", { appType: "msi" }, "appType"],
    ["an unsupported app type", { appType: "office" }, "appType"],
    ["a config that is not an object", { config: "x" }, "config"],
    ["a config carrying credentials", { config: { ...WIN32_CONFIG, runAs: { password: "p" } } }, "config"],
    ["a bad variable name", { variables: [{ name: "bad name" }] }, "variables"],
    ["a duplicate variable", { variables: [{ name: "A" }, { name: "A" }] }, "variables"],
    ["no name", { name: " " }, "name"],
  ])("rejects %s with a structured 400", async (_label, patch, field) => {
    const h = await harness();
    await expect(h.create.handler(ctx({ ...TEMPLATE_BODY, ...patch }))).rejects.toMatchObject({
      status: 400,
      code: "request.validation_failed",
      details: [{ field, reason: "invalid" }],
    });
  });

  it("rejects a duplicate name, case-insensitively, with 409", async () => {
    const { h } = await withTemplate();
    await expect(h.create.handler(ctx({ ...TEMPLATE_BODY, name: "7-ZIP RING DEPLOY" }))).rejects.toMatchObject({ status: 409 });
  });

  it("validates a patch too", async () => {
    const { h, id } = await withTemplate();
    await expect(h.patch.handler(ctx({ appType: "edge" }, { id }))).rejects.toMatchObject({ status: 400 });
  });

  it("lets read-only callers read but not write", async () => {
    const { h, id } = await withTemplate();
    h.setCaller({ userId: "u", permissions: ["Endpoint.Application.Read"], tenantScope: tenantScope([T1]) });
    await expect(h.get.handler(ctx(undefined, { id }))).resolves.toMatchObject({ status: 200 });
    await expect(h.remove.handler(ctx(undefined, { id }))).rejects.toMatchObject({ status: 403 });
    await expect(h.deploy.handler(ctx({ targets: [T1] }, { id }))).rejects.toMatchObject({ status: 403 });
    h.setCaller(undefined);
    await expect(h.list.handler(ctx())).rejects.toMatchObject({ status: 401 });
  });
});

describe("POST /v1/app-templates/:id/deploy (T-0327)", () => {
  it("previews each tenant's substituted request without queueing", async () => {
    const { h, id } = await withTemplate();
    const res = await h.deploy.handler(ctx({ targets: [T1, T2], preview: true }, { id }));
    expect(res.body).toMatchObject({
      preview: true,
      summary: { planned: 2, failed: 0 },
      results: [
        { tenantId: T1, state: "planned", request: { displayName: "7-Zip (Pilot)", packageId: "pkg-1" } },
        { tenantId: T2, state: "planned", request: { displayName: "7-Zip (Broad)", packageId: "pkg-2" } },
      ],
    });
    expect(h.enqueued).toHaveLength(0);
    expect(await h.deployments.listDeployments(T1)).toEqual([]);
  });

  it("queues one deployment per tenant with per-target results and audit", async () => {
    const { h, id } = await withTemplate();
    const res = await h.deploy.handler(ctx({ targets: [T1, T2], confirmTargetCount: 2 }, { id }));
    const body = res.body as { summary: unknown; results: Array<{ tenantId: string; state: string; deploymentId: string }> };
    expect(body.summary).toEqual({ queued: 2, failed: 0 });
    for (const r of body.results) {
      const row = await h.deployments.getDeployment(r.tenantId, r.deploymentId);
      expect(row).toMatchObject({ state: "queued", appType: "win32", payload: { templateId: id } });
    }
    expect((await h.deployments.listDeployments(T2))[0]!.payload).toMatchObject({ displayName: "7-Zip (Broad)", packageId: "pkg-2" });
    expect(h.enqueued.map((j) => j.tenantId)).toEqual([T1, T2]);
    const deployAudits = h.audits.filter((a) => a.action === "intune.app.template.deploy");
    expect(deployAudits).toHaveLength(2);
    expect(deployAudits[0]).toMatchObject({ before: null, after: { displayName: "7-Zip (Pilot)" }, templateId: id });
  });

  it("reports a partial failure without failing the other targets", async () => {
    const { h, id } = await withTemplate();
    // T3 has no package variable; T2 already has an app of that name.
    h.existing[T2] = "app-9";
    const res = await h.deploy.handler(ctx({ targets: [T1, T2, T3], confirmTargetCount: 3 }, { id }));
    const body = res.body as { summary: unknown; results: Array<{ tenantId: string; state: string; error?: string }> };
    expect(body.summary).toEqual({ queued: 1, failed: 2 });
    expect(body.results[0]).toMatchObject({ tenantId: T1, state: "queued" });
    expect(body.results[1]!.error).toMatch(/already exists.*app-9/);
    expect(body.results[2]!.error).toMatch(/unknown tenant variable.*%SevenZipPackage%/);
    expect(h.enqueued).toHaveLength(1);
  });

  it("refuses a secret tenant variable without passing it to the worker", async () => {
    const { h, id } = await withTemplate();
    h.variables[T1] = { global: [], tenant: [{ name: "SevenZipPackage", value: "pkg-1", isSecret: false }, { name: "AppName", value: "hidden-value", isSecret: true }] };
    const res = await h.deploy.handler(ctx({ targets: [T1] }, { id }));
    expect((res.body as { results: Array<{ error: string }> }).results[0]!.error).toMatch(/secret variables.*%AppName%/);
    expect(h.preflightCalls).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain("hidden-value");
  });

  it("lets request values override tenant variables", async () => {
    const { h, id } = await withTemplate();
    const res = await h.deploy.handler(ctx({ targets: [T1], values: { Ring: "Canary" }, preview: true }, { id }));
    expect((res.body as { results: Array<{ request: Record<string, unknown> }> }).results[0]!.request["displayName"]).toBe("7-Zip (Canary)");
  });

  it("fails a target whose package is not on that tenant's artifact tier", async () => {
    const { h, id } = await withTemplate();
    const res = await h.deploy.handler(ctx({ targets: [T1], values: { SevenZipPackage: "pkg-2" } }, { id }));
    expect((res.body as { results: Array<{ error: string }> }).results[0]!.error).toMatch(/not on this tenant's artifact tier/);
  });

  it("fails a target whose substituted request is not a valid upload", async () => {
    const { h, id } = await withTemplate();
    await h.patch.handler(ctx({ config: { ...WIN32_CONFIG, installCommandLine: "" } }, { id }));
    const res = await h.deploy.handler(ctx({ targets: [T1] }, { id }));
    expect((res.body as { results: Array<{ state: string; error: string }> }).results[0]).toMatchObject({ state: "failed", error: expect.stringMatching(/installCommandLine/) });
  });

  it("requires the target count to be confirmed for a multi-tenant apply", async () => {
    const { h, id } = await withTemplate();
    await expect(h.deploy.handler(ctx({ targets: [T1, T2] }, { id }))).rejects.toMatchObject({ status: 400 });
    await expect(h.deploy.handler(ctx({ targets: [T1, T2], confirmTargetCount: 3 }, { id }))).rejects.toMatchObject({ status: 400 });
    expect(h.enqueued).toHaveLength(0);
  });

  it("rejects targets outside the caller's scope before any work", async () => {
    const { h, id } = await withTemplate();
    h.setCaller({ userId: "u", permissions: ["Remediation.Apply"], tenantScope: tenantScope([T1]) });
    await expect(h.deploy.handler(ctx({ targets: [T1, T2], confirmTargetCount: 2 }, { id }))).rejects.toMatchObject({ status: 403 });
    expect(h.preflightCalls).toHaveLength(0);
  });

  it("returns 404 for an unknown template and 400 without targets", async () => {
    const { h, id } = await withTemplate();
    await expect(h.deploy.handler(ctx({ targets: [T1] }, { id: "nope" }))).rejects.toMatchObject({ status: 404 });
    await expect(h.deploy.handler(ctx({ targets: [] }, { id }))).rejects.toMatchObject({ status: 400 });
  });
});
