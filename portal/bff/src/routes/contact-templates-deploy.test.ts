import type { ContactTemplate } from "@m365-assess/db";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import {
  CONTACT_TEMPLATE_DEPLOY_APPLY_PERMISSION,
  CONTACT_TEMPLATE_DEPLOY_OPENAPI,
  CONTACT_TEMPLATE_DEPLOY_PATH,
  CONTACT_TEMPLATE_DEPLOY_PERMISSION,
  createContactTemplateDeployRoute,
  parseDeployTargets,
  type ContactDeployPlan,
  type ContactDeployResult,
  type ContactDeployTarget,
  type ContactTemplateDeployCaller,
  type ContactTemplateDeployProvider,
  type ContactTemplateDeployStore,
} from "./contact-templates-deploy.js";

const TENANT_1 = "tenant-a";
const TENANT_2 = "tenant-b";

const TEMPLATE: ContactTemplate = {
  id: "tpl-vendor",
  name: "Vendor",
  properties: {
    displayName: "{name} Vendor",
    externalAddress: "{address}",
    type: "mailContact",
  },
  variables: { address: "default@example.invalid" },
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  deletedAt: null,
};

class FakeStore implements ContactTemplateDeployStore {
  constructor(private readonly template: ContactTemplate = TEMPLATE) {}

  async getContactTemplate(id: string): Promise<ContactTemplate | undefined> {
    if (this.template.id !== id) return undefined;
    return this.template;
  }
}

class EmptyStore implements ContactTemplateDeployStore {
  async getContactTemplate(): Promise<undefined> {
    return undefined;
  }
}

const DEFAULT_CALLER: ContactTemplateDeployCaller = {
  tenantScope: tenantScope([TENANT_1, TENANT_2]),
  permissions: [CONTACT_TEMPLATE_DEPLOY_PERMISSION],
};

/** Resolves the template tokens so the test can assert variables were forwarded. */
function resolve(template: ContactTemplate, target: ContactDeployTarget): string {
  const variables = { ...template.variables, ...target.variables };
  let name = String(template.properties["displayName"] ?? "");
  let address = String(template.properties["externalAddress"] ?? "");
  for (const [key, value] of Object.entries(variables)) {
    name = name.split(`{${key}}`).join(String(value));
    address = address.split(`{${key}}`).join(String(value));
  }
  return `${name}|${address}`;
}

class FakeProvider implements ContactTemplateDeployProvider {
  readonly planCalls: Array<{ template: ContactTemplate; targets: readonly ContactDeployTarget[] }> =
    [];
  readonly execCalls: Array<{
    template: ContactTemplate;
    targets: readonly ContactDeployTarget[];
    createdBy?: string;
  }> = [];

  constructor(private readonly failTenants: readonly string[] = []) {}

  async planDeploy(
    template: ContactTemplate,
    targets: readonly ContactDeployTarget[],
  ): Promise<readonly ContactDeployPlan[]> {
    this.planCalls.push({ template, targets });
    return targets.map((target) => {
      const [displayName, externalAddress] = resolve(template, target).split("|");
      const valid = externalAddress!.includes("@");
      return {
        tenantId: target.tenantId,
        displayName: displayName!,
        externalAddress: externalAddress!,
        type: "mailContact",
        diff: [`Create contact '${displayName}'`],
        valid,
        error: valid ? null : "externalAddress is not a valid email address",
      };
    });
  }

  async executeDeploy(
    template: ContactTemplate,
    targets: readonly ContactDeployTarget[],
    createdBy?: string,
  ): Promise<readonly ContactDeployResult[]> {
    this.execCalls.push({ template, targets, createdBy });
    return targets.map((target) => {
      const [displayName, externalAddress] = resolve(template, target).split("|");
      const failed = this.failTenants.includes(target.tenantId);
      return {
        tenantId: target.tenantId,
        status: failed ? "failed" : "created",
        displayName: displayName!,
        externalAddress: externalAddress!,
        contactId: failed ? null : `contact-${target.tenantId}`,
        error: failed ? "Authorization_RequestDenied" : null,
        auditEvent: failed
          ? { tenantId: target.tenantId, result: "failure" }
          : { tenantId: target.tenantId, result: "success" },
      };
    });
  }
}

function makeOptions(
  store: ContactTemplateDeployStore,
  provider: FakeProvider,
  caller: ContactTemplateDeployCaller | undefined,
) {
  return {
    store,
    provider,
    resolveCaller: () => caller,
  };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    method: "POST",
    path: `/v1/contact-templates/${TEMPLATE.id}/deploy`,
    params: { id: TEMPLATE.id },
    query: new URLSearchParams(),
    headers: {},
    ...overrides,
  } as Parameters<ReturnType<typeof createContactTemplateDeployRoute>["handler"]>[0];
}

describe("contact template deploy route (T-0447)", () => {
  it("exposes POST /v1/contact-templates/:id/deploy", () => {
    const route = createContactTemplateDeployRoute(
      makeOptions(new FakeStore(), new FakeProvider(), DEFAULT_CALLER),
    );
    expect(route.method).toBe("POST");
    expect(route.path).toBe(CONTACT_TEMPLATE_DEPLOY_PATH);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const route = createContactTemplateDeployRoute(
      makeOptions(new FakeStore(), new FakeProvider(), undefined),
    );
    await expect(route.handler(context({ body: { targets: [TENANT_1] } }))).rejects.toMatchObject({
      status: 401,
    });
  });

  it("rejects callers without contacts.write or Remediation.Apply with 403", async () => {
    const route = createContactTemplateDeployRoute(
      makeOptions(new FakeStore(), new FakeProvider(), {
        tenantScope: tenantScope([TENANT_1]),
        permissions: ["contacts.read"],
      }),
    );
    await expect(route.handler(context({ body: { targets: [TENANT_1] } }))).rejects.toMatchObject({
      status: 403,
    });
  });

  it("admits a caller holding only Remediation.Apply", async () => {
    const route = createContactTemplateDeployRoute(
      makeOptions(new FakeStore(), new FakeProvider(), {
        tenantScope: tenantScope([TENANT_1]),
        permissions: [CONTACT_TEMPLATE_DEPLOY_APPLY_PERMISSION],
      }),
    );
    const response = await route.handler(context({ body: { targets: [TENANT_1] }, query: new URLSearchParams("preview=true") }));
    expect(response.status).toBe(200);
  });

  it("rejects a target tenant outside caller scope with 403", async () => {
    const route = createContactTemplateDeployRoute(
      makeOptions(new FakeStore(), new FakeProvider(), {
        tenantScope: tenantScope([TENANT_1]),
        permissions: [CONTACT_TEMPLATE_DEPLOY_PERMISSION],
      }),
    );
    await expect(
      route.handler(context({ body: { targets: [TENANT_1, TENANT_2] } })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("returns 404 for a missing template", async () => {
    const route = createContactTemplateDeployRoute(
      makeOptions(new EmptyStore(), new FakeProvider(), DEFAULT_CALLER),
    );
    await expect(route.handler(context({ body: { targets: [TENANT_1] } }))).rejects.toThrow(
      AppError,
    );
  });

  it("rejects a deploy with no targets with 400", async () => {
    const route = createContactTemplateDeployRoute(
      makeOptions(new FakeStore(), new FakeProvider(), DEFAULT_CALLER),
    );
    await expect(route.handler(context({ body: {} }))).rejects.toMatchObject({ status: 400 });
  });

  it("previews resolved contacts per target and writes nothing", async () => {
    const provider = new FakeProvider();
    const route = createContactTemplateDeployRoute(
      makeOptions(new FakeStore(), provider, DEFAULT_CALLER),
    );

    const response = await route.handler(
      context({
        query: new URLSearchParams("preview=true"),
        body: {
          targets: [
            { tenantId: TENANT_1, variables: { name: "Acme", address: "acme@example.invalid" } },
            { tenantId: TENANT_2, variables: { name: "Globex" } },
          ],
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(provider.execCalls).toHaveLength(0);
    const body = response.body as {
      preview: boolean;
      allValid: boolean;
      plans: ContactDeployPlan[];
    };
    expect(body.preview).toBe(true);
    expect(body.allValid).toBe(true);
    expect(body.plans).toHaveLength(2);
    expect(body.plans[0]!.displayName).toBe("Acme Vendor");
    expect(body.plans[0]!.externalAddress).toBe("acme@example.invalid");
    // The second target inherits the template's default address.
    expect(body.plans[1]!.externalAddress).toBe("default@example.invalid");
    // Per-target variables reached the provider unchanged.
    expect(provider.planCalls[0]!.targets[0]!.variables).toEqual({
      name: "Acme",
      address: "acme@example.invalid",
    });
  });

  it("reports per-target success and failure without hiding the successes", async () => {
    const provider = new FakeProvider([TENANT_2]);
    const route = createContactTemplateDeployRoute(
      makeOptions(new FakeStore(), provider, DEFAULT_CALLER),
    );

    const response = await route.handler(
      context({
        body: {
          targets: [
            { tenantId: TENANT_1, variables: { name: "Acme", address: "acme@example.invalid" } },
            { tenantId: TENANT_2, variables: { name: "Globex", address: "globex@example.invalid" } },
          ],
        },
      }),
    );

    expect(response.status).toBe(207);
    const body = response.body as {
      results: ContactDeployResult[];
      summary: { total: number; created: number; failed: number };
      auditEvents: Array<Record<string, unknown>>;
    };
    expect(body.results).toHaveLength(2);
    expect(body.results.find((r) => r.tenantId === TENANT_1)!.status).toBe("created");
    expect(body.results.find((r) => r.tenantId === TENANT_2)!.status).toBe("failed");
    expect(body.summary).toEqual({ total: 2, created: 1, failed: 1 });
    // The failed target did not hide the success, and both were audited.
    expect(body.auditEvents).toHaveLength(2);
  });

  it("returns 200 when every target is created and 422 when every target fails", async () => {
    const okRoute = createContactTemplateDeployRoute(
      makeOptions(new FakeStore(), new FakeProvider(), DEFAULT_CALLER),
    );
    const ok = await okRoute.handler(context({ body: { targets: [TENANT_1, TENANT_2] } }));
    expect(ok.status).toBe(200);

    const failRoute = createContactTemplateDeployRoute(
      makeOptions(new FakeStore(), new FakeProvider([TENANT_1, TENANT_2]), DEFAULT_CALLER),
    );
    const fail = await failRoute.handler(context({ body: { targets: [TENANT_1, TENANT_2] } }));
    expect(fail.status).toBe(422);
    expect((fail.body as { summary: { created: number } }).summary.created).toBe(0);
  });

  it("normalises object targets, bare tenant strings, and a single tenantId", () => {
    expect(parseDeployTargets({ targets: [TENANT_1, { tenantId: TENANT_2, variables: { a: "b" } }] })).toEqual([
      { tenantId: TENANT_1, variables: {} },
      { tenantId: TENANT_2, variables: { a: "b" } },
    ]);
    expect(parseDeployTargets({ tenantId: TENANT_1, variables: { a: "b" } })).toEqual([
      { tenantId: TENANT_1, variables: { a: "b" } },
    ]);
    expect(parseDeployTargets({ targets: ["", {}] })).toEqual([]);
  });

  it("publishes the OpenAPI fragment for the deploy endpoint", () => {
    const item = CONTACT_TEMPLATE_DEPLOY_OPENAPI.paths["/contact-templates/{id}/deploy"].post;
    expect(item.operationId).toBe("deployContactTemplate");
    expect(item.permission).toBe(CONTACT_TEMPLATE_DEPLOY_PERMISSION);
  });
});
