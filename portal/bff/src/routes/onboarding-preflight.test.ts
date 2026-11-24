import { describe, expect, it } from "vitest";
import { ALL_TENANTS } from "../rbac/scope.js";
import type { RequestContext } from "../server.js";
import {
  createOnboardingPreflightRoutes,
  ONBOARDING_PREFLIGHT_FORBIDDEN,
  ONBOARDING_PREFLIGHT_OPENAPI,
  ONBOARDING_PREFLIGHT_PATH,
  ONBOARDING_PREFLIGHT_PERMISSION,
  ONBOARDING_PREFLIGHT_UNAUTHENTICATED,
  type OnboardingPreflightCaller,
  type OnboardingPreflightReport,
  type OnboardingPreflightRouteOptions,
} from "./onboarding-preflight.js";

const MISSING_REPORT: OnboardingPreflightReport = {
  ready: false,
  graphVersion: "2.34.0",
  modules: [
    { name: "Microsoft.Graph.Authentication", installed: true, version: "2.34.0" },
    { name: "Microsoft.Graph.Applications", installed: true, version: "2.34.0" },
    { name: "Microsoft.Graph.Identity.Governance", installed: false, version: null },
    { name: "ExchangeOnlineManagement", installed: false, version: null },
  ],
  missingModules: ["Microsoft.Graph.Identity.Governance", "ExchangeOnlineManagement"],
  installCommands: [
    "Install-Module Microsoft.Graph.Identity.Governance -RequiredVersion 2.34.0 -Scope CurrentUser -Force",
    "Install-Module ExchangeOnlineManagement -Scope CurrentUser -Force",
  ],
  message: "Missing required onboarding PowerShell modules: Microsoft.Graph.Identity.Governance, ExchangeOnlineManagement.",
};

const READY_REPORT: OnboardingPreflightReport = {
  ready: true,
  graphVersion: "2.34.0",
  modules: [
    { name: "Microsoft.Graph.Authentication", installed: true, version: "2.34.0" },
    { name: "Microsoft.Graph.Applications", installed: true, version: "2.34.0" },
    { name: "Microsoft.Graph.Identity.Governance", installed: true, version: "2.34.0" },
    { name: "ExchangeOnlineManagement", installed: true, version: "3.9.0" },
  ],
  missingModules: [],
  installCommands: [],
  message: "All onboarding PowerShell modules are installed.",
};

function operatorCaller(): OnboardingPreflightCaller {
  return { roles: ["admin"], tenantScope: ALL_TENANTS, userId: "operator-1" };
}

function makeContext(): RequestContext {
  return {
    method: "GET",
    path: ONBOARDING_PREFLIGHT_PATH,
    params: {},
    query: new URLSearchParams(),
    headers: { "x-correlation-id": "test-corr-1" },
  };
}

function createHarness(
  report: OnboardingPreflightReport,
  overrides: Partial<OnboardingPreflightRouteOptions> = {},
) {
  const seenPermissions: string[] = [];
  let runs = 0;
  const routes = createOnboardingPreflightRoutes({
    runner: async () => {
      runs += 1;
      return report;
    },
    resolveCaller: () => operatorCaller(),
    authorize: (_caller, permission) => {
      seenPermissions.push(permission);
    },
    ...overrides,
  });
  return { routes, seenPermissions, runs: () => runs };
}

describe("Onboarding prerequisites preflight (T-0915)", () => {
  it("exposes a read-only GET path gated on Tenant.Administration.Read", () => {
    expect(ONBOARDING_PREFLIGHT_PATH).toBe("/v1/onboarding/preflight");
    expect(ONBOARDING_PREFLIGHT_PERMISSION).toBe("Tenant.Administration.Read");

    const operation = ONBOARDING_PREFLIGHT_OPENAPI.paths["/onboarding/preflight"].get;
    expect(operation.operationId).toBe("getOnboardingPreflight");
    expect(operation.permission).toBe(ONBOARDING_PREFLIGHT_PERMISSION);
    expect(operation.security).toEqual([{ bearerAuth: [] }]);
  });

  it("returns the missing modules and their pinned install commands", async () => {
    const h = createHarness(MISSING_REPORT);

    const res = await h.routes[0]!.handler(makeContext());

    expect(res.status).toBe(200);
    expect(res.body).toEqual(MISSING_REPORT);
    expect(h.seenPermissions).toEqual([ONBOARDING_PREFLIGHT_PERMISSION]);
    expect(h.runs()).toBe(1);
    expect(MISSING_REPORT.installCommands).toContain(
      "Install-Module Microsoft.Graph.Identity.Governance -RequiredVersion 2.34.0 -Scope CurrentUser -Force",
    );
  });

  it("reports ready when every onboarding module is installed", async () => {
    const h = createHarness(READY_REPORT);

    const res = await h.routes[0]!.handler(makeContext());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ready: true, missingModules: [], installCommands: [] });
  });

  it("rejects an unauthenticated caller with 401", async () => {
    const h = createHarness(MISSING_REPORT, { resolveCaller: () => undefined });

    await expect(h.routes[0]!.handler(makeContext())).rejects.toMatchObject({
      code: ONBOARDING_PREFLIGHT_UNAUTHENTICATED,
      status: 401,
    });
    expect(h.runs()).toBe(0);
  });

  it("rejects a caller without the read permission with 403", async () => {
    const h = createHarness(MISSING_REPORT, {
      authorize: () => {
        throw Object.assign(new Error("forbidden"), { code: ONBOARDING_PREFLIGHT_FORBIDDEN, status: 403 });
      },
    });

    await expect(h.routes[0]!.handler(makeContext())).rejects.toMatchObject({
      code: ONBOARDING_PREFLIGHT_FORBIDDEN,
      status: 403,
    });
    expect(h.runs()).toBe(0);
  });
});
