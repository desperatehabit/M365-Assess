import { describe, expect, it } from "vitest";
import { OPENAPI_ROUTE, type Route } from "../server.js";
import { InMemoryCaTemplateRepository } from "../repository/ca-templates.js";
import type { CveExceptionRepository } from "../repository/cve-exceptions.js";
import { createInMemoryDefenderDeploymentTemplateRepository } from "../repository/defender-deployment-templates.js";
import { InMemoryIntuneTemplateRepository } from "../repository/intune-templates.js";
import { createApiClientRoutes, createInMemoryApiClientStore } from "../routes/api-clients.js";
import { createCaTemplateRoutes } from "../routes/ca-templates.js";
import {
  createDashboardLayoutRoutes,
  type DashboardLayoutStore,
} from "../routes/dashboard-layout.js";
import { createDefenderCveExceptionRoutes } from "../routes/defender-cve-exceptions.js";
import { createDefenderTemplateRoutes } from "../routes/defender-templates.js";
import { createDeviceActionsHistoryRoute } from "../routes/device-actions-history.js";
import { createIntuneTemplateRoutes } from "../routes/intune-templates.js";
import {
  createReportTemplateRoutes,
  type ReportTemplateDependencies,
  type ReportTemplateStore,
} from "../routes/report-templates.js";
import {
  PermissionRegistry,
  isPermissionString,
  isPublicPermission,
  isReservedPermission,
  permissionForEndpoint,
} from "./permissions.js";

const dashboardStore: DashboardLayoutStore = {
  getLayout: async () => {
    throw new Error("not used");
  },
  saveLayout: async () => {
    throw new Error("not used");
  },
  resetLayout: async () => {
    throw new Error("not used");
  },
};

// The CVE repository is a concrete class over sqlite; the factories only
// close over it, and this test never invokes a handler, so a structural stub
// is enough to enumerate the mounted routes.
const cveRepository = {
  list: async () => [],
  create: async () => {
    throw new Error("not used");
  },
  get: async () => undefined,
  update: async () => {
    throw new Error("not used");
  },
  remove: async () => false,
} as unknown as CveExceptionRepository;

const reportStore: ReportTemplateStore = {
  createTemplate: async () => {
    throw new Error("not used");
  },
  getTemplate: async () => undefined,
  listTemplates: async () => [],
  updateTemplate: async () => undefined,
  softDeleteTemplate: async () => false,
  cloneTemplate: async () => undefined,
};

const reportDeps: ReportTemplateDependencies = {
  store: reportStore,
  contract: { parse: (input: unknown) => input },
  render: {
    enqueue: async () => {
      throw new Error("not used");
    },
  },
};

function mountedEndpoints(): Route[] {
  return [
    { method: "GET", path: OPENAPI_ROUTE, handler: () => ({ status: 200, body: null }) },
    ...createApiClientRoutes(createInMemoryApiClientStore()),
    ...createCaTemplateRoutes(new InMemoryCaTemplateRepository()),
    ...createDashboardLayoutRoutes({
      store: dashboardStore,
      resolveCaller: () => ({ userId: "test-user" }),
    }),
    ...createDefenderTemplateRoutes(createInMemoryDefenderDeploymentTemplateRepository()),
    ...createDefenderCveExceptionRoutes({ repository: cveRepository, authorize: () => true }),
    ...createDeviceActionsHistoryRoute({ store: { listDeviceActions: async () => [] } }),
    ...createIntuneTemplateRoutes(new InMemoryIntuneTemplateRepository()),
    ...createReportTemplateRoutes(reportDeps),
  ];
}

function endpointKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

describe("permission registry completeness", () => {
  it("resolves exactly one permission for every mounted endpoint", () => {
    const mounted = mountedEndpoints();
    expect(mounted.length).toBeGreaterThan(0);
    for (const route of mounted) {
      // Strip any route-carried permission so the assertion exercises the
      // registry table itself: deleting the entry must break this test.
      const permission = permissionForEndpoint({ method: route.method, path: route.path });
      expect(
        permission,
        `no permission declared for ${route.method} ${route.path}`,
      ).toBeDefined();
      expect(typeof permission).toBe("string");
    }
  });

  it("declares exactly one registry entry per mounted endpoint and no extras", () => {
    const mountedKeys = mountedEndpoints().map((route) => endpointKey(route.method, route.path));
    const registryKeys = PermissionRegistry.map((entry) =>
      endpointKey(entry.method, entry.path),
    );
    expect([...registryKeys].sort()).toEqual([...mountedKeys].sort());
  });

  it("returns undefined for an endpoint with no declaration", () => {
    expect(permissionForEndpoint("GET", "/v1/no-such-endpoint")).toBeUndefined();
    expect(permissionForEndpoint("DELETE", "/v1/dashboard/layout")).toBeUndefined();
    expect(permissionForEndpoint("GET", "/v1/ca-templates/extra/deep")).toBeUndefined();
  });
});

describe("permissionForEndpoint", () => {
  it("maps concrete paths through path parameters", () => {
    expect(permissionForEndpoint("GET", "/v1/api-clients/550e8400-e29b-41d4-a716-446655440000")).toBe(
      "CIPP.ApiClients.Read",
    );
    expect(permissionForEndpoint("POST", "/v1/api-clients/some-id/rotate-secret")).toBe(
      "CIPP.ApiClients.ReadWrite",
    );
    expect(permissionForEndpoint("GET", "/v1/tenants/tenant-a/devices/device-1/actions")).toBe(
      "devices.read",
    );
    expect(permissionForEndpoint("GET", "/v1/ca-templates/template-1/versions")).toBe("ca.read");
    expect(permissionForEndpoint("POST", "/v1/report-templates/template-1/generate")).toBe(
      "reports.generate",
    );
  });

  it("matches case-insensitively on method and OpenAPI-style paths", () => {
    expect(permissionForEndpoint("get", "/v1/ca-templates")).toBe("ca.read");
    expect(permissionForEndpoint("GET", "/api-clients")).toBe("CIPP.ApiClients.Read");
    expect(permissionForEndpoint("GET", "/api-clients/{id}")).toBe("CIPP.ApiClients.Read");
  });

  it("maps each route family to its declared permission", () => {
    expect(permissionForEndpoint("POST", "/v1/ca-templates")).toBe("ca.deploy");
    expect(permissionForEndpoint("GET", "/v1/dashboard/layout")).toBe("dashboard.read");
    expect(permissionForEndpoint("PUT", "/v1/dashboard/layout")).toBe("dashboard.readWrite");
    expect(permissionForEndpoint("GET", "/v1/tenants/t/defender/templates")).toBe("defender.read");
    expect(permissionForEndpoint("POST", "/v1/tenants/t/defender/templates")).toBe(
      "defender.write",
    );
    expect(permissionForEndpoint("GET", "/v1/tenants/t/defender/cve-exceptions")).toBe(
      "defender.read",
    );
    expect(permissionForEndpoint("DELETE", "/v1/tenants/t/defender/cve-exceptions/e-1")).toBe(
      "defender.write",
    );
    expect(permissionForEndpoint("GET", "/v1/intune-templates")).toBe("intune.read");
    expect(permissionForEndpoint("POST", "/v1/intune-templates")).toBe("intune.templates");
    expect(permissionForEndpoint("GET", "/v1/report-templates")).toBe("reports.read");
    expect(permissionForEndpoint("POST", "/v1/report-templates")).toBe("reports.templates.write");
  });

  it("resolves the served contract document to Public", () => {
    expect(permissionForEndpoint("GET", OPENAPI_ROUTE)).toBe("Public");
    expect(permissionForEndpoint({ method: "GET", path: OPENAPI_ROUTE })).toBe("Public");
    expect(isPublicPermission(permissionForEndpoint("GET", OPENAPI_ROUTE) ?? "")).toBe(true);
  });

  it("prefers a permission carried by the route object itself", () => {
    expect(
      permissionForEndpoint({ method: "GET", path: "/v1/unregistered", permission: "Tenant.Read" }),
    ).toBe("Tenant.Read");
    expect(permissionForEndpoint({ method: "GET", path: "/v1/ca-templates" })).toBe("ca.read");
  });
});

describe("permission taxonomy", () => {
  it("accepts Area.Resource.Action strings and Public", () => {
    for (const value of [
      "Tenant.Read",
      "Tenant.Standards.ReadWrite",
      "Remediation.Apply",
      "Remediation.Plan",
      "CIPP.Admin",
      "CIPP.SuperAdmin",
      "dashboard.read",
      "reports.templates.write",
      "Public",
    ]) {
      expect(isPermissionString(value), value).toBe(true);
    }
  });

  it("rejects reserved defaults, wildcards, and malformed strings", () => {
    for (const value of [
      "anonymous",
      "authenticated",
      "admin",
      "",
      "a.b.c.d",
      "*.Read",
      "Tenant.",
      ".Read",
      "Tenant..Read",
    ]) {
      expect(isPermissionString(value), value).toBe(false);
    }
  });

  it("keeps every registry permission in taxonomy with Public only on the contract route", () => {
    expect(PermissionRegistry.length).toBeGreaterThan(0);
    for (const entry of PermissionRegistry) {
      expect(isPermissionString(entry.permission), `${entry.method} ${entry.path}`).toBe(true);
      expect(isReservedPermission(entry.permission)).toBe(false);
    }
    const publicEntries = PermissionRegistry.filter((entry) =>
      isPublicPermission(entry.permission),
    );
    expect(publicEntries).toHaveLength(1);
    expect(publicEntries[0]).toMatchObject({ method: "GET", path: OPENAPI_ROUTE });
  });

  it("treats anonymous and authenticated as reserved, matched exactly", () => {
    expect(isReservedPermission("anonymous")).toBe(true);
    expect(isReservedPermission("authenticated")).toBe(true);
    expect(isReservedPermission("Public")).toBe(false);
    expect(isReservedPermission("Tenant.Read")).toBe(false);
    expect(isPublicPermission("Public")).toBe(true);
    expect(isPublicPermission("public")).toBe(false);
  });
});
