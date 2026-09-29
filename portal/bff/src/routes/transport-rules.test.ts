import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import {
  TRANSPORT_READ_PERMISSION,
  TRANSPORT_RULES_PATH,
  createTransportRulesRoute,
  parseTransportRulesFilter,
  type TransportRulesFilter,
  type TransportRulesPage,
  type TransportRulesProvider,
  type TransportRuleItem,
} from "./transport-rules.js";

const TENANT = "tenant-test";

const SAMPLE_RULE: TransportRuleItem = {
  id: "rule-1",
  name: "Quarantine executables",
  priority: 0,
  state: "enabled",
  conditions: ["HasAttachment=True", "AttachmentExtensionMatchesWords=exe, bat"],
  actions: ["Quarantine=True"],
  exceptions: ["ExceptIfSentToMemberOf=allow-list"],
  lastModified: "2026-09-20T12:00:00Z",
};

class FakeTransportRulesProvider implements TransportRulesProvider {
  readonly calls: Array<{ tenantId: string; filter: TransportRulesFilter }> = [];

  async listTransportRules(tenantId: string, filter: TransportRulesFilter): Promise<TransportRulesPage> {
    this.calls.push({ tenantId, filter });
    return {
      tenantId,
      totalCount: 1,
      items: [SAMPLE_RULE],
      nextCursor: null,
    };
  }
}

describe("Transport rules list route (T-0401)", () => {
  it("exposes GET /v1/tenants/:tenantId/transport-rules", () => {
    const provider = new FakeTransportRulesProvider();
    const route = createTransportRulesRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [TRANSPORT_READ_PERMISSION],
      }),
    });
    expect(route.method).toBe("GET");
    expect(route.path).toBe(TRANSPORT_RULES_PATH);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const provider = new FakeTransportRulesProvider();
    const route = createTransportRulesRoute({
      provider,
      resolveCaller: () => undefined,
    });

    await expect(
      route.handler({
        path: `/v1/tenants/${TENANT}/transport-rules`,
        method: "GET",
        headers: {},
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
      }),
    ).rejects.toThrow(AppError);
  });

  it("rejects missing transport.read permission with 403", async () => {
    const provider = new FakeTransportRulesProvider();
    const route = createTransportRulesRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["other.read"],
      }),
    });

    await expect(
      route.handler({
        path: `/v1/tenants/${TENANT}/transport-rules`,
        method: "GET",
        headers: {},
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
      }),
    ).rejects.toThrow(AppError);
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const provider = new FakeTransportRulesProvider();
    const route = createTransportRulesRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope(["tenant-other"]),
        permissions: [TRANSPORT_READ_PERMISSION],
      }),
    });

    await expect(
      route.handler({
        path: `/v1/tenants/${TENANT}/transport-rules`,
        method: "GET",
        headers: {},
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
      }),
    ).rejects.toThrow(AppError);
  });

  it("returns 200 with the §3.1 columns and cursor pagination", async () => {
    const provider = new FakeTransportRulesProvider();
    const route = createTransportRulesRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [TRANSPORT_READ_PERMISSION],
      }),
    });

    const response = await route.handler({
      path: `/v1/tenants/${TENANT}/transport-rules`,
      method: "GET",
      headers: {},
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
    });

    expect(response.status).toBe(200);
    const body = response.body as TransportRulesPage;
    expect(body.tenantId).toBe(TENANT);
    expect(body.items).toHaveLength(1);
    const row = body.items[0]!;
    expect(row.name).toBe("Quarantine executables");
    expect(row.priority).toBe(0);
    expect(row.state).toBe("enabled");
    expect(row.conditions).toContain("HasAttachment=True");
    expect(row.actions).toContain("Quarantine=True");
    expect(row.exceptions).toContain("ExceptIfSentToMemberOf=allow-list");
    expect(row.lastModified).toBe("2026-09-20T12:00:00Z");
    expect(body).toHaveProperty("nextCursor");
  });

  it("parses filter parameters and forwards to provider", async () => {
    const provider = new FakeTransportRulesProvider();
    const route = createTransportRulesRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [TRANSPORT_READ_PERMISSION],
      }),
    });

    const query = new URLSearchParams({
      search: "Quarantine",
      state: "enabled",
      cursor: "Mg",
      limit: "25",
    });

    await route.handler({
      path: `/v1/tenants/${TENANT}/transport-rules`,
      method: "GET",
      headers: {},
      params: { tenantId: TENANT },
      query,
    });

    expect(provider.calls).toHaveLength(1);
    const filter = provider.calls[0]!.filter;
    expect(filter.search).toBe("Quarantine");
    expect(filter.state).toBe("enabled");
    expect(filter.cursor).toBe("Mg");
    expect(filter.limit).toBe(25);
  });

  it("rejects an unsupported state with 400", async () => {
    const provider = new FakeTransportRulesProvider();
    const route = createTransportRulesRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [TRANSPORT_READ_PERMISSION],
      }),
    });

    await expect(
      route.handler({
        path: `/v1/tenants/${TENANT}/transport-rules`,
        method: "GET",
        headers: {},
        params: { tenantId: TENANT },
        query: new URLSearchParams({ state: "archived" }),
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(provider.calls).toHaveLength(0);
  });

  it("parses parseTransportRulesFilter directly", () => {
    const query = new URLSearchParams({
      state: "disabled",
      cursor: "Mg",
      limit: "50",
    });
    const filter = parseTransportRulesFilter(query);
    expect(filter.state).toBe("disabled");
    expect(filter.cursor).toBe("Mg");
    expect(filter.limit).toBe(50);
  });
});
