// T-0786 — application approval (consent requests) service and routes.
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { ALL_TENANTS } from "../rbac/scope.js";
import { RbacErrorCodes, type Caller } from "../rbac/authorize.js";
import type { RequestContext } from "../server.js";
import {
  CONSENT_DECISION_APPROVE,
  CONSENT_DECISION_DENY,
  CONSENT_REASON_REQUIRED,
  CONSENT_REQUEST_NOT_FOUND,
  createAppApprovalService,
  type ConsentAuditPort,
  type ConsentRequest,
  type ConsentWritePort,
} from "./app-approval-service.js";
import {
  APPROVAL_ADMIN_SCOPE,
  CONSENT_REQUESTS_PATH,
  createAppApprovalRoutes,
} from "./app-approval-routes.js";

const TENANT_1 = "11111111-1111-1111-1111-111111111111";
const TENANT_2 = "22222222-2222-2222-2222-222222222222";
const NOW = new Date("2026-01-01T00:00:00.000Z");

function request(overrides: Partial<ConsentRequest> = {}): ConsentRequest {
  return {
    id: "req-1",
    tenantId: TENANT_1,
    appId: "app-1",
    appName: "Contoso App",
    requestedPermissions: ["User.Read", "Mail.Send"],
    requestor: "user@example.invalid",
    status: "pending",
    ...overrides,
  };
}

class FakeWritePort implements ConsentWritePort {
  calls: Array<{ tenantId: string; requestId: string; appId: string; decision: string; reason: string | null }> = [];
  failWith: string | null = null;
  async applyDecision(input: { tenantId: string; requestId: string; appId: string; decision: string; reason: string | null }) {
    this.calls.push(input);
    if (this.failWith) return { success: false, error: this.failWith };
    return { success: true };
  }
}

class FakeAuditPort implements ConsentAuditPort {
  events: Record<string, unknown>[] = [];
  record(event: Record<string, unknown>): void {
    this.events.push(event);
  }
}

function adminCaller(): Caller {
  return { roles: ["admin"], tenantScope: ALL_TENANTS };
}

function readonlyCaller(): Caller {
  return { roles: ["readonly"], tenantScope: ALL_TENANTS };
}

function allowAll(): void {}
function denyAll(): void {
  throw new AppError(RbacErrorCodes.forbidden, "not permitted to perform this action", 403);
}

function makeService(overrides: Record<string, unknown> = {}) {
  const writePort = new FakeWritePort();
  const auditPort = new FakeAuditPort();
  const service = createAppApprovalService({
    writePort,
    auditPort,
    now: () => NOW,
    requests: [request()],
    ...overrides,
  });
  return { service, writePort, auditPort };
}

function makeRouteOptions(service: ReturnType<typeof createAppApprovalService>, overrides: Record<string, unknown> = {}) {
  return {
    service,
    resolveCaller: () => adminCaller(),
    authorize: allowAll,
    ...overrides,
  };
}

function ctx(method: string, path: string, body?: unknown): RequestContext & { body?: unknown } {
  const tenantId = path.split("/")[3] ?? "";
  return {
    correlationId: "corr-1",
    method,
    path,
    query: new URLSearchParams(),
    headers: {},
    params: { tenantId },
    body,
  };
}

describe("app-approval-service", () => {
  it("lists pending consent requests for the tenant", async () => {
    const { service } = makeService({
      requests: [request(), request({ id: "req-2", tenantId: TENANT_2 })],
    });
    const items = await service.list(TENANT_1);
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("req-1");
  });

  it("approves a request, persists a ConsentDecision, and records an audit event with before/after", async () => {
    const { service, writePort, auditPort } = makeService();
    const result = await service.decide({
      tenantId: TENANT_1,
      requestId: "req-1",
      decision: CONSENT_DECISION_APPROVE,
      actor: "admin@example.invalid",
    });

    expect(result.decision.decision).toBe("approve");
    expect(result.decision.by).toBe("admin@example.invalid");
    expect(result.decision.at).toBe(NOW.toISOString());
    expect(result.decision.reason).toBeNull();
    expect(result.decision.appId).toBe("app-1");

    expect(result.auditEvent.action).toBe("consent.approve");
    expect(result.auditEvent.before).toEqual({ status: "pending", requestId: "req-1" });
    expect(result.auditEvent.after).toMatchObject({ status: "approved", decidedBy: "admin@example.invalid" });
    expect(result.auditEvent.actor).toBe("admin@example.invalid");

    expect(writePort.calls).toHaveLength(1);
    expect(auditPort.events).toHaveLength(1);

    const remaining = await service.list(TENANT_1);
    expect(remaining).toHaveLength(0);
  });

  it("denies a request with a reason and records the reason in the audit after-state", async () => {
    const { service, auditPort } = makeService();
    const result = await service.decide({
      tenantId: TENANT_1,
      requestId: "req-1",
      decision: CONSENT_DECISION_DENY,
      actor: "admin@example.invalid",
      reason: "Unnecessary permissions",
    });

    expect(result.decision.decision).toBe("deny");
    expect(result.decision.reason).toBe("Unnecessary permissions");
    expect(result.auditEvent.action).toBe("consent.deny");
    expect(result.auditEvent.after).toMatchObject({ status: "denied", reason: "Unnecessary permissions" });
    expect(auditPort.events).toHaveLength(1);
  });

  it("rejects a deny without a reason", async () => {
    const { service, writePort, auditPort } = makeService();
    await expect(
      service.decide({
        tenantId: TENANT_1,
        requestId: "req-1",
        decision: CONSENT_DECISION_DENY,
        actor: "admin@example.invalid",
      }),
    ).rejects.toMatchObject({ code: CONSENT_REASON_REQUIRED });
    expect(writePort.calls).toHaveLength(0);
    expect(auditPort.events).toHaveLength(0);
  });

  it("rejects a decision for a request that does not exist", async () => {
    const { service } = makeService();
    await expect(
      service.decide({
        tenantId: TENANT_1,
        requestId: "missing",
        decision: CONSENT_DECISION_APPROVE,
        actor: "admin@example.invalid",
      }),
    ).rejects.toMatchObject({ code: CONSENT_REQUEST_NOT_FOUND });
  });

  it("rejects an invalid decision value", async () => {
    const { service } = makeService();
    await expect(
      service.decide({
        tenantId: TENANT_1,
        requestId: "req-1",
        decision: "maybe" as never,
        actor: "admin@example.invalid",
      }),
    ).rejects.toMatchObject({ code: "consent.decision_invalid" });
  });

  it("persists decisions per tenant", async () => {
    const { service } = makeService({
      requests: [request(), request({ id: "req-2", tenantId: TENANT_2 })],
    });
    await service.decide({ tenantId: TENANT_1, requestId: "req-1", decision: CONSENT_DECISION_APPROVE, actor: "a" });
    await service.decide({ tenantId: TENANT_2, requestId: "req-2", decision: CONSENT_DECISION_DENY, actor: "b", reason: "no" });
    const d1 = await service.listDecisions(TENANT_1);
    const d2 = await service.listDecisions(TENANT_2);
    expect(d1).toHaveLength(1);
    expect(d2).toHaveLength(1);
    expect(d1[0]?.tenantId).toBe(TENANT_1);
    expect(d2[0]?.tenantId).toBe(TENANT_2);
  });
});

describe("app-approval-routes", () => {
  function routeFor(opts: Parameters<typeof createAppApprovalRoutes>[0], method: string) {
    const route = createAppApprovalRoutes(opts).find((r) => r.method === method && r.path === CONSENT_REQUESTS_PATH);
    if (!route) throw new Error(`${method} route not found`);
    return route;
  }

  it("GET lists pending consent requests", async () => {
    const { service } = makeService();
    const route = routeFor(makeRouteOptions(service), "GET");
    const res = await route.handler(ctx("GET", `/v1/tenants/${TENANT_1}/consent-requests`));
    expect(res.status).toBe(200);
    const body = res.body as { items: ConsentRequest[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.appName).toBe("Contoso App");
  });

  it("GET requires the CIPP.Admin.* scope", async () => {
    const { service } = makeService();
    const route = routeFor(
      makeRouteOptions(service, { authorize: denyAll }),
      "GET",
    );
    await expect(
      route.handler(ctx("GET", `/v1/tenants/${TENANT_1}/consent-requests`)),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("POST approves and returns the decision with its audit event", async () => {
    const { service } = makeService();
    const route = routeFor(makeRouteOptions(service), "POST");
    const res = await route.handler(
      ctx("POST", `/v1/tenants/${TENANT_1}/consent-requests`, {
        requestId: "req-1",
        decision: "approve",
      }),
    );
    expect(res.status).toBe(200);
    const body = res.body as { decision: { decision: string }; auditEvent: { action: string } };
    expect(body.decision.decision).toBe("approve");
    expect(body.auditEvent.action).toBe("consent.approve");
  });

  it("POST deny without a reason is rejected", async () => {
    const { service } = makeService();
    const route = routeFor(makeRouteOptions(service), "POST");
    await expect(
      route.handler(
        ctx("POST", `/v1/tenants/${TENANT_1}/consent-requests`, {
          requestId: "req-1",
          decision: "deny",
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: CONSENT_REASON_REQUIRED });
  });

  it("POST requires the CIPP.Admin.* scope", async () => {
    const { service } = makeService();
    const route = routeFor(
      makeRouteOptions(service, { authorize: denyAll }),
      "POST",
    );
    await expect(
      route.handler(
        ctx("POST", `/v1/tenants/${TENANT_1}/consent-requests`, {
          requestId: "req-1",
          decision: "approve",
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("POST requires an authenticated caller", async () => {
    const { service } = makeService();
    const route = routeFor(
      makeRouteOptions(service, { resolveCaller: () => undefined }),
      "POST",
    );
    await expect(
      route.handler(
        ctx("POST", `/v1/tenants/${TENANT_1}/consent-requests`, {
          requestId: "req-1",
          decision: "approve",
        }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("POST rejects an unknown request with 404", async () => {
    const { service } = makeService();
    const route = routeFor(makeRouteOptions(service), "POST");
    await expect(
      route.handler(
        ctx("POST", `/v1/tenants/${TENANT_1}/consent-requests`, {
          requestId: "missing",
          decision: "approve",
        }),
      ),
    ).rejects.toMatchObject({ status: 404, code: CONSENT_REQUEST_NOT_FOUND });
  });
});
