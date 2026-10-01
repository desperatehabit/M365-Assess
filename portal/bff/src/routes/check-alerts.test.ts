import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import type { RequestContext } from "../server.js";
import {
  CHECK_ALERTS_OPENAPI,
  CHECK_ALERTS_PATH,
  createCheckAlertsRoutes,
  parseCheckAlertsFilter,
  type CheckAlert,
  type CheckAlertsFilter,
  type CheckAlertsPage,
  type CheckAlertsProvider,
  type CheckAlertsRouteOptions,
} from "./check-alerts.js";

function checkAlert(overrides: Partial<CheckAlert> & { id: string }): CheckAlert {
  return {
    checkId: `CHECK-${overrides.id}`,
    title: `Check alert ${overrides.id}`,
    category: "Conditional Access",
    severity: "High",
    status: "Fail",
    entity: "Report-only policy",
    created: "2026-09-20T12:00:00.000Z",
    remediation: "Enable the policy.",
    ...overrides,
  };
}

class FakeCheckAlertsProvider implements CheckAlertsProvider {
  readonly calls: CheckAlertsFilter[] = [];
  constructor(private readonly items: CheckAlert[]) {}

  async listCheckAlerts(filter: CheckAlertsFilter): Promise<CheckAlertsPage> {
    this.calls.push(filter);
    let items = [...this.items];
    if (filter.severity !== undefined) {
      items = items.filter((item) => item.severity === filter.severity);
    }
    if (filter.status !== undefined) {
      items = items.filter((item) => item.status === filter.status);
    }
    return { totalCount: items.length, items, nextCursor: null };
  }
}

function caller(permissions: readonly string[] = []) {
  return {
    roles: [],
    tenantScope: tenantScope(["tenant-a"]),
    permissions,
  };
}

function routesFor(
  provider: CheckAlertsProvider,
  resolveCaller: CheckAlertsRouteOptions["resolveCaller"],
) {
  return createCheckAlertsRoutes({ provider, resolveCaller });
}

function listHandler(routes: ReturnType<typeof createCheckAlertsRoutes>) {
  const handler = routes.find(
    (route) => route.method === "GET" && route.path === CHECK_ALERTS_PATH,
  )?.handler;
  if (!handler) throw new Error("check-alert GET handler is missing");
  return handler;
}

function context(query = ""): RequestContext {
  return {
    correlationId: "correlation-1",
    method: "GET",
    path: CHECK_ALERTS_PATH,
    params: {},
    query: new URLSearchParams(query),
    headers: {},
  } as RequestContext;
}

describe("check-alert list route (T-0549)", () => {
  it("exposes only GET /v1/check-alerts — no tenant path and no write route", () => {
    const routes = routesFor(new FakeCheckAlertsProvider([]), () => caller());
    expect(routes).toHaveLength(1);
    expect(routes[0]?.method).toBe("GET");
    expect(routes[0]?.path).toBe("/v1/check-alerts");
    expect(routes.some((route) => route.method !== "GET")).toBe(false);
    expect(CHECK_ALERTS_OPENAPI.paths["/check-alerts"].get.operationId).toBe("listCheckAlerts");
    expect(CHECK_ALERTS_OPENAPI.paths["/check-alerts"].get.security).toEqual([
      { bearerAuth: [] },
    ]);
  });

  it("rejects unauthenticated requests with 401 and calls no provider", async () => {
    const provider = new FakeCheckAlertsProvider([]);
    const routes = routesFor(provider, () => undefined);
    await expect(listHandler(routes)(context())).rejects.toMatchObject({ status: 401 });
    expect(provider.calls).toHaveLength(0);
  });

  it("returns the module check alerts with their check id and remediation", async () => {
    const provider = new FakeCheckAlertsProvider([
      checkAlert({ id: "alert-1" }),
      checkAlert({ id: "alert-2", severity: "Low", status: "Warning" }),
    ]);
    const routes = routesFor(provider, () => caller());
    const response = await listHandler(routes)(context());

    expect(response.status).toBe(200);
    const body = response.body as CheckAlertsPage;
    expect(body.totalCount).toBe(2);
    expect(body.nextCursor).toBeNull();
    expect(body.items[0]).toMatchObject({
      id: "alert-1",
      checkId: "CHECK-alert-1",
      severity: "High",
      status: "Fail",
      entity: "Report-only policy",
      remediation: "Enable the policy.",
    });
  });

  it("passes severity, status, and pagination filters through to the provider", async () => {
    const provider = new FakeCheckAlertsProvider([
      checkAlert({ id: "alert-1" }),
      checkAlert({ id: "alert-2", severity: "Low", status: "Warning" }),
    ]);
    const routes = routesFor(provider, () => caller());
    const response = await listHandler(routes)(context("severity=high&status=fail&limit=1"));

    const body = response.body as CheckAlertsPage;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.id).toBe("alert-1");
    expect(provider.calls[0]?.severity).toBe("High");
    expect(provider.calls[0]?.status).toBe("Fail");
    expect(provider.calls[0]?.limit).toBe(1);
  });

  it("validates the severity and status filter parameters", () => {
    expect(() => parseCheckAlertsFilter(new URLSearchParams("severity=urgent"))).toThrow(AppError);
    expect(() => parseCheckAlertsFilter(new URLSearchParams("status=Pass"))).toThrow(AppError);
    expect(parseCheckAlertsFilter(new URLSearchParams("severity=critical")).severity).toBe(
      "Critical",
    );
    expect(parseCheckAlertsFilter(new URLSearchParams("status=warning")).status).toBe("Warning");
  });
});
