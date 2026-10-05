// T-0893: the Purview, SharePoint, OneDrive, Mailbox, portal user, and role routes the app
// mounts must (1) enforce exactly the permission the registry declares and (2) be reachable
// by the base roles the EPIC-038 SPEC §4.1 table says hold that permission. The registry
// completeness and taxonomy checks live in permissions.test.ts; this file proves the
// registry matches what each handler actually checks, through the real app composition.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { canAccess, createApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { RequestCaller, RequestContext, Route } from "../server.js";
import { permissionForEndpoint } from "./permissions.js";

const AREA =
  /\/(mailboxes|retention|vacation-schedules|deleted-mailboxes|purview|safelinks|compliance-templates|sharepoint|onedrive|users|roles)\b|\/mailbox-|\/device-actions\//;

const app = createApp(loadConfig({ M365_BFF_GDAP_PARTNER_TENANT_ID: "partner-tenant" }), {
  db: new Database(":memory:"),
});
const areaRoutes: Route[] = app.routes.filter((r) => AREA.test(r.path));
const key = (r: { method: string; path: string }): string => `${r.method.toUpperCase()} ${r.path}`;

const ALL_TENANTS = { all: true, tenantIds: [] as string[] };
const callerWith = (...roles: string[]): RequestCaller =>
  ({ roles, tenantScope: ALL_TENANTS }) as unknown as RequestCaller;

function contextFor(route: Route, caller: RequestCaller): RequestContext {
  const params: Record<string, string> = {};
  for (const match of route.path.matchAll(/:([A-Za-z0-9_]+)/g)) params[match[1]!] = `${match[1]}-1`;
  return {
    correlationId: "t-0893",
    method: route.method,
    path: route.path,
    query: new URLSearchParams(),
    headers: {},
    params,
    body: {},
    caller,
  } as unknown as RequestContext;
}

function registered(route: Route): string {
  const permission = permissionForEndpoint({ method: route.method, path: route.path });
  expect(permission, `registry entry for ${key(route)}`).toBeDefined();
  return permission as string;
}

describe("area routes are mounted", () => {
  it("covers the mailbox, Purview, SharePoint, user, and role families", () => {
    expect(areaRoutes.length).toBeGreaterThanOrEqual(85);
    for (const fragment of ["/mailboxes", "/purview/dlp", "/purview/labels", "/purview/sits", "/purview/retention", "/safelinks", "/compliance-templates", "/sharepoint/sites", "/onedrive", "/retention/tags", "/vacation-schedules", "/deleted-mailboxes", "/v1/users", "/v1/roles"]) {
      expect(areaRoutes.some((r) => r.path.includes(fragment)), fragment).toBe(true);
    }
  });
});

describe("mounted routes enforce the permission the registry declares", () => {
  it("denies a caller with no role, naming the registered permission", async () => {
    const nobody = callerWith("no-such-role");
    for (const route of areaRoutes) {
      const expected = registered(route);
      let thrown: unknown;
      try {
        await route.handler(contextFor(route, nobody));
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `${key(route)} must reject a caller with no role`).toMatchObject({
        status: 403,
        message: `forbidden: requires ${expected}`,
      });
    }
  });
});

describe("base roles reach the area routes (EPIC-038 SPEC §4.1)", () => {
  const excluded = (permission: string): boolean => /^(CIPP\.Admin\.|CIPP\.SuperAdmin\.|CIPP\.AppSettings\.)/.test(permission);

  it("grants readonly the Read routes, editor Read and ReadWrite, admin and superadmin everything", () => {
    for (const route of areaRoutes) {
      const permission = registered(route);
      const isRead = permission.endsWith(".Read");
      const isReadWrite = permission.endsWith(".ReadWrite");
      expect(canAccess(callerWith("readonly"), permission), `readonly ${key(route)}`).toBe(isRead && !excluded(permission));
      expect(canAccess(callerWith("editor"), permission), `editor ${key(route)}`).toBe(
        (isRead || isReadWrite) && !excluded(permission),
      );
      expect(canAccess(callerWith("admin"), permission), `admin ${key(route)}`).toBe(true);
      expect(canAccess(callerWith("superadmin"), permission), `superadmin ${key(route)}`).toBe(true);
    }
  });

  const cases: ReadonlyArray<{ route: string; readonly: boolean; editor: boolean }> = [
    { route: "GET /v1/tenants/:tenantId/purview/dlp", readonly: true, editor: true },
    { route: "POST /v1/tenants/:tenantId/purview/dlp", readonly: false, editor: true },
    { route: "GET /v1/tenants/:tenantId/purview/labels", readonly: true, editor: true },
    { route: "POST /v1/tenants/:tenantId/purview/labels/:labelId/publish", readonly: false, editor: true },
    { route: "GET /v1/tenants/:tenantId/purview/sits", readonly: true, editor: true },
    { route: "DELETE /v1/tenants/:tenantId/purview/retention/:policyId", readonly: false, editor: true },
    { route: "GET /v1/tenants/:tenantId/safelinks", readonly: true, editor: true },
    { route: "PATCH /v1/tenants/:tenantId/safelinks/:policyId", readonly: false, editor: true },
    { route: "GET /v1/compliance-templates", readonly: true, editor: true },
    { route: "POST /v1/compliance-templates", readonly: false, editor: true },
    { route: "POST /v1/compliance-templates/:id/deploy", readonly: false, editor: true },
    { route: "GET /v1/tenants/:tenantId/sharepoint/sites", readonly: true, editor: true },
    { route: "POST /v1/tenants/:tenantId/sharepoint/sites", readonly: false, editor: true },
    { route: "POST /v1/tenants/:tenantId/sharepoint/sites/:siteId/versions/cleanup", readonly: false, editor: true },
    { route: "GET /v1/tenants/:tenantId/onedrive", readonly: true, editor: true },
    { route: "GET /v1/tenants/:tenantId/mailboxes", readonly: true, editor: true },
    { route: "POST /v1/tenants/:tenantId/mailboxes", readonly: false, editor: true },
    { route: "POST /v1/tenants/:tenantId/mailboxes/:mailboxId/permissions", readonly: false, editor: true },
    { route: "GET /v1/tenants/:tenantId/mailbox-permissions", readonly: true, editor: true },
    { route: "POST /v1/tenants/:tenantId/vacation-schedules", readonly: false, editor: true },
    { route: "GET /v1/users", readonly: false, editor: false },
    { route: "POST /v1/users", readonly: false, editor: false },
  ];

  it.each(cases)("$route: readonly=$readonly editor=$editor", ({ route, readonly, editor }) => {
    const [method, path] = route.split(" ") as [string, string];
    const permission = permissionForEndpoint({ method, path });
    expect(permission, route).toBeDefined();
    expect(canAccess(callerWith("readonly"), permission as string)).toBe(readonly);
    expect(canAccess(callerWith("editor"), permission as string)).toBe(editor);
    expect(canAccess(callerWith("admin"), permission as string)).toBe(true);
  });
});
