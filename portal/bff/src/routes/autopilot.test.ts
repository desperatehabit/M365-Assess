// Tests for the Autopilot routes and profile-template repository (T-0328).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import { SqliteAutopilotProfileTemplateRepository } from "../repository/autopilot-profiles.js";
import type { RequestContext } from "../server.js";
import {
  AUTOPILOT_DEVICES_PATH,
  AUTOPILOT_DEVICE_PATH,
  AUTOPILOT_IMPORT_PATH,
  AUTOPILOT_PROFILES_PATH,
  AUTOPILOT_TEMPLATES_PATH,
  AUTOPILOT_TEMPLATE_PATH,
  MAX_AUTOPILOT_IMPORT_ROWS,
  createAutopilotRoutes,
  parseAutopilotImport,
  type AutopilotCaller,
  type AutopilotDevice,
  type AutopilotDevicesFilter,
  type AutopilotImportRequest,
  type AutopilotImportResult,
  type AutopilotProvider,
} from "./autopilot.js";

const T1 = "11111111-1111-1111-1111-111111111111";
const NOW = new Date("2026-09-28T12:00:00.000Z");
const openDbs: Database.Database[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

const DEVICE: AutopilotDevice = {
  id: "ap-1",
  serialNumber: "SER-001",
  groupTag: "Sales",
  manufacturer: "Microsoft",
  model: "Surface Laptop 5",
  profileStatus: "assignedInSync",
  profileName: "Standard user",
  enrollmentState: "enrolled",
  lastContactedDateTime: "2026-09-27T10:00:00Z",
  assignedUser: null,
  purchaseOrderIdentifier: null,
};

const PROFILE = {
  "@odata.type": "#microsoft.graph.azureADWindowsAutopilotDeploymentProfile",
  displayName: "Standard user",
  deviceNameTemplate: "CORP-%SERIAL%",
  outOfBoxExperienceSettings: { hideEULA: true, userType: "standard" },
};

class FakeProvider implements AutopilotProvider {
  readonly listCalls: AutopilotDevicesFilter[] = [];
  readonly imports: AutopilotImportRequest[] = [];
  importResult: AutopilotImportResult | { error: string; message: string; statusCode: number } | null = null;

  async listDevices(_tenantId: string, filter: AutopilotDevicesFilter) {
    this.listCalls.push(filter);
    return { totalCount: 1, items: [DEVICE], nextCursor: null };
  }
  async getDevice(_tenantId: string, deviceId: string) {
    return deviceId === "ap-1" ? DEVICE : { error: "autopilot.device.not_found", message: "Autopilot device not found", statusCode: 404 };
  }
  async listProfiles() {
    return { totalCount: 1, items: [{ id: "p1", displayName: "Standard user" }] };
  }
  async importDevices(tenantId: string, request: AutopilotImportRequest) {
    this.imports.push(request);
    if (this.importResult) return this.importResult;
    const rows = (request.rows ?? []).map((r, i) => ({ row: i + 1, serialNumber: r["serialNumber"] ?? "", status: request.preview ? ("ready" as const) : ("imported" as const), reason: null }));
    return {
      tenantId,
      source: request.source,
      preview: request.preview,
      rows,
      counts: { imported: request.preview ? 0 : rows.length },
      auditEvent: request.preview ? null : { action: "intune.autopilot.import", actor: request.actor, result: "success" },
    };
  }
}

function harness() {
  const db = new Database(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../../../db/migrations/0084_autopilot_profile_templates.sql", import.meta.url)), "utf8"));
  openDbs.push(db);
  const provider = new FakeProvider();
  const audits: Array<Record<string, unknown>> = [];
  let caller: AutopilotCaller | undefined = { userId: "operator-1", permissions: ["Endpoint.Autopilot.ReadWrite"], tenantScope: tenantScope([T1]) };
  let n = 0;
  const routes = createAutopilotRoutes({
    provider,
    templates: new SqliteAutopilotProfileTemplateRepository(db, 84),
    resolveCaller: () => caller,
    recordAudit: async (e) => void audits.push(e),
    now: () => NOW,
    newId: () => `id-${++n}`,
  });
  const route = (method: string, p: string) => routes.find((r) => r.method === method && r.path === p)!;
  return {
    provider,
    audits,
    route,
    setCaller: (c: AutopilotCaller | undefined) => {
      caller = c;
    },
  };
}

function ctx(options: { body?: unknown; params?: Record<string, string>; query?: Record<string, string> } = {}): RequestContext {
  return {
    correlationId: "corr",
    method: "GET",
    path: "/",
    params: { tenantId: T1, ...options.params },
    query: new URLSearchParams(options.query ?? {}),
    headers: {},
    ...(options.body !== undefined ? { body: options.body } : {}),
  };
}

describe("Autopilot device routes (T-0328)", () => {
  it("lists devices with serial, group tag, profile, and enrollment state, forwarding filters", async () => {
    const h = harness();
    const res = await h.route("GET", AUTOPILOT_DEVICES_PATH).handler(ctx({ query: { groupTag: "Sales", search: "SER", limit: "25" } }));
    expect(res.body).toMatchObject({
      tenantId: T1,
      items: [{ serialNumber: "SER-001", groupTag: "Sales", profileName: "Standard user", profileStatus: "assignedInSync", enrollmentState: "enrolled" }],
    });
    expect(h.provider.listCalls[0]).toEqual({ search: "SER", groupTag: "Sales", enrollmentState: undefined, cursor: null, limit: 25 });
  });

  it("returns one device and maps a missing one to 404", async () => {
    const h = harness();
    const get = h.route("GET", AUTOPILOT_DEVICE_PATH);
    await expect(get.handler(ctx({ params: { deviceId: "ap-1" } }))).resolves.toMatchObject({ body: { id: "ap-1" } });
    await expect(get.handler(ctx({ params: { deviceId: "gone" } }))).rejects.toMatchObject({ status: 404, code: "autopilot.device.not_found" });
  });

  it("lists live deployment profiles", async () => {
    const h = harness();
    const res = await h.route("GET", AUTOPILOT_PROFILES_PATH).handler(ctx());
    expect(res.body).toMatchObject({ totalCount: 1, items: [{ displayName: "Standard user" }] });
  });

  it("requires Autopilot read permission and tenant scope", async () => {
    const h = harness();
    const list = h.route("GET", AUTOPILOT_DEVICES_PATH);
    h.setCaller({ userId: "u", permissions: ["Endpoint.Intune.Read"], tenantScope: tenantScope([T1]) });
    await expect(list.handler(ctx())).rejects.toMatchObject({ status: 403 });
    h.setCaller({ userId: "u", permissions: ["Endpoint.Autopilot.Read"], tenantScope: tenantScope(["other"]) });
    await expect(list.handler(ctx())).rejects.toMatchObject({ status: 403 });
    h.setCaller(undefined);
    await expect(list.handler(ctx())).rejects.toMatchObject({ status: 401 });
    expect(h.provider.listCalls).toHaveLength(0);
  });
});

describe("POST /v1/tenants/:tenantId/autopilot/import (T-0328)", () => {
  it("previews per-row results without auditing", async () => {
    const h = harness();
    const res = await h.route("POST", AUTOPILOT_IMPORT_PATH).handler(ctx({ body: { source: "manual", rows: [{ serialNumber: "N1", hardwareHash: "aGFzaA==" }], preview: true } }));
    expect(res.body).toMatchObject({ preview: true, rows: [{ row: 1, serialNumber: "N1", status: "ready" }] });
    expect(h.audits).toEqual([]);
    expect(h.provider.imports[0]).toMatchObject({ preview: true, actor: "operator-1" });
  });

  it("applies, records the worker's audit event, and keeps it out of the response", async () => {
    const h = harness();
    const res = await h.route("POST", AUTOPILOT_IMPORT_PATH).handler(ctx({ body: { source: "manual", rows: [{ serialNumber: "N1", hardwareHash: "aGFzaA==" }] } }));
    expect(res.body).toMatchObject({ preview: false, rows: [{ status: "imported" }] });
    expect(res.body).not.toHaveProperty("auditEvent");
    expect(h.audits).toEqual([{ action: "intune.autopilot.import", actor: "operator-1", result: "success" }]);
  });

  it("passes per-row duplicate results through", async () => {
    const h = harness();
    h.provider.importResult = {
      tenantId: T1,
      source: "manual",
      preview: false,
      rows: [
        { row: 1, serialNumber: "N1", status: "imported", reason: null },
        { row: 2, serialNumber: "n1", status: "duplicate", reason: "serial number appears earlier in this import" },
        { row: 3, serialNumber: "SER-001", status: "duplicate", reason: "serial number is already registered in the tenant" },
      ],
      counts: { imported: 1, duplicate: 2 },
    };
    const res = await h.route("POST", AUTOPILOT_IMPORT_PATH).handler(ctx({ body: { source: "manual", rows: [{ serialNumber: "N1" }, { serialNumber: "n1" }, { serialNumber: "SER-001" }] } }));
    expect((res.body as AutopilotImportResult).rows.map((r) => r.status)).toEqual(["imported", "duplicate", "duplicate"]);
  });

  it("maps a structured worker error", async () => {
    const h = harness();
    h.provider.importResult = { error: "request.validation_failed", message: "CSV is missing the 'Hardware Hash' column", statusCode: 400 };
    await expect(h.route("POST", AUTOPILOT_IMPORT_PATH).handler(ctx({ body: { source: "csv", csv: "a,b" } }))).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Hardware Hash/) });
  });

  it("accepts Remediation.Apply and refuses read-only callers", async () => {
    const h = harness();
    const imp = h.route("POST", AUTOPILOT_IMPORT_PATH);
    const body = { source: "device-prep", rows: [{ manufacturer: "Dell", model: "OptiPlex", serialNumber: "P1" }], preview: true };
    h.setCaller({ userId: "u", permissions: ["Remediation.Apply"], tenantScope: tenantScope([T1]) });
    await expect(imp.handler(ctx({ body }))).resolves.toMatchObject({ status: 200 });
    h.setCaller({ userId: "u", permissions: ["Endpoint.Autopilot.Read"], tenantScope: tenantScope([T1]) });
    await expect(imp.handler(ctx({ body }))).rejects.toMatchObject({ status: 403 });
  });
});

describe("parseAutopilotImport (T-0328)", () => {
  it("keeps only the fields each source uses", () => {
    const manual = parseAutopilotImport({ source: "manual", rows: [{ serialNumber: "A", hardwareHash: "h", extra: "x", groupTag: 7 }] }, "u");
    expect(manual.rows).toEqual([{ serialNumber: "A", hardwareHash: "h", groupTag: "7" }]);
    const prep = parseAutopilotImport({ source: "device-prep", rows: [{ manufacturer: "Dell", model: "M", serialNumber: "S", hardwareHash: "h" }] }, "u");
    expect(prep.rows).toEqual([{ manufacturer: "Dell", model: "M", serialNumber: "S" }]);
  });

  it.each([
    ["an unknown source", { source: "partner-center", rows: [{}] }],
    ["no rows", { source: "manual", rows: [] }],
    ["a non-object row", { source: "manual", rows: ["SER-1"] }],
    ["a CSV import without csv", { source: "csv" }],
    ["too many rows", { source: "manual", rows: Array.from({ length: MAX_AUTOPILOT_IMPORT_ROWS + 1 }, () => ({ serialNumber: "x" })) }],
  ])("rejects %s", (_label, body) => {
    expect(() => parseAutopilotImport(body, "u")).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe("Autopilot profile templates (T-0328)", () => {
  it("round-trips the §5 fields through CRUD and audits each write", async () => {
    const h = harness();
    const created = await h.route("POST", AUTOPILOT_TEMPLATES_PATH).handler(ctx({ body: { name: "Standard user", profileJson: PROFILE, groupTag: "Sales" } }));
    expect(created).toMatchObject({ status: 201, body: { id: "id-1", name: "Standard user", profileJson: PROFILE, groupTag: "Sales", createdBy: "operator-1" } });
    const get = h.route("GET", AUTOPILOT_TEMPLATE_PATH);
    await expect(get.handler(ctx({ params: { id: "id-1" } }))).resolves.toMatchObject({ body: { profileJson: PROFILE } });
    await expect(h.route("GET", AUTOPILOT_TEMPLATES_PATH).handler(ctx())).resolves.toMatchObject({ body: { totalCount: 1 } });

    const patched = await h.route("PATCH", AUTOPILOT_TEMPLATE_PATH).handler(ctx({ params: { id: "id-1" }, body: { groupTag: null } }));
    expect(patched.body).toMatchObject({ groupTag: null, profileJson: PROFILE });

    await expect(h.route("DELETE", AUTOPILOT_TEMPLATE_PATH).handler(ctx({ params: { id: "id-1" } }))).resolves.toMatchObject({ status: 204 });
    await expect(get.handler(ctx({ params: { id: "id-1" } }))).rejects.toMatchObject({ status: 404 });
    expect(h.audits.map((a) => a.action)).toEqual([
      "intune.autopilot.template.create",
      "intune.autopilot.template.update",
      "intune.autopilot.template.delete",
    ]);
    expect(h.audits[1]).toMatchObject({ before: { groupTag: "Sales" }, after: { groupTag: null } });
  });

  it.each([
    ["a non-profile @odata.type", { ...PROFILE, "@odata.type": "#microsoft.graph.win32LobApp" }, "profileJson"],
    ["no display name", { ...PROFILE, displayName: "" }, "profileJson"],
    ["a live-profile id", { ...PROFILE, id: "p1" }, "profileJson"],
    ["an embedded credential", { ...PROFILE, domainJoin: { password: "p" } }, "profileJson"],
  ])("rejects a profile with %s", async (_label, profileJson, field) => {
    const h = harness();
    await expect(h.route("POST", AUTOPILOT_TEMPLATES_PATH).handler(ctx({ body: { name: "x", profileJson } }))).rejects.toMatchObject({
      status: 400,
      details: [{ field, reason: "invalid" }],
    });
  });

  it("rejects a bad group tag and a duplicate name", async () => {
    const h = harness();
    const create = h.route("POST", AUTOPILOT_TEMPLATES_PATH);
    await expect(create.handler(ctx({ body: { name: "x", profileJson: PROFILE, groupTag: "bad/tag" } }))).rejects.toMatchObject({ status: 400 });
    await create.handler(ctx({ body: { name: "Standard user", profileJson: PROFILE } }));
    await expect(create.handler(ctx({ body: { name: "STANDARD USER", profileJson: PROFILE } }))).rejects.toMatchObject({ status: 409 });
  });

  it("lets read-only callers read templates but not write them", async () => {
    const h = harness();
    h.setCaller({ userId: "u", permissions: ["Endpoint.Autopilot.Read"], tenantScope: tenantScope([T1]) });
    await expect(h.route("GET", AUTOPILOT_TEMPLATES_PATH).handler(ctx())).resolves.toMatchObject({ status: 200 });
    await expect(h.route("POST", AUTOPILOT_TEMPLATES_PATH).handler(ctx({ body: { name: "x", profileJson: PROFILE } }))).rejects.toMatchObject({ status: 403 });
  });
});
