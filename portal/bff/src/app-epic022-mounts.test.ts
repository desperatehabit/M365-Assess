import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "./app.js";
import { loadConfig } from "./config.js";
import { ALL_TENANTS } from "./rbac/scope.js";
import type { RequestCaller, RequestContext, Route, RouteResponse } from "./server.js";

const opened: App[] = [];

afterEach(() => {
  for (const app of opened.splice(0)) {
    app.close();
  }
});

const ADMIN_CALLER: RequestCaller & { id: string } = {
  id: "user-admin",
  roles: ["admin"],
  tenantScope: ALL_TENANTS,
};

function matchPath(routePath: string, actualPath: string): Record<string, string> | null {
  const routeParts = routePath.split("/").filter((part) => part.length > 0);
  const actualParts = actualPath.split("/").filter((part) => part.length > 0);
  if (routeParts.length !== actualParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < routeParts.length; i += 1) {
    const rp = routeParts[i]!;
    const ap = actualParts[i]!;
    if (rp.startsWith(":")) params[rp.slice(1)] = decodeURIComponent(ap);
    else if (rp !== ap) return null;
  }
  return params;
}

async function invoke(
  app: App,
  method: string,
  rawUrl: string,
  body?: unknown,
): Promise<RouteResponse> {
  const url = new URL(rawUrl, "http://portal.invalid");
  const upper = method.toUpperCase();
  let matched: Route | undefined;
  let params: Record<string, string> = {};
  for (const route of app.routes) {
    if (route.method.toUpperCase() !== upper) continue;
    const found = matchPath(route.path, url.pathname);
    if (found) {
      matched = route;
      params = found;
      break;
    }
  }
  if (!matched) {
    return { status: 404, body: { code: "route.not_found", method: upper, path: url.pathname } };
  }
  const ctx: RequestContext = {
    correlationId: "corr-epic022-mount",
    method: upper,
    path: url.pathname,
    query: url.searchParams,
    headers: { "content-type": "application/json" },
    params,
    body,
    caller: ADMIN_CALLER,
  };
  try {
    return await matched.handler(ctx);
  } catch (err) {
    const status = (err as { status?: number })?.status ?? 500;
    const code = (err as { code?: string })?.code ?? "internal_error";
    const message = err instanceof Error ? err.message : String(err);
    return { status, body: { code, message } };
  }
}

describe("EPIC-022 Spam, Quarantine & Allow/Block routes are mounted (T-0852)", () => {
  it("mounts all 6 EPIC-022 route groups without 404 and persists filter templates + quarantine actions", async () => {
    const workerScripts: string[] = [];
    const db = new Database(":memory:");
    const app = createApp(
      { ...loadConfig({}), devIdentityRole: "admin" },
      {
        db,
        schedulerIntervalMs: 60_000,
        workerRunner: (async (entrypoint: string, job: { payload?: Record<string, unknown> }) => {
          workerScripts.push(entrypoint);
          if (entrypoint.endsWith("get-quarantine.ps1")) {
            const msgId = job?.payload?.["messageId"];
            const item = {
              messageId: typeof msgId === "string" ? msgId : "msg-1",
              tab: "email",
              received: "2026-10-01T00:00:00Z",
              subject: "Suspicious Invoice",
              sender: "sender@bad.invalid",
              recipient: "user@contoso.example",
              reason: "Spam",
              policy: "Default",
              expires: "2026-10-15T00:00:00Z",
              state: "Quarantined",
              direction: "Inbound",
              preview: { source: "graph", available: false, body: null },
            };
            if (typeof msgId === "string" && msgId.length > 0) {
              return item;
            }
            return {
              tenantId: "tenant-probe",
              tab: "email",
              items: [item],
              totalCount: 1,
              nextCursor: null,
              retrievedAt: "2026-10-01T00:00:00Z",
            };
          }
          if (entrypoint.endsWith("get-quarantine-policies.ps1")) {
            return {
              tenantId: "tenant-probe",
              items: [
                {
                  name: "AdminOnlyPolicy",
                  policyType: "permission",
                  esnEnabled: false,
                  quarantineRetentionPeriod: 30,
                  addressForMessages: "",
                  lastModified: "2026-10-01T00:00:00Z",
                },
              ],
              totalCount: 1,
              retrievedAt: "2026-10-01T00:00:00Z",
            };
          }
          if (entrypoint.endsWith("get-allow-block.ps1")) {
            return {
              tenantId: "tenant-probe",
              items: [
                {
                  type: "sender",
                  value: "blocked@bad.invalid",
                  action: "block",
                  expiresOn: null,
                  notes: "Phish",
                },
              ],
              totalCount: 1,
              retrievedAt: "2026-10-01T00:00:00Z",
            };
          }
          if (entrypoint.endsWith("get-filters.ps1")) {
            return {
              tenantId: "tenant-probe",
              filterType: "spam",
              items: [
                {
                  name: "Default",
                  priority: 0,
                  state: "Enabled",
                  summary: "BulkThreshold: 6",
                  lastModified: "2026-10-01T00:00:00Z",
                  settings: { BulkThreshold: 6 },
                },
              ],
              totalCount: 1,
              retrievedAt: "2026-10-01T00:00:00Z",
            };
          }
          return { success: true, status: "pending" };
        }) as never,
      },
    );
    opened.push(app);

    const createdTenant = await invoke(app, "POST", "/v1/tenants", {
      id: "tenant-probe",
      displayName: "Probe Tenant",
    });
    expect(createdTenant.status).toBe(201);

    // Filter template CRUD works without any tenant credential.
    const createTpl = await invoke(app, "POST", "/v1/filter-templates", {
      name: "Strict Anti-Spam",
      filterType: "spam",
      policyJson: { BulkThreshold: 4 },
    });
    expect(createTpl.status, JSON.stringify(createTpl.body)).toBe(201);
    const tplId = String((createTpl.body as { id: string }).id);
    expect((await invoke(app, "GET", "/v1/filter-templates")).status).toBe(200);
    expect((await invoke(app, "GET", `/v1/filter-templates/${tplId}`)).status).toBe(200);
    expect((await invoke(app, "PATCH", `/v1/filter-templates/${tplId}`, { name: "Strict v2" })).status).toBe(200);

    // Uncredentialed tenant worker routes fail closed at 409 (prove non-404 mount before credentialing).
    const T = "/v1/tenants/tenant-probe";
    expect((await invoke(app, "GET", `${T}/quarantine?tab=email`)).status).toBe(409);
    expect((await invoke(app, "POST", `${T}/quarantine/bulk`, { action: "release", messageIds: ["msg-1"], preview: true })).status).toBe(409);

    // Seed tenant credential and verify live reads + bulk/submit queueing.
    const cred = await invoke(app, "POST", "/v1/tenants/tenant-probe/credential", {
      authMethod: "certificate",
      clientId: "00000000-0000-0000-0000-000000000001",
      thumbprint: "ABCDEF1234567890",
    });
    expect(cred.status).toBe(201);

    // A queued quarantine submission runs as the opt-in operator write app (T-0940).
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO tenant_credentials
         (id, tenantId, authMethod, clientId, secretRef, thumbprint, environment, expiresOn, lastValidated, purpose, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "tenant-probe-operator",
      "tenant-probe",
      "certificate-thumbprint",
      "operator-app",
      "thumbprint://ABCDEF1234567890",
      "ABCDEF1234567890",
      "commercial",
      null,
      null,
      "operator",
      now,
      now,
    );

    const qList = await invoke(app, "GET", `${T}/quarantine?tab=email`);
    expect(qList.status).toBe(200);
    expect((qList.body as { items: Array<{ messageId: string }> }).items[0]?.messageId).toBe("msg-1");

    const qBulk = await invoke(app, "POST", `${T}/quarantine/bulk`, {
      action: "release",
      messageIds: ["msg-1"],
      preview: true,
    });
    expect(qBulk.status).toBe(200);

    const qSubmit = await invoke(app, "POST", `${T}/quarantine/msg-1/submit`, { refresh: false });
    expect(qSubmit.status).toBe(202);

    const policies = await invoke(app, "GET", `${T}/quarantine-policies`);
    expect(policies.status).toBe(200);

    const ab = await invoke(app, "GET", `${T}/allow-block`);
    expect(ab.status).toBe(200);

    const filters = await invoke(app, "GET", `${T}/filters/spam`);
    expect(filters.status).toBe(200);

    expect((await invoke(app, "DELETE", `/v1/filter-templates/${tplId}`)).status).toBe(204);
    expect(workerScripts.some((s) => s.endsWith("get-quarantine.ps1"))).toBe(true);
    expect(workerScripts.some((s) => s.endsWith("submit-quarantine-review.ps1"))).toBe(true);
    expect(workerScripts.some((s) => s.endsWith("get-quarantine-policies.ps1"))).toBe(true);
    expect(workerScripts.some((s) => s.endsWith("get-allow-block.ps1"))).toBe(true);
    expect(workerScripts.some((s) => s.endsWith("get-filters.ps1"))).toBe(true);
  });
});
