// T-0663 — domain add/verify/remove/set-default writes through the EPIC-006
// apply contract: domains.write gate, tenant scope, confirmation, dry-run
// default, Idempotency-Key replay, and per-write audit events.

import { describe, expect, it } from "vitest";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import { type Caller } from "../rbac/authorize.js";
import type { RequestContext } from "../server.js";
import {
  DOMAINS_ACTIONS_OPENAPI,
  DOMAINS_ADD_PATH,
  DOMAINS_WRITE_PERMISSION,
  DOMAIN_DEFAULT_PATH,
  DOMAIN_REMOVE_PATH,
  DOMAIN_VERIFY_PATH,
  createDomainsActionsRoutes,
  type DomainActionOutcome,
  type DomainActionProvider,
  type DomainActionRequest,
} from "./domains-actions.js";

const TENANT_1 = "11111111-1111-1111-1111-111111111111";
const TENANT_2 = "22222222-2222-2222-2222-222222222222";
const DOMAIN = "contoso.com";

class FakeDomainActionProvider implements DomainActionProvider {
  readonly calls: DomainActionRequest[] = [];
  readonly outcome: DomainActionOutcome;

  constructor(outcome?: Partial<DomainActionOutcome>) {
    this.outcome = {
      tenantId: TENANT_1,
      domain: DOMAIN,
      action: "add",
      status: "applied",
      verificationRecords: [
        { recordType: "Txt", label: DOMAIN, text: "MS=ms987654321", ttl: 3600 },
        { recordType: "Mx", label: DOMAIN, mailExchange: "contoso-com.mail.protection.outlook.com", preference: 0, ttl: 3600 },
      ],
      code: null,
      error: null,
      auditEvent: {
        tenantId: TENANT_1,
        action: "domains.action:add",
        targetType: "domain",
        targetId: DOMAIN,
        result: "success",
        error: null,
        actor: "user-1",
        correlationId: "corr-1",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      ...outcome,
    };
  }

  async run(tenantId: string, request: DomainActionRequest): Promise<DomainActionOutcome> {
    this.calls.push(request);
    return { ...this.outcome, tenantId, action: request.action, domain: request.domain };
  }
}

function adminCaller(): Caller {
  return { roles: ["admin"], tenantScope: ALL_TENANTS };
}

function scopedCaller(tenantIds: string[]): Caller {
  return { roles: ["operator"], tenantScope: tenantScope(tenantIds) };
}

function allowAll(): boolean {
  return true;
}

function denyAll(): boolean {
  return false;
}

function context(
  path: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
    params?: Record<string, string>;
    idempotencyKey?: string;
  } = {},
): RequestContext & { body?: unknown } {
  const headers: Record<string, string> = {};
  if (options.idempotencyKey !== undefined) headers["idempotency-key"] = options.idempotencyKey;
  return {
    correlationId: "corr-domain-1",
    method: options.method ?? "POST",
    path,
    query: new URLSearchParams(),
    headers,
    params: options.params ?? {},
    body: options.body,
  };
}

function routeFor(
  opts: Parameters<typeof createDomainsActionsRoutes>[0],
  method: string,
  path: string,
) {
  const route = createDomainsActionsRoutes(opts).find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`route not found: ${method} ${path}`);
  return route;
}

function baseOptions(provider: FakeDomainActionProvider, overrides: Record<string, unknown> = {}) {
  return {
    provider,
    resolveCaller: () => adminCaller(),
    authorize: allowAll,
    ...overrides,
  };
}

// A live write under the EPIC-006 contract: dryRun explicitly off, confirmed.
function addContext(body: Record<string, unknown> = { domain: DOMAIN, confirm: true, dryRun: false }, idempotencyKey?: string) {
  return context(DOMAINS_ADD_PATH, { body, params: { tenantId: TENANT_1 }, idempotencyKey });
}

describe("POST /v1/tenants/:tenantId/domains (T-0663 add)", () => {
  it("runs the add and returns the verification records with the audit event recorded", async () => {
    const provider = new FakeDomainActionProvider();
    const audited: Record<string, unknown>[] = [];
    const route = routeFor(baseOptions(provider, { recordAudit: async (e) => void audited.push(e) }), "POST", DOMAINS_ADD_PATH);

    const res = await route.handler(addContext({ domain: DOMAIN, confirm: true, dryRun: false }, "key-1"));

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.status).toBe("applied");
    const records = body.verificationRecords as Record<string, unknown>[];
    expect(records).toHaveLength(2);
    expect(records[0]!.recordType).toBe("Txt");
    expect(records[1]!.recordType).toBe("Mx");

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.action).toBe("add");
    expect(provider.calls[0]!.domain).toBe(DOMAIN);
    expect(provider.calls[0]!.dryRun).toBe(false);
    expect(provider.calls[0]!.confirmed).toBe(true);

    expect(audited).toHaveLength(1);
    expect(audited[0]!.action).toBe("domains.action:add");
    expect(audited[0]!.targetType).toBe("domain");
    expect(audited[0]!.result).toBe("success");
  });

  it("defaults dryRun to true when the body omits it and writes no audit", async () => {
    const provider = new FakeDomainActionProvider({ status: "planned", verificationRecords: null, auditEvent: null });
    const audited: Record<string, unknown>[] = [];
    const route = routeFor(baseOptions(provider, { recordAudit: async (e) => void audited.push(e) }), "POST", DOMAINS_ADD_PATH);

    const res = await route.handler(addContext({ domain: DOMAIN }, "key-1"));

    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).status).toBe("planned");
    expect(provider.calls[0]!.dryRun).toBe(true);
    expect(audited).toHaveLength(0);
  });

  it("requires confirmation for a non-dry-run add", async () => {
    const provider = new FakeDomainActionProvider();
    const route = routeFor(baseOptions(provider), "POST", DOMAINS_ADD_PATH);

    await expect(route.handler(addContext({ domain: DOMAIN, dryRun: false }))).rejects.toMatchObject({ status: 400 });
    expect(provider.calls).toHaveLength(0);
  });

  it("requires the domain in the body", async () => {
    const provider = new FakeDomainActionProvider();
    const route = routeFor(baseOptions(provider), "POST", DOMAINS_ADD_PATH);

    await expect(route.handler(addContext({ confirm: true, dryRun: false }))).rejects.toMatchObject({ status: 400 });
    expect(provider.calls).toHaveLength(0);
  });
});

describe("verify, remove, and set-default (T-0663)", () => {
  it("verify executes through the contract and records the audit event", async () => {
    const provider = new FakeDomainActionProvider({
      action: "verify",
      verificationRecords: null,
      auditEvent: { tenantId: TENANT_1, action: "domains.action:verify", result: "success" },
    });
    const audited: Record<string, unknown>[] = [];
    const route = routeFor(baseOptions(provider, { recordAudit: async (e) => void audited.push(e) }), "POST", DOMAIN_VERIFY_PATH);

    const res = await route.handler(
      context(DOMAIN_VERIFY_PATH, {
        body: { confirm: true, dryRun: false },
        params: { tenantId: TENANT_1, domain: DOMAIN },
        idempotencyKey: "key-verify",
      }),
    );

    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).action).toBe("verify");
    expect(provider.calls[0]!.action).toBe("verify");
    expect(audited).toHaveLength(1);
    expect(audited[0]!.action).toBe("domains.action:verify");
  });

  it("remove executes through the contract with DELETE and records the audit event", async () => {
    const provider = new FakeDomainActionProvider({
      action: "remove",
      verificationRecords: null,
      auditEvent: { tenantId: TENANT_1, action: "domains.action:remove", result: "success" },
    });
    const audited: Record<string, unknown>[] = [];
    const route = routeFor(baseOptions(provider, { recordAudit: async (e) => void audited.push(e) }), "DELETE", DOMAIN_REMOVE_PATH);

    const res = await route.handler(
      context(DOMAIN_REMOVE_PATH, {
        method: "DELETE",
        body: { confirm: true, dryRun: false },
        params: { tenantId: TENANT_1, domain: DOMAIN },
        idempotencyKey: "key-remove",
      }),
    );

    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).action).toBe("remove");
    expect(provider.calls[0]!.action).toBe("remove");
    expect(audited).toHaveLength(1);
    expect(audited[0]!.action).toBe("domains.action:remove");
  });

  it("set-default executes through the contract and records the audit event", async () => {
    const provider = new FakeDomainActionProvider({
      action: "setDefault",
      verificationRecords: null,
      auditEvent: { tenantId: TENANT_1, action: "domains.action:setDefault", result: "success" },
    });
    const audited: Record<string, unknown>[] = [];
    const route = routeFor(baseOptions(provider, { recordAudit: async (e) => void audited.push(e) }), "POST", DOMAIN_DEFAULT_PATH);

    const res = await route.handler(
      context(DOMAIN_DEFAULT_PATH, {
        body: { confirm: true, dryRun: false },
        params: { tenantId: TENANT_1, domain: DOMAIN },
        idempotencyKey: "key-default",
      }),
    );

    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).action).toBe("setDefault");
    expect(provider.calls[0]!.action).toBe("setDefault");
    expect(audited).toHaveLength(1);
    expect(audited[0]!.action).toBe("domains.action:setDefault");
  });

  it("requires confirmation for verify, remove, and set-default", async () => {
    const provider = new FakeDomainActionProvider();
    for (const [method, path] of [
      ["POST", DOMAIN_VERIFY_PATH],
      ["DELETE", DOMAIN_REMOVE_PATH],
      ["POST", DOMAIN_DEFAULT_PATH],
    ] as const) {
      const route = routeFor(baseOptions(provider), method, path);
      await expect(
        route.handler(
          context(path, { method, body: { dryRun: false }, params: { tenantId: TENANT_1, domain: DOMAIN }, idempotencyKey: "k" }),
        ),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(provider.calls).toHaveLength(0);
  });
});

describe("gates and Idempotency-Key (T-0663, EPIC-006 contract)", () => {
  it("returns 401 when unauthenticated", async () => {
    const provider = new FakeDomainActionProvider();
    const route = routeFor(baseOptions(provider, { resolveCaller: () => undefined }), "POST", DOMAINS_ADD_PATH);
    await expect(route.handler(addContext())).rejects.toMatchObject({ status: 401 });
  });

  it("returns 403 without domains.write", async () => {
    const provider = new FakeDomainActionProvider();
    const route = routeFor(baseOptions(provider, { authorize: denyAll }), "POST", DOMAINS_ADD_PATH);
    await expect(route.handler(addContext())).rejects.toMatchObject({ status: 403 });
    expect(provider.calls).toHaveLength(0);
  });

  it("returns 403 when the tenant is outside the caller scope", async () => {
    const provider = new FakeDomainActionProvider();
    const route = routeFor(
      baseOptions(provider, { resolveCaller: () => scopedCaller([TENANT_2]) }),
      "POST",
      DOMAINS_ADD_PATH,
    );
    await expect(route.handler(addContext())).rejects.toMatchObject({ status: 403 });
    expect(provider.calls).toHaveLength(0);
  });

  it("requires an Idempotency-Key", async () => {
    const provider = new FakeDomainActionProvider();
    const route = routeFor(baseOptions(provider), "POST", DOMAINS_ADD_PATH);
    await expect(route.handler(addContext())).rejects.toMatchObject({ status: 400 });
    expect(provider.calls).toHaveLength(0);
  });

  it("replays the prior outcome for a repeated Idempotency-Key without re-running the worker", async () => {
    const provider = new FakeDomainActionProvider();
    const route = routeFor(baseOptions(provider), "POST", DOMAINS_ADD_PATH);

    const first = await route.handler(addContext({ domain: DOMAIN, confirm: true, dryRun: false }, "same-key"));
    const second = await route.handler(addContext({ domain: DOMAIN, confirm: true, dryRun: false }, "same-key"));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((second.body as Record<string, unknown>).replayed).toBe(true);
    expect((second.body as Record<string, unknown>).status).toBe(
      (first.body as Record<string, unknown>).status,
    );
    expect(provider.calls).toHaveLength(1);
  });

  it("scopes the replay to the tenant: the same key under another tenant re-runs", async () => {
    const provider = new FakeDomainActionProvider();
    const route = routeFor(baseOptions(provider), "POST", DOMAINS_ADD_PATH);

    await route.handler(addContext({ domain: DOMAIN, confirm: true, dryRun: false }, "shared-key"));
    const second = await route.handler(
      context(DOMAINS_ADD_PATH, {
        body: { domain: DOMAIN, confirm: true, dryRun: false },
        params: { tenantId: TENANT_2 },
        idempotencyKey: "shared-key",
      }),
    );

    expect((second.body as Record<string, unknown>).replayed).toBeUndefined();
    expect(provider.calls).toHaveLength(2);
  });

  it("returns 400 for a non-boolean dryRun", async () => {
    const provider = new FakeDomainActionProvider();
    const route = routeFor(baseOptions(provider), "POST", DOMAINS_ADD_PATH);
    await expect(
      route.handler(addContext({ domain: DOMAIN, confirm: true, dryRun: "yes" }, "key-1")),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("route set (T-0663)", () => {
  it("exposes the four domain write operations", () => {
    const routes = createDomainsActionsRoutes(baseOptions(new FakeDomainActionProvider()));
    const keys = routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(keys).toEqual(
      [
        `DELETE ${DOMAIN_REMOVE_PATH}`,
        `POST ${DOMAINS_ADD_PATH}`,
        `POST ${DOMAIN_DEFAULT_PATH}`,
        `POST ${DOMAIN_VERIFY_PATH}`,
      ].sort(),
    );
  });

  it("publishes every operation with the domains.write permission", () => {
    const paths = DOMAINS_ACTIONS_OPENAPI.paths;
    expect(paths["/tenants/{tenantId}/domains"].post.permission).toBe(DOMAINS_WRITE_PERMISSION);
    expect(paths["/tenants/{tenantId}/domains/{domain}/verify"].post.permission).toBe(DOMAINS_WRITE_PERMISSION);
    expect(paths["/tenants/{tenantId}/domains/{domain}"].delete.permission).toBe(DOMAINS_WRITE_PERMISSION);
    expect(paths["/tenants/{tenantId}/domains/{domain}/default"].post.permission).toBe(DOMAINS_WRITE_PERMISSION);
  });
});
