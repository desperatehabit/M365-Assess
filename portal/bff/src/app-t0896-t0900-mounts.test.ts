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
    correlationId: "corr-t0896-t0900-mount",
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

describe("T-0896 SharePoint templates + site edit and T-0900 group convert routes are mounted", () => {
  it("mounts SharePoint template CRUD/deploy, site PATCH edit, and group convert endpoints", async () => {
    const workerScripts: string[] = [];
    const app = createApp(
      { ...loadConfig({}), devIdentityRole: "admin" },
      {
        db: new Database(":memory:"),
        schedulerIntervalMs: 60_000,
        workerRunner: (async (entrypoint: string) => {
          workerScripts.push(entrypoint);
          if (entrypoint.endsWith("new-sharepoint-site.ps1")) {
            return {
              status: "planned",
              name: "Engineering Team Site",
              type: "team",
              alias: "eng",
            };
          }
          if (entrypoint.endsWith("invoke-sharepoint-site-action.ps1")) {
            return {
              action: "edit",
              siteId: "site-1",
              targetName: "Engineering Site",
              before: { displayName: "Engineering", sharing: "disabled" },
              after: { displayName: "Engineering Updated", sharing: "existing" },
              diff: ["displayName: Engineering -> Engineering Updated"],
              valid: true,
              dryRun: true,
              requiresConfirmation: false,
            };
          }
          if (entrypoint.endsWith("set-group.ps1")) {
            return {
              action: "convert",
              targetName: "Finance Group",
              diff: ["Convert security group to dynamic membership"],
              valid: true,
              dryRun: true,
              requiresConfirmation: false,
            };
          }
          return { ok: true };
        }) as never,
      },
    );
    opened.push(app);

    const createdTenant = await invoke(app, "POST", "/v1/tenants", {
      id: "tenant-probe",
      displayName: "Probe Tenant",
    });
    expect(createdTenant.status).toBe(201);

    // Uncredentialed worker probes must fail closed at 409 rather than 404.
    expect(
      (
        await invoke(app, "PATCH", "/v1/tenants/tenant-probe/sharepoint/sites/site-1", {
          displayName: "New Name",
          preview: true,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await invoke(app, "POST", "/v1/tenants/tenant-probe/groups/g-1/convert", {
          targetType: "dynamic",
          dynamicRule: '(user.department -eq "Finance")',
          preview: true,
        })
      ).status,
    ).toBe(409);

    // SharePoint templates CRUD works against SQLite directly.
    const createTpl = await invoke(app, "POST", "/v1/sharepoint/templates", {
      name: "Engineering Team Site",
      siteType: "team",
      settings: { sharing: "disabled" },
      variables: { alias: "eng" },
    });
    expect(createTpl.status, JSON.stringify(createTpl.body)).toBe(201);
    const tplId = String((createTpl.body as { id: string }).id);

    expect((await invoke(app, "GET", "/v1/sharepoint/templates")).status).toBe(200);
    expect((await invoke(app, "GET", `/v1/sharepoint/templates/${tplId}`)).status).toBe(200);
    expect(
      (
        await invoke(app, "PATCH", `/v1/sharepoint/templates/${tplId}`, {
          name: "Engineering Team Site v2",
        })
      ).status,
    ).toBe(200);

    // Seed tenant credential and verify worker-backed deploy, edit, and convert paths.
    const cred = await invoke(app, "POST", "/v1/tenants/tenant-probe/credential", {
      authMethod: "certificate",
      clientId: "00000000-0000-0000-0000-000000000001",
      thumbprint: "ABCDEF1234567890",
    });
    expect(cred.status).toBe(201);

    const deployRes = await invoke(app, "POST", `/v1/sharepoint/templates/${tplId}/deploy`, {
      targets: [
        {
          tenantId: "tenant-probe",
          name: "Engineering Team Site",
          alias: "eng",
          owners: ["owner@example.invalid"],
        },
      ],
      preview: true,
    });
    expect(deployRes.status, JSON.stringify(deployRes.body)).toBe(200);

    const editSiteRes = await invoke(
      app,
      "PATCH",
      "/v1/tenants/tenant-probe/sharepoint/sites/site-1",
      {
        displayName: "Engineering Updated",
        sharing: "externalUserSharingOnly",
        preview: true,
      },
    );
    expect(editSiteRes.status, JSON.stringify(editSiteRes.body)).toBe(200);

    const convertRes = await invoke(
      app,
      "POST",
      "/v1/tenants/tenant-probe/groups/g-1/convert",
      {
        targetType: "dynamic",
        dynamicRule: '(user.department -eq "Finance")',
        preview: true,
      },
    );
    expect(convertRes.status, JSON.stringify(convertRes.body)).toBe(200);

    const delTpl = await invoke(app, "DELETE", `/v1/sharepoint/templates/${tplId}`);
    expect(delTpl.status).toBe(204);

    expect(workerScripts).toContain("new-sharepoint-site.ps1");
    expect(workerScripts).toContain("invoke-sharepoint-site-action.ps1");
    expect(workerScripts).toContain("set-group.ps1");
  });
});
