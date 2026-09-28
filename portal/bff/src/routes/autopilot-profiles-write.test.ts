// Tests for Autopilot deployment profile write routes (T-0845).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import { SqliteAutopilotProfileTemplateRepository } from "../repository/autopilot-profiles.js";
import type { RequestContext } from "../server.js";
import {
  AUTOPILOT_PROFILES_WRITE_PATH,
  AUTOPILOT_PROFILE_ASSIGNMENTS_PATH,
  AUTOPILOT_PROFILE_WRITE_PATH,
  AUTOPILOT_TEMPLATE_DEPLOY_PATH,
  createAutopilotProfileWriteRoutes,
  validatePartialProfile,
  type AutopilotProfileWorkerError,
  type AutopilotProfileWriteRequest,
  type AutopilotProfileWriteResult,
  type AutopilotWriteCaller,
} from "./autopilot-profiles-write.js";

const T1 = "11111111-1111-1111-1111-111111111111";
const T2 = "22222222-2222-2222-2222-222222222222";
const G1 = "aaaaaaaa-0000-0000-0000-000000000001";
const G2 = "aaaaaaaa-0000-0000-0000-000000000002";
const PROFILE = { "@odata.type": "#microsoft.graph.azureADWindowsAutopilotDeploymentProfile", displayName: "Standard user", deviceNameTemplate: "CORP-%SERIAL%" };

const openDbs: Database.Database[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

async function harness() {
  const db = new Database(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../../../db/migrations/0084_autopilot_profile_templates.sql", import.meta.url)), "utf8"));
  openDbs.push(db);
  const templates = new SqliteAutopilotProfileTemplateRepository(db, 84);
  await templates.create({ id: "tpl-1", name: "Standard", profileJson: PROFILE, groupTag: "Sales", createdBy: "u", createdAt: "2026-09-28T00:00:00Z" });
  const writes: Array<{ tenantId: string; request: AutopilotProfileWriteRequest }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const failFor = new Map<string, AutopilotProfileWorkerError>();
  let caller: AutopilotWriteCaller | undefined = { userId: "operator-1", permissions: ["Endpoint.Autopilot.ReadWrite"], tenantScope: tenantScope([T1, T2]) };
  const routes = createAutopilotProfileWriteRoutes({
    provider: {
      write: async (tenantId, request): Promise<AutopilotProfileWriteResult | AutopilotProfileWorkerError> => {
        writes.push({ tenantId, request });
        const failure = failFor.get(tenantId);
        if (failure) return failure;
        return {
          preview: request.preview,
          applied: !request.preview,
          profileId: request.profileId ?? "p-new",
          plan: { action: request.action, after: request.profile ?? null },
          auditEvent: request.preview ? null : { action: `intune.autopilot.profile.${request.action}`, tenantId, actor: request.actor },
        };
      },
    },
    templates,
    resolveCaller: () => caller,
    recordAudit: async (e) => void audits.push(e),
  });
  const route = (method: string, p: string) => routes.find((r) => r.method === method && r.path === p)!;
  return {
    writes,
    audits,
    failFor,
    route,
    setCaller: (c: AutopilotWriteCaller | undefined) => {
      caller = c;
    },
  };
}

function ctx(body?: unknown, params: Record<string, string> = {}, query: Record<string, string> = {}): RequestContext {
  return { correlationId: "c", method: "POST", path: "/", params: { tenantId: T1, ...params }, query: new URLSearchParams(query), headers: {}, ...(body !== undefined ? { body } : {}) };
}

describe("validatePartialProfile (T-0845)", () => {
  it("accepts a partial change and rejects managed fields, a type change, an empty name, and credentials", () => {
    expect(validatePartialProfile({ deviceNameTemplate: "LAP-%RAND:5%" })).toEqual({ deviceNameTemplate: "LAP-%RAND:5%" });
    expect(() => validatePartialProfile({ id: "x" })).toThrow(/must not carry/);
    expect(() => validatePartialProfile({ "@odata.type": "#microsoft.graph.win32LobApp" })).toThrow(/@odata.type/);
    expect(() => validatePartialProfile({ displayName: " " })).toThrow(/displayName/);
    expect(() => validatePartialProfile({ domainJoin: { password: "p" } })).toThrow(/credentials/);
    expect(() => validatePartialProfile({})).toThrow(/no changes/);
  });
});

describe("tenant profile writes (T-0845)", () => {
  it("creates from a body, validated, and records the audit event", async () => {
    const h = await harness();
    const res = await h.route("POST", AUTOPILOT_PROFILES_WRITE_PATH).handler(ctx({ profile: PROFILE }));
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty("auditEvent");
    expect(h.writes[0]).toMatchObject({ tenantId: T1, request: { action: "create", profile: PROFILE, preview: false, actor: "operator-1" } });
    expect(h.audits).toEqual([{ action: "intune.autopilot.profile.create", tenantId: T1, actor: "operator-1" }]);
  });

  it("creates from a template and rejects an invalid body before the worker", async () => {
    const h = await harness();
    await h.route("POST", AUTOPILOT_PROFILES_WRITE_PATH).handler(ctx({ templateId: "tpl-1", preview: true }));
    expect(h.writes[0]!.request.profile).toEqual(PROFILE);
    await expect(h.route("POST", AUTOPILOT_PROFILES_WRITE_PATH).handler(ctx({ profile: { displayName: "x" } }))).rejects.toMatchObject({ status: 400 });
    await expect(h.route("POST", AUTOPILOT_PROFILES_WRITE_PATH).handler(ctx({ templateId: "nope" }))).rejects.toMatchObject({ status: 404 });
    expect(h.writes).toHaveLength(1);
  });

  it("updates with a partial body and previews without auditing", async () => {
    const h = await harness();
    const res = await h.route("PATCH", AUTOPILOT_PROFILE_WRITE_PATH).handler(ctx({ profile: { deviceNameTemplate: "LAP-%RAND:5%" }, preview: true }, { profileId: "p1" }));
    expect(res).toMatchObject({ status: 200, body: { preview: true } });
    expect(h.writes[0]!.request).toMatchObject({ action: "update", profileId: "p1", preview: true });
    expect(h.audits).toEqual([]);
  });

  it("maps the worker's refusal to delete an assigned profile", async () => {
    const h = await harness();
    h.failFor.set(T1, { error: "autopilot.profile.assigned", message: "profile 'Standard user' is assigned to 1 group(s)", statusCode: 409 });
    await expect(h.route("DELETE", AUTOPILOT_PROFILE_WRITE_PATH).handler(ctx(undefined, { profileId: "p1" }, { confirmName: "Standard user" }))).rejects.toMatchObject({
      status: 409,
      code: "autopilot.profile.assigned",
    });
    expect(h.writes[0]!.request).toMatchObject({ action: "delete", confirmName: "Standard user" });
  });

  it("changes assignments with normalised group ids and rejects bad input", async () => {
    const h = await harness();
    const assign = h.route("POST", AUTOPILOT_PROFILE_ASSIGNMENTS_PATH);
    await assign.handler(ctx({ add: [G1.toUpperCase(), G1], remove: [G2] }, { profileId: "p1" }));
    expect(h.writes[0]!.request).toMatchObject({ action: "assign", addGroupIds: [G1], removeGroupIds: [G2] });
    await expect(assign.handler(ctx({ add: ["Sales"] }, { profileId: "p1" }))).rejects.toMatchObject({ status: 400 });
    await expect(assign.handler(ctx({}, { profileId: "p1" }))).rejects.toMatchObject({ status: 400 });
    await expect(assign.handler(ctx({ add: [G1], remove: [G1] }, { profileId: "p1" }))).rejects.toMatchObject({ status: 400 });
  });

  it("returns 502 with the failure audited when Graph rejects the write", async () => {
    const h = await harness();
    h.failFor.clear();
    const routes = createAutopilotProfileWriteRoutes({
      provider: { write: async () => ({ preview: false, applied: false, plan: {}, error: "BadRequest", auditEvent: { result: "failure" } }) },
      templates: new SqliteAutopilotProfileTemplateRepository(openDbs[0]!, 84),
      resolveCaller: () => ({ userId: "u", permissions: ["*"], tenantScope: tenantScope([T1]) }),
      recordAudit: async (e) => void h.audits.push(e),
    });
    const patch = routes.find((r) => r.method === "PATCH")!;
    await expect(patch.handler(ctx({ profile: { description: "x" } }, { profileId: "p1" }))).rejects.toMatchObject({ status: 502 });
    expect(h.audits).toEqual([{ result: "failure" }]);
  });

  it("requires write permission or Remediation.Apply, and tenant scope", async () => {
    const h = await harness();
    const create = h.route("POST", AUTOPILOT_PROFILES_WRITE_PATH);
    h.setCaller({ userId: "u", permissions: ["Endpoint.Autopilot.Read"], tenantScope: tenantScope([T1]) });
    await expect(create.handler(ctx({ profile: PROFILE }))).rejects.toMatchObject({ status: 403 });
    h.setCaller({ userId: "u", permissions: ["Remediation.Apply"], tenantScope: tenantScope([T2]) });
    await expect(create.handler(ctx({ profile: PROFILE }))).rejects.toMatchObject({ status: 403 });
    h.setCaller(undefined);
    await expect(create.handler(ctx({ profile: PROFILE }))).rejects.toMatchObject({ status: 401 });
    expect(h.writes).toHaveLength(0);
  });
});

describe("POST /v1/autopilot/profile-templates/:id/deploy (T-0845)", () => {
  it("previews per tenant", async () => {
    const h = await harness();
    const res = await h.route("POST", AUTOPILOT_TEMPLATE_DEPLOY_PATH).handler(ctx({ targets: [T1, T2], preview: true }, { id: "tpl-1" }));
    expect(res.body).toMatchObject({ preview: true, summary: { planned: 2, failed: 0 } });
    expect(h.audits).toEqual([]);
  });

  it("requires the confirmed target count, then reports per-target results with a partial failure", async () => {
    const h = await harness();
    const deploy = h.route("POST", AUTOPILOT_TEMPLATE_DEPLOY_PATH);
    await expect(deploy.handler(ctx({ targets: [T1, T2] }, { id: "tpl-1" }))).rejects.toMatchObject({ status: 400 });
    expect(h.writes).toHaveLength(0);
    h.failFor.set(T2, { error: "autopilot.profile.exists", message: "an Autopilot profile named 'Standard user' already exists", statusCode: 409 });
    const res = await deploy.handler(ctx({ targets: [T1, T2], confirmTargetCount: 2 }, { id: "tpl-1" }));
    const body = res.body as { summary: unknown; results: Array<{ tenantId: string; state: string; error?: string }> };
    expect(body.summary).toEqual({ created: 1, failed: 1 });
    expect(body.results[0]).toMatchObject({ tenantId: T1, state: "created" });
    expect(body.results[1]).toMatchObject({ tenantId: T2, state: "failed", error: expect.stringMatching(/already exists/) });
    expect(h.audits).toHaveLength(1);
  });

  it("rejects a tenant outside scope and an unknown template before any write", async () => {
    const h = await harness();
    const deploy = h.route("POST", AUTOPILOT_TEMPLATE_DEPLOY_PATH);
    h.setCaller({ userId: "u", permissions: ["*"], tenantScope: tenantScope([T1]) });
    await expect(deploy.handler(ctx({ targets: [T1, T2], confirmTargetCount: 2 }, { id: "tpl-1" }))).rejects.toMatchObject({ status: 403 });
    await expect(deploy.handler(ctx({ targets: [T1] }, { id: "nope" }))).rejects.toMatchObject({ status: 404 });
    expect(h.writes).toHaveLength(0);
  });
});
