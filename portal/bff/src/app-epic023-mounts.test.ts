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
  caller: RequestCaller | null = ADMIN_CALLER,
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
    correlationId: "corr-epic023-mount",
    method: upper,
    path: url.pathname,
    query: url.searchParams,
    headers: { "content-type": "application/json" },
    params,
    body,
    caller,
  };
  try {
    return await matched.handler(ctx);
  } catch (err) {
    const status = (err as { status?: number })?.status ?? 500;
    const code = (err as { code?: string })?.code ?? "internal_error";
    const message = err instanceof Error ? err.message : String(err);
    const details = (err as { details?: unknown })?.details;
    return { status, body: { code, message, ...(details !== undefined ? { details } : {}) } };
  }
}

async function makeApp(workerPayload?: Record<string, unknown>) {
  const workerCalls: Array<{ scriptPath: string; job: unknown }> = [];
  const app = createApp(
    { ...loadConfig({}), devIdentityRole: "admin" },
    {
      db: new Database(":memory:"),
      schedulerIntervalMs: 60_000,
      workerRunner: (async (entrypoint: string, job: unknown) => {
        workerCalls.push({ scriptPath: entrypoint, job });
        if (entrypoint.endsWith("get-contacts.ps1")) {
          return {
            tenantId: "tenant-probe",
            totalCount: 1,
            items: [
              {
                id: "c-1",
                displayName: "Vendor Contact",
                externalAddress: "vendor@partner.example.com",
                type: "mailContact",
                hiddenFromGal: false,
                lastModified: "2026-10-01T00:00:00Z",
              },
            ],
            nextCursor: null,
          };
        }
        if (entrypoint.endsWith("get-resources.ps1")) {
          return {
            tenantId: "tenant-probe",
            kind: "rooms",
            totalCount: 1,
            items: [
              {
                id: "room-1",
                name: "Boardroom A",
                primarySmtpAddress: "boardroom@contoso.example",
                capacity: 12,
                location: "Floor 2",
                type: "room",
                hidden: false,
                members: [],
              },
            ],
            nextCursor: null,
          };
        }
        if (entrypoint.endsWith("import-contacts.ps1")) {
          return {
            tenantId: "tenant-probe",
            preview: true,
            rows: [
              {
                row: 1,
                displayName: "Vendor One",
                externalAddress: "one@partner.example.com",
                status: "ready",
                reason: null,
                contactId: null,
              },
            ],
            summary: { total: 1, created: 0, skippedDuplicate: 0, invalid: 0, failed: 0, ready: 1 },
          };
        }
        if (entrypoint.endsWith("deploy-contact-template.ps1")) {
          return {
            targets: [
              {
                tenantId: "tenant-probe",
                displayName: "Legal Desk",
                externalAddress: "legal@partner.example.com",
                type: "mailContact",
                diff: ["Create Legal Desk <legal@partner.example.com>"],
                valid: true,
                status: "created",
                contactId: "c-new",
                error: null,
              },
            ],
            auditEvents: [
              {
                id: "aud-1",
                tenantId: "tenant-probe",
                action: "contact-template.deploy",
                targetId: "c-new",
              },
            ],
          };
        }
        return (
          workerPayload ?? {
            action: "create",
            targetName: "Target",
            diff: ["Create Target"],
            valid: true,
            dryRun: true,
            requiresConfirmation: false,
          }
        );
      }) as never,
    },
  );
  opened.push(app);

  const createdTenant = await invoke(app, "POST", "/v1/tenants", {
    id: "tenant-probe",
    displayName: "Probe Tenant",
  });
  expect(createdTenant.status).toBe(201);
  return { app, workerCalls };
}

describe("EPIC-023 Contacts & Resources routes are mounted (T-0853)", () => {
  it("mounts every EPIC-023 route without 404 (uncredentialed worker routes fail closed at 409)", async () => {
    const { app } = await makeApp();

    // Template CRUD persists in SQLite directly.
    const createTpl = await invoke(app, "POST", "/v1/contact-templates", {
      name: "Standard Vendor Contact",
      type: "mailContact",
      properties: { displayName: "%vendorName%", externalAddress: "%vendorEmail%" },
      variables: { vendorName: "Contoso", vendorEmail: "vendor@example.invalid" },
    });
    expect(createTpl.status, JSON.stringify(createTpl.body)).toBe(201);
    const tplId = String((createTpl.body as { id: string }).id);

    const listTpl = await invoke(app, "GET", "/v1/contact-templates");
    expect(listTpl.status).toBe(200);
    expect((listTpl.body as { items: unknown[] }).items).toHaveLength(1);

    const getTpl = await invoke(app, "GET", `/v1/contact-templates/${tplId}`);
    expect(getTpl.status).toBe(200);

    const patchTpl = await invoke(app, "PATCH", `/v1/contact-templates/${tplId}`, {
      name: "Updated Vendor Contact",
    });
    expect(patchTpl.status).toBe(200);

    // Without a tenant credential stored, worker-backed routes fail closed at 409 rather than 404.
    const T = "/v1/tenants/tenant-probe";
    const workerProbes: Array<[string, string, unknown?]> = [
      ["GET", `${T}/contacts`],
      ["POST", `${T}/contacts`, { displayName: "A", externalAddress: "a@example.com", preview: true }],
      ["PATCH", `${T}/contacts/c-1`, { displayName: "B", preview: true }],
      ["DELETE", `${T}/contacts/c-1?preview=true`, { preview: true }],
      ["POST", `${T}/contacts/import`, { csv: "displayName,externalAddress\nA,a@example.com", preview: true }],
      ["POST", `/v1/contact-templates/${tplId}/deploy`, { tenantId: "tenant-probe", variables: { vendorName: "V", vendorEmail: "v@example.com" }, preview: true }],
      ["GET", `${T}/resources/rooms`],
      ["POST", `${T}/resources/rooms`, { displayName: "Room 1", capacity: 6, preview: true }],
      ["PATCH", `${T}/resources/rooms/r-1`, { capacity: 10, preview: true }],
      ["DELETE", `${T}/resources/rooms/r-1?preview=true`, { preview: true }],
    ];
    for (const [method, url, body] of workerProbes) {
      const res = await invoke(app, method, url, body);
      expect(res.status, `${method} ${url} must be mounted (not 404)`).not.toBe(404);
    }

    const delTpl = await invoke(app, "DELETE", `/v1/contact-templates/${tplId}`);
    expect(delTpl.status).toBe(204);
  });

  it("dispatches contact list, import, template deploy, and resource list through real workers", async () => {
    const { app, workerCalls } = await makeApp();

    // Seed an app-only credential row so createTenantWorker/createEnvelopeWorker proceed to workerRunner.
    const credRes = await invoke(app, "POST", "/v1/tenants/tenant-probe/credential", {
      authMethod: "certificate",
      clientId: "00000000-0000-0000-0000-000000000001",
      thumbprint: "ABCDEF1234567890",
    });
    expect(credRes.status).toBe(201);

    const contacts = await invoke(app, "GET", "/v1/tenants/tenant-probe/contacts");
    expect(contacts.status).toBe(200);
    expect((contacts.body as { items: Array<{ id: string }> }).items[0]?.id, JSON.stringify(contacts.body)).toBe("c-1");

    const imported = await invoke(app, "POST", "/v1/tenants/tenant-probe/contacts/import", {
      csv: "displayName,externalAddress\nVendor One,one@partner.example.com",
      preview: true,
    });
    expect(imported.status).toBe(200);
    expect((imported.body as { summary: { ready: number } }).summary.ready).toBe(1);

    const createdTpl = await invoke(app, "POST", "/v1/contact-templates", {
      name: "Legal Desk",
      type: "mailContact",
      properties: { displayName: "Legal Desk", externalAddress: "legal@partner.example.com" },
    });
    const tplId = String((createdTpl.body as { id: string }).id);
    const deployed = await invoke(app, "POST", `/v1/contact-templates/${tplId}/deploy`, {
      targets: [{ tenantId: "tenant-probe", variables: {} }],
      preview: true,
    });
    expect(deployed.status).toBe(200);
    expect((deployed.body as { plans: Array<{ valid: boolean }> }).plans[0]?.valid).toBe(true);

    const resources = await invoke(app, "GET", "/v1/tenants/tenant-probe/resources/rooms");
    expect(resources.status).toBe(200);
    expect((resources.body as { items: Array<{ id: string }> }).items[0]?.id).toBe("room-1");

    const scripts = workerCalls.map((c) => c.scriptPath);
    expect(scripts.some((s) => s.endsWith("get-contacts.ps1"))).toBe(true);
    expect(scripts.some((s) => s.endsWith("import-contacts.ps1"))).toBe(true);
    expect(scripts.some((s) => s.endsWith("deploy-contact-template.ps1"))).toBe(true);
    expect(scripts.some((s) => s.endsWith("get-resources.ps1"))).toBe(true);
  });
});
