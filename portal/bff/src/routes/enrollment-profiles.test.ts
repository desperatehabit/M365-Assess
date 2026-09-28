// Tests for enrollment profile routes, per-platform validation, and templates (T-0329).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import { SqliteEnrollmentProfileTemplateRepository, validateEnrollmentProfile } from "../repository/enrollment-profile-templates.js";
import type { RequestContext } from "../server.js";
import {
  ENROLLMENT_PROFILES_PATH,
  ENROLLMENT_PROFILE_ASSIGN_PATH,
  ENROLLMENT_PROFILE_PATH,
  ENROLLMENT_TEMPLATES_PATH,
  ENROLLMENT_TEMPLATE_PATH,
  createEnrollmentProfileRoutes,
  tokenAlerts,
  type EnrollmentCaller,
  type EnrollmentToken,
  type EnrollmentWorkerError,
  type EnrollmentWriteRequest,
  type EnrollmentWriteResult,
} from "./enrollment-profiles.js";

const T1 = "11111111-1111-1111-1111-111111111111";
const openDbs: Database.Database[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

const IOS = { "@odata.type": "#microsoft.graph.depIOSEnrollmentProfile", displayName: "iPhone standard", requiresUserAuthentication: true };
const ANDROID = { displayName: "Kiosk", enrollmentMode: "corporateOwnedDedicatedDevice", enrollmentTokenType: "default" };

const TOKENS: EnrollmentToken[] = [
  { platform: "apple-ade", id: "dep-1", name: "Corp ADE", expiresAt: "2026-10-10T00:00:00Z", daysRemaining: 11, state: "expiring", appleId: "mdm@contoso.com" },
  { platform: "android-enterprise", id: "and-1", name: "Kiosk", expiresAt: "2026-09-01T00:00:00Z", daysRemaining: -28, state: "expired" },
  { platform: "android-enterprise", id: "and-2", name: "Fully managed", expiresAt: "2027-09-01T00:00:00Z", daysRemaining: 338, state: "ok" },
];

function harness() {
  const db = new Database(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../../../db/migrations/0085_enrollment_profile_templates.sql", import.meta.url)), "utf8"));
  openDbs.push(db);
  const writes: EnrollmentWriteRequest[] = [];
  const audits: Array<Record<string, unknown>> = [];
  let writeResult: EnrollmentWriteResult | EnrollmentWorkerError | null = null;
  let caller: EnrollmentCaller | undefined = { userId: "operator-1", permissions: ["Endpoint.Autopilot.ReadWrite"], tenantScope: tenantScope([T1]) };
  let n = 0;
  const routes = createEnrollmentProfileRoutes({
    provider: {
      list: async () => ({ profiles: [{ id: "ios-1", platform: "apple-ade", displayName: "iPhone standard" }], tokens: TOKENS }),
      write: async (_tenantId, request) => {
        writes.push(request);
        if (writeResult) return writeResult;
        return {
          preview: request.preview,
          profileId: request.profileId ?? "new-1",
          plan: { action: request.action, before: null, after: request.profile ?? null },
          auditEvent: request.preview ? null : { action: `intune.enrollment-profile.${request.action}`, actor: request.actor, before: null, after: request.profile ?? null },
        };
      },
    },
    templates: new SqliteEnrollmentProfileTemplateRepository(db, 85),
    resolveCaller: () => caller,
    recordAudit: async (e) => void audits.push(e),
    now: () => new Date("2026-09-28T12:00:00.000Z"),
    newId: () => `id-${++n}`,
  });
  const route = (method: string, p: string) => routes.find((r) => r.method === method && r.path === p)!;
  return {
    writes,
    audits,
    route,
    setWriteResult: (r: EnrollmentWriteResult | EnrollmentWorkerError) => {
      writeResult = r;
    },
    setCaller: (c: EnrollmentCaller | undefined) => {
      caller = c;
    },
  };
}

function ctx(options: { body?: unknown; params?: Record<string, string>; query?: Record<string, string> } = {}): RequestContext {
  return {
    correlationId: "corr",
    method: "POST",
    path: "/",
    params: { tenantId: T1, ...options.params },
    query: new URLSearchParams(options.query ?? {}),
    headers: {},
    ...(options.body !== undefined ? { body: options.body } : {}),
  };
}

describe("validateEnrollmentProfile (T-0329)", () => {
  it("accepts Apple iOS/macOS ADE profiles and defaults the Android type", () => {
    expect(validateEnrollmentProfile("apple-ade", IOS)).toEqual(IOS);
    expect(validateEnrollmentProfile("apple-ade", { ...IOS, "@odata.type": "#microsoft.graph.depMacOSEnrollmentProfile" })).toBeTruthy();
    expect(validateEnrollmentProfile("android-enterprise", ANDROID)["@odata.type"]).toBe("#microsoft.graph.androidDeviceOwnerEnrollmentProfile");
  });

  it.each([
    ["an Android type on Apple", "apple-ade", { ...IOS, "@odata.type": "#microsoft.graph.androidDeviceOwnerEnrollmentProfile" }],
    ["an Apple profile without a type", "apple-ade", { displayName: "x" }],
    ["an unknown Android mode", "android-enterprise", { ...ANDROID, enrollmentMode: "byod" }],
    ["an Apple type on Android", "android-enterprise", { ...ANDROID, "@odata.type": IOS["@odata.type"] }],
    ["an enrollment token", "android-enterprise", { ...ANDROID, tokenValue: "t" }],
    ["a QR code", "android-enterprise", { ...ANDROID, qrCodeContent: "q" }],
    ["a Graph id", "apple-ade", { ...IOS, id: "x" }],
    ["no display name", "apple-ade", { ...IOS, displayName: "" }],
    ["an unknown platform", "windows", IOS],
  ])("rejects %s", (_label, platform, profile) => {
    expect(() => validateEnrollmentProfile(platform, profile)).toThrow();
  });

  it("allows a partial update body", () => {
    expect(validateEnrollmentProfile("android-enterprise", { enrollmentMode: "corporateOwnedWorkProfile" }, { partial: true })).toBeTruthy();
    expect(() => validateEnrollmentProfile("android-enterprise", { enrollmentMode: "x" }, { partial: true })).toThrow();
  });
});

describe("GET /v1/tenants/:tenantId/enrollment-profiles (T-0329)", () => {
  it("returns profiles, every token's expiry, and alerts for expiring and expired tokens", async () => {
    const h = harness();
    const res = await h.route("GET", ENROLLMENT_PROFILES_PATH).handler(ctx());
    expect(res.body).toMatchObject({ tenantId: T1, tokens: TOKENS });
    expect((res.body as { alerts: EnrollmentToken[] }).alerts.map((t) => t.id)).toEqual(["dep-1", "and-1"]);
    expect(tokenAlerts(TOKENS)).toHaveLength(2);
  });

  it("requires read permission and tenant scope", async () => {
    const h = harness();
    h.setCaller({ userId: "u", permissions: ["Endpoint.Intune.Read"], tenantScope: tenantScope([T1]) });
    await expect(h.route("GET", ENROLLMENT_PROFILES_PATH).handler(ctx())).rejects.toMatchObject({ status: 403 });
    h.setCaller({ userId: "u", permissions: ["Endpoint.Autopilot.Read"], tenantScope: tenantScope(["other"]) });
    await expect(h.route("GET", ENROLLMENT_PROFILES_PATH).handler(ctx())).rejects.toMatchObject({ status: 403 });
  });
});

describe("live enrollment profile writes (T-0329)", () => {
  it("previews a create without auditing", async () => {
    const h = harness();
    const res = await h.route("POST", ENROLLMENT_PROFILES_PATH).handler(ctx({ body: { platform: "android-enterprise", profile: ANDROID, preview: true } }));
    expect(res).toMatchObject({ status: 200, body: { preview: true, plan: { action: "create" } } });
    expect(h.writes[0]).toMatchObject({ action: "create", preview: true, profile: { "@odata.type": "#microsoft.graph.androidDeviceOwnerEnrollmentProfile" } });
    expect(h.audits).toEqual([]);
  });

  it("creates an Apple profile under its ADE token and records the audit event", async () => {
    const h = harness();
    const res = await h.route("POST", ENROLLMENT_PROFILES_PATH).handler(ctx({ body: { platform: "apple-ade", depOnboardingSettingId: "dep-1", profile: IOS } }));
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty("auditEvent");
    expect(h.writes[0]).toMatchObject({ action: "create", platform: "apple-ade", depOnboardingSettingId: "dep-1", actor: "operator-1" });
    expect(h.audits).toEqual([{ action: "intune.enrollment-profile.create", actor: "operator-1", before: null, after: IOS }]);
  });

  it("requires the ADE token for an Apple create and validates before the worker runs", async () => {
    const h = harness();
    const create = h.route("POST", ENROLLMENT_PROFILES_PATH);
    await expect(create.handler(ctx({ body: { platform: "apple-ade", profile: IOS } }))).rejects.toMatchObject({ status: 400 });
    await expect(create.handler(ctx({ body: { platform: "android-enterprise", profile: { ...ANDROID, tokenValue: "x" } } }))).rejects.toMatchObject({ status: 400 });
    expect(h.writes).toHaveLength(0);
  });

  it("creates from a template, letting the body override fields", async () => {
    const h = harness();
    await h.route("POST", ENROLLMENT_TEMPLATES_PATH).handler(ctx({ body: { name: "Kiosk", platform: "android-enterprise", profileJson: ANDROID } }));
    await h.route("POST", ENROLLMENT_PROFILES_PATH).handler(ctx({ body: { templateId: "id-1", profile: { displayName: "Kiosk — Store 12" } } }));
    expect(h.writes[0]).toMatchObject({ platform: "android-enterprise", profile: { displayName: "Kiosk — Store 12", enrollmentMode: "corporateOwnedDedicatedDevice" } });
    await expect(
      h.route("POST", ENROLLMENT_PROFILES_PATH).handler(ctx({ body: { templateId: "id-1", platform: "apple-ade" } })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("updates with a partial body", async () => {
    const h = harness();
    await h.route("PATCH", ENROLLMENT_PROFILE_PATH).handler(ctx({ params: { profileId: "and-1" }, body: { platform: "android-enterprise", profile: { displayName: "Kiosk v2" } } }));
    expect(h.writes[0]).toMatchObject({ action: "update", profileId: "and-1", profile: { displayName: "Kiosk v2" } });
  });

  it("passes the delete confirmation through and maps the worker's refusal", async () => {
    const h = harness();
    h.setWriteResult({ error: "enrollment-profile.confirmation_required", message: "type the profile name 'Kiosk' to confirm deletion", statusCode: 400 });
    await expect(
      h.route("DELETE", ENROLLMENT_PROFILE_PATH).handler(ctx({ params: { profileId: "and-1" }, query: { platform: "android-enterprise", confirmName: "kiosk" } })),
    ).rejects.toMatchObject({ status: 400, code: "enrollment-profile.confirmation_required" });
    expect(h.writes[0]).toMatchObject({ action: "delete", confirmName: "kiosk" });
    expect(h.audits).toEqual([]);
  });

  it("assigns an Apple profile to serials and refuses Android assignment", async () => {
    const h = harness();
    const assign = h.route("POST", ENROLLMENT_PROFILE_ASSIGN_PATH);
    await assign.handler(ctx({ params: { profileId: "ios-1" }, body: { platform: "apple-ade", depOnboardingSettingId: "dep-1", serialNumbers: ["C02X1", "C02X1", " C02X2 "] } }));
    expect(h.writes[0]).toMatchObject({ action: "assign", serialNumbers: ["C02X1", "C02X2"] });
    await expect(assign.handler(ctx({ params: { profileId: "and-1" }, body: { platform: "android-enterprise", serialNumbers: ["X"] } }))).rejects.toMatchObject({ status: 400 });
    await expect(assign.handler(ctx({ params: { profileId: "ios-1" }, body: { platform: "apple-ade", depOnboardingSettingId: "dep-1", serialNumbers: ["bad serial!"] } }))).rejects.toMatchObject({ status: 400 });
  });

  it("maps a missing profile to 404", async () => {
    const h = harness();
    h.setWriteResult({ error: "enrollment-profile.not_found", message: "enrollment profile 'gone' not found", statusCode: 404 });
    await expect(h.route("PATCH", ENROLLMENT_PROFILE_PATH).handler(ctx({ params: { profileId: "gone" }, body: { platform: "android-enterprise", profile: { displayName: "x" } } }))).rejects.toMatchObject({ status: 404 });
  });

  it("accepts Remediation.Apply and refuses read-only callers", async () => {
    const h = harness();
    const body = { platform: "android-enterprise", profile: ANDROID, preview: true };
    h.setCaller({ userId: "u", permissions: ["Remediation.Apply"], tenantScope: tenantScope([T1]) });
    await expect(h.route("POST", ENROLLMENT_PROFILES_PATH).handler(ctx({ body }))).resolves.toMatchObject({ status: 200 });
    h.setCaller({ userId: "u", permissions: ["Endpoint.Autopilot.Read"], tenantScope: tenantScope([T1]) });
    await expect(h.route("POST", ENROLLMENT_PROFILES_PATH).handler(ctx({ body }))).rejects.toMatchObject({ status: 403 });
  });
});

describe("enrollment profile templates (T-0329)", () => {
  it("round-trips the §5 fields through CRUD with audited before/after", async () => {
    const h = harness();
    const created = await h.route("POST", ENROLLMENT_TEMPLATES_PATH).handler(ctx({ body: { name: "iPhone", platform: "apple-ade", profileJson: IOS } }));
    expect(created).toMatchObject({ status: 201, body: { id: "id-1", name: "iPhone", platform: "apple-ade", profileJson: IOS } });
    await expect(h.route("GET", ENROLLMENT_TEMPLATES_PATH).handler(ctx({ query: { platform: "apple-ade" } }))).resolves.toMatchObject({ body: { totalCount: 1 } });
    await expect(h.route("GET", ENROLLMENT_TEMPLATES_PATH).handler(ctx({ query: { platform: "android-enterprise" } }))).resolves.toMatchObject({ body: { totalCount: 0 } });
    await h.route("PATCH", ENROLLMENT_TEMPLATE_PATH).handler(ctx({ params: { id: "id-1" }, body: { name: "iPhone v2" } }));
    await expect(h.route("PATCH", ENROLLMENT_TEMPLATE_PATH).handler(ctx({ params: { id: "id-1" }, body: { platform: "android-enterprise" } }))).rejects.toMatchObject({ status: 400 });
    await h.route("DELETE", ENROLLMENT_TEMPLATE_PATH).handler(ctx({ params: { id: "id-1" } }));
    await expect(h.route("GET", ENROLLMENT_TEMPLATE_PATH).handler(ctx({ params: { id: "id-1" } }))).rejects.toMatchObject({ status: 404 });
    expect(h.audits.map((a) => a.action)).toEqual(["intune.enrollment-template.create", "intune.enrollment-template.update", "intune.enrollment-template.delete"]);
    expect(h.audits[1]).toMatchObject({ before: { name: "iPhone" }, after: { name: "iPhone v2" } });
  });

  it("validates templates per platform and rejects duplicates", async () => {
    const h = harness();
    const create = h.route("POST", ENROLLMENT_TEMPLATES_PATH);
    await expect(create.handler(ctx({ body: { name: "x", platform: "apple-ade", profileJson: ANDROID } }))).rejects.toMatchObject({ status: 400, details: [{ field: "profile" }] });
    await expect(create.handler(ctx({ body: { name: "x", platform: "windows", profileJson: IOS } }))).rejects.toMatchObject({ status: 400, details: [{ field: "platform" }] });
    await create.handler(ctx({ body: { name: "Kiosk", platform: "android-enterprise", profileJson: ANDROID } }));
    await expect(create.handler(ctx({ body: { name: "KIOSK", platform: "android-enterprise", profileJson: ANDROID } }))).rejects.toMatchObject({ status: 409 });
  });
});
