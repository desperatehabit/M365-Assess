import { describe, expect, it } from "vitest";
import type { JobEnvelope } from "@m365-assess/contracts";
import {
  FILTER_TEMPLATES_PATH,
  FILTER_TEMPLATES_READ_PERMISSION,
  FILTER_TEMPLATES_WRITE_PERMISSION,
  createFilterTemplateRoutes,
  type FilterTemplateStore,
  type StoredFilterTemplate,
} from "./filter-templates.js";
import { tenantScope } from "../rbac/scope.js";
import type { FilterPolicy, FilterType, FiltersProvider } from "./filters.js";

const TENANT = "tenant-test";

function makeTemplate(overrides: Partial<StoredFilterTemplate> = {}): StoredFilterTemplate {
  return {
    id: "tpl-1",
    name: "Standard spam filter",
    filterType: "spam",
    policyJson: {
      name: "%POLICY_NAME%",
      enabled: true,
      settings: { spamAction: "%SPAM_ACTION%", allowedDomains: ["%DOMAIN%"] },
    },
    variables: ["DOMAIN", "SPAM_ACTION", "POLICY_NAME"],
    source: "local",
    createdBy: "operator-1",
    updatedBy: "operator-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

class FakeFilterTemplateStore implements FilterTemplateStore {
  readonly rows = new Map<string, StoredFilterTemplate>();

  async listTemplates(): Promise<StoredFilterTemplate[]> {
    return [...this.rows.values()]
      .filter((row) => row.deletedAt === null)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((row) => ({ ...row }));
  }

  async getTemplate(id: string): Promise<StoredFilterTemplate | undefined> {
    const row = this.rows.get(id);
    return row ? { ...row } : undefined;
  }

  async createTemplate(input: {
    id?: string;
    name: string;
    filterType: string;
    policyJson: unknown;
    variables?: string[];
    source?: string;
    createdBy?: string | null;
  }): Promise<StoredFilterTemplate> {
    const at = "2026-01-01T00:00:00.000Z";
    const row: StoredFilterTemplate = {
      id: input.id ?? `generated-${this.rows.size + 1}`,
      name: input.name,
      filterType: input.filterType,
      policyJson: input.policyJson,
      variables: input.variables ?? [],
      source: input.source ?? "local",
      createdBy: input.createdBy ?? null,
      updatedBy: input.createdBy ?? null,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    };
    this.rows.set(row.id, row);
    return { ...row };
  }

  async updateTemplate(
    id: string,
    input: { name?: string; filterType?: string; policyJson?: unknown; variables?: string[] },
  ): Promise<StoredFilterTemplate | undefined> {
    const existing = this.rows.get(id);
    if (!existing || existing.deletedAt !== null) return undefined;
    const next: StoredFilterTemplate = {
      ...existing,
      name: input.name ?? existing.name,
      filterType: input.filterType ?? existing.filterType,
      policyJson: input.policyJson === undefined ? existing.policyJson : input.policyJson,
      variables: input.variables ?? existing.variables,
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    this.rows.set(id, next);
    return { ...next };
  }

  async softDeleteTemplate(id: string): Promise<boolean> {
    const existing = this.rows.get(id);
    if (!existing || existing.deletedAt !== null) return false;
    this.rows.set(id, { ...existing, deletedAt: "2026-01-03T00:00:00.000Z" });
    return true;
  }

  async cloneTemplate(
    sourceId: string,
    input: { id?: string; name: string },
  ): Promise<StoredFilterTemplate | undefined> {
    const source = this.rows.get(sourceId);
    if (!source || source.deletedAt !== null) return undefined;
    const at = "2026-01-04T00:00:00.000Z";
    const row: StoredFilterTemplate = {
      ...source,
      id: input.id ?? `clone-${this.rows.size + 1}`,
      name: input.name,
      source: "local",
      createdBy: null,
      updatedBy: null,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    };
    this.rows.set(row.id, row);
    return { ...row };
  }
}

class FakeFiltersProvider implements FiltersProvider {
  readonly policies = new Map<string, FilterPolicy>();

  async getFilters(): Promise<never> {
    throw new Error("not implemented");
  }

  async getFilterPolicy(
    _tenantId: string,
    _filterType: FilterType,
    policyName: string,
  ): Promise<FilterPolicy | undefined> {
    return this.policies.get(policyName);
  }
}

function makeQueue(): { enqueue(envelope: JobEnvelope): Promise<string>; envelopes: JobEnvelope[] } {
  const envelopes: JobEnvelope[] = [];
  return {
    envelopes,
    async enqueue(envelope: JobEnvelope): Promise<string> {
      envelopes.push(envelope);
      return envelope.jobId;
    },
  };
}

function makeOptions(store: FakeFilterTemplateStore, provider: FakeFiltersProvider, queue: ReturnType<typeof makeQueue>) {
  const audited: Record<string, unknown>[] = [];
  return {
    routes: createFilterTemplateRoutes({
      store,
      provider,
      queue,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [FILTER_TEMPLATES_READ_PERMISSION, FILTER_TEMPLATES_WRITE_PERMISSION],
        userId: "operator-1",
      }),
      recordAudit: async (event: Record<string, unknown>) => {
        audited.push(event);
      },
      idGenerator: () => `id-${Math.random().toString(36).slice(2)}`,
      now: () => "2026-09-29T00:00:00.000Z",
    }),
    audited,
  };
}

function ctx(
  path: string,
  body?: unknown,
  query: URLSearchParams = new URLSearchParams(),
  params: Record<string, string> = {},
) {
  return {
    method: "POST",
    path,
    params,
    query,
    headers: {},
    body,
    correlationId: "corr-1",
  };
}

const DEPLOY_BODY = {
  tenantId: TENANT,
  variables: { DOMAIN: "example.com", SPAM_ACTION: "quarantine", POLICY_NAME: "Tenant spam filter" },
};

describe("filter template routes (T-0423)", () => {
  it("exposes the §6 template surface", () => {
    const { routes } = makeOptions(new FakeFilterTemplateStore(), new FakeFiltersProvider(), makeQueue());
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${FILTER_TEMPLATES_PATH}`,
      `POST ${FILTER_TEMPLATES_PATH}`,
      "GET /v1/filter-templates/:templateId",
      "PATCH /v1/filter-templates/:templateId",
      "DELETE /v1/filter-templates/:templateId",
      "POST /v1/filter-templates/:templateId/clone",
      "POST /v1/filter-templates/:templateId/deploy",
    ]);
  });

  it("creates, reads, updates, clones, and soft-deletes templates", async () => {
    const store = new FakeFilterTemplateStore();
    const { routes } = makeOptions(store, new FakeFiltersProvider(), makeQueue());
    const [list, create, get, update, remove, clone] = routes;

    const created = await create.handler(
      ctx("/v1/filter-templates", {
        name: "Standard spam filter",
        filterType: "spam",
        policyJson: makeTemplate().policyJson,
        variables: ["DOMAIN"],
      }),
    );
    expect(created.status).toBe(201);
    const template = created.body as Record<string, unknown>;
    expect(template["source"]).toBe("local");
    expect(template["variables"]).toEqual(["DOMAIN"]);

    const listed = await list.handler(ctx("/v1/filter-templates"));
    expect((listed.body as { items: unknown[] }).items).toHaveLength(1);

    const fetched = await get.handler(ctx(`/v1/filter-templates/${template["id"]}`, undefined, new URLSearchParams(), { templateId: String(template["id"]) }));
    expect((fetched.body as Record<string, unknown>)["name"]).toBe("Standard spam filter");

    const updated = await update.handler(
      ctx(`/v1/filter-templates/${template["id"]}`, { name: "Renamed", variables: ["DOMAIN", "IP_ALLOW"] }, new URLSearchParams(), { templateId: String(template["id"]) }),
    );
    expect(updated.status).toBe(200);
    expect((updated.body as Record<string, unknown>)["name"]).toBe("Renamed");
    expect((updated.body as Record<string, unknown>)["variables"]).toEqual(["DOMAIN", "IP_ALLOW"]);

    const cloned = await clone.handler(ctx(`/v1/filter-templates/${template["id"]}/clone`, undefined, new URLSearchParams(), { templateId: String(template["id"]) }));
    expect(cloned.status).toBe(201);
    const cloneBody = cloned.body as Record<string, unknown>;
    expect(cloneBody["name"]).toBe("Renamed (copy)");
    expect(cloneBody["id"]).not.toBe(template["id"]);
    expect(cloneBody["source"]).toBe("local");

    expect((await remove.handler(ctx(`/v1/filter-templates/${template["id"]}`, undefined, new URLSearchParams(), { templateId: String(template["id"]) }))).status).toBe(204);
    await expect(
      get.handler(ctx(`/v1/filter-templates/${template["id"]}`, undefined, new URLSearchParams(), { templateId: String(template["id"]) })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createFilterTemplateRoutes({
      store: new FakeFilterTemplateStore(),
      resolveCaller: () => undefined,
    });
    await expect(routes[0].handler(ctx("/v1/filter-templates"))).rejects.toMatchObject({ status: 401 });
  });

  it("rejects callers missing Exchange.SpamFilter.Read on reads and Exchange.SpamFilter.ReadWrite on writes", async () => {
    const readOnly = createFilterTemplateRoutes({
      store: new FakeFilterTemplateStore(),
      resolveCaller: () => ({ tenantScope: tenantScope([TENANT]), permissions: [] }),
    });
    await expect(readOnly[0].handler(ctx("/v1/filter-templates"))).rejects.toMatchObject({ status: 403 });
    await expect(
      readOnly[1].handler(ctx("/v1/filter-templates", { name: "x", filterType: "spam", policyJson: {} })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("validates create input", async () => {
    const { routes } = makeOptions(new FakeFilterTemplateStore(), new FakeFiltersProvider(), makeQueue());
    const create = routes[1]!;
    await expect(
      create.handler(ctx("/v1/filter-templates", { filterType: "spam", policyJson: {} })),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      create.handler(ctx("/v1/filter-templates", { name: "x", filterType: "nope", policyJson: {} })),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      create.handler(ctx("/v1/filter-templates", { name: "x", filterType: "spam" })),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      create.handler(ctx("/v1/filter-templates", { name: "x", filterType: "spam", policyJson: {}, variables: "DOMAIN" })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("requires at least one editable field on update", async () => {
    const store = new FakeFilterTemplateStore();
    store.rows.set("tpl-1", makeTemplate());
    const { routes } = makeOptions(store, new FakeFiltersProvider(), makeQueue());
    await expect(routes[3]!.handler(ctx("/v1/filter-templates/tpl-1", {}, new URLSearchParams(), { templateId: "tpl-1" }))).rejects.toMatchObject({
      status: 400,
    });
  });

  it("deploys a template with resolved variables through the EPIC-006 gate", async () => {
    const store = new FakeFilterTemplateStore();
    store.rows.set("tpl-1", makeTemplate());
    const provider = new FakeFiltersProvider();
    const queue = makeQueue();
    const { routes, audited } = makeOptions(store, provider, queue);

    const response = await routes[6]!.handler(ctx("/v1/filter-templates/tpl-1/deploy", DEPLOY_BODY, new URLSearchParams(), { templateId: "tpl-1" }));
    expect(response.status).toBe(202);
    const body = response.body as {
      success: boolean;
      jobId: string;
      plan: { action: string; before: unknown; after: { name: string; settings: Record<string, unknown> } };
    };
    expect(body.success).toBe(true);
    expect(body.plan.action).toBe("create");
    expect(body.plan.before).toBeNull();
    expect(body.plan.after.name).toBe("Tenant spam filter");
    expect(body.plan.after.settings).toEqual({
      spamAction: "quarantine",
      allowedDomains: ["example.com"],
    });

    expect(queue.envelopes).toHaveLength(1);
    const envelope = queue.envelopes[0]!;
    expect(envelope.jobType).toBe("remediation");
    expect(envelope.tenantId).toBe(TENANT);
    expect(envelope.payload).toMatchObject({
      operation: "apply",
      area: "filters",
      action: "create",
      filterType: "spam",
      policyName: "Tenant spam filter",
      settings: { spamAction: "quarantine", allowedDomains: ["example.com"] },
      actor: "operator-1",
    });

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      action: "filters.policy.create",
      tenantId: TENANT,
      actorUserId: "operator-1",
      targetId: "Tenant spam filter",
      before: null,
    });
    expect((audited[0]!["after"] as { name: string })["name"]).toBe("Tenant spam filter");
  });

  it("deploys as an edit with before state when the policy already exists", async () => {
    const store = new FakeFilterTemplateStore();
    store.rows.set("tpl-1", makeTemplate());
    const provider = new FakeFiltersProvider();
    provider.policies.set("Tenant spam filter", {
      name: "Tenant spam filter",
      enabled: true,
      settings: { spamAction: "movetojmf", allowedDomains: [] },
    });
    const queue = makeQueue();
    const { routes, audited } = makeOptions(store, provider, queue);

    const response = await routes[6]!.handler(ctx("/v1/filter-templates/tpl-1/deploy", DEPLOY_BODY, new URLSearchParams(), { templateId: "tpl-1" }));
    expect(response.status).toBe(202);
    const body = response.body as { plan: { action: string; before: { name: string } | null } };
    expect(body.plan.action).toBe("edit");
    expect(body.plan.before?.name).toBe("Tenant spam filter");
    expect(queue.envelopes[0]?.payload).toMatchObject({ action: "edit" });
    expect(audited[0]).toMatchObject({ action: "filters.policy.edit" });
  });

  it("rejects a deploy with a missing required variable before any gate write", async () => {
    const store = new FakeFilterTemplateStore();
    store.rows.set("tpl-1", makeTemplate());
    const queue = makeQueue();
    const { routes, audited } = makeOptions(store, new FakeFiltersProvider(), queue);

    const response = routes[6]!.handler(
      ctx("/v1/filter-templates/tpl-1/deploy", { tenantId: TENANT, variables: { DOMAIN: "example.com" } }, new URLSearchParams(), { templateId: "tpl-1" }),
    );
    await expect(response).rejects.toMatchObject({
      status: 400,
      code: "filter_template.missing_variable",
    });
    expect(queue.envelopes).toHaveLength(0);
    expect(audited).toHaveLength(0);
  });

  it("previews a deploy without enqueueing or auditing", async () => {
    const store = new FakeFilterTemplateStore();
    store.rows.set("tpl-1", makeTemplate());
    const queue = makeQueue();
    const { routes, audited } = makeOptions(store, new FakeFiltersProvider(), queue);

    const response = await routes[6]!.handler(
      ctx("/v1/filter-templates/tpl-1/deploy", { ...DEPLOY_BODY, preview: true }, new URLSearchParams(), { templateId: "tpl-1" }),
    );
    expect(response.status).toBe(200);
    const body = response.body as { dryRun: boolean; diff: string[] };
    expect(body.dryRun).toBe(true);
    expect(body.diff).toContain("Create spam filter 'Tenant spam filter'");
    expect(queue.envelopes).toHaveLength(0);
    expect(audited).toHaveLength(0);
  });

  it("requires confirmation for a security-impacting deploy", async () => {
    const store = new FakeFilterTemplateStore();
    store.rows.set(
      "tpl-2",
      makeTemplate({
        id: "tpl-2",
        policyJson: { name: "Existing", enabled: true, settings: { spamAction: "allow" } },
        variables: [],
      }),
    );
    const provider = new FakeFiltersProvider();
    provider.policies.set("Existing", {
      name: "Existing",
      enabled: true,
      settings: { spamAction: "quarantine" },
    });
    const queue = makeQueue();
    const { routes, audited } = makeOptions(store, provider, queue);
    const deploy = routes[6]!;

    await expect(
      deploy.handler(ctx("/v1/filter-templates/tpl-2/deploy", { tenantId: TENANT }, new URLSearchParams(), { templateId: "tpl-2" })),
    ).rejects.toMatchObject({ status: 400, code: "filters.confirm_required" });
    expect(queue.envelopes).toHaveLength(0);

    const confirmed = await deploy.handler(
      ctx("/v1/filter-templates/tpl-2/deploy", { tenantId: TENANT, confirm: true }, new URLSearchParams(), { templateId: "tpl-2" }),
    );
    expect(confirmed.status).toBe(202);
    expect(queue.envelopes).toHaveLength(1);
    expect(audited).toHaveLength(1);
  });

  it("rejects deploys to tenants outside the caller scope with 403", async () => {
    const store = new FakeFilterTemplateStore();
    store.rows.set("tpl-1", makeTemplate());
    const queue = makeQueue();
    const { routes } = makeOptions(store, new FakeFiltersProvider(), queue);
    await expect(
      routes[6]!.handler(ctx("/v1/filter-templates/tpl-1/deploy", { ...DEPLOY_BODY, tenantId: "other-tenant" }, new URLSearchParams(), { templateId: "tpl-1" })),
    ).rejects.toMatchObject({ status: 403 });
    expect(queue.envelopes).toHaveLength(0);
  });

  it("returns 404 when the template does not exist", async () => {
    const { routes } = makeOptions(new FakeFilterTemplateStore(), new FakeFiltersProvider(), makeQueue());
    await expect(
      routes[6]!.handler(ctx("/v1/filter-templates/missing/deploy", DEPLOY_BODY, new URLSearchParams(), { templateId: "missing" })),
    ).rejects.toMatchObject({ status: 404 });
  });
});
