import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import {
  ENCRYPTION_APPLY_PERMISSION,
  ENCRYPTION_CONFIRM_REQUIRED,
  ENCRYPTION_PATH,
  ENCRYPTION_READ_PERMISSION,
  ENCRYPTION_TEMPLATE_NOT_FOUND,
  ENCRYPTION_UNSUPPORTED_SETTING,
  ENCRYPTION_WRITE_PERMISSION,
  createEncryptionRoutes,
  type ApplyMessageEncryptionTemplateInput,
  type EncryptionCaller,
  type EncryptionProvider,
  type MessageEncryption,
  type MessageEncryptionTemplateAuditEvent,
  type MessageEncryptionTemplatePlan,
  type MessageEncryptionTemplateResult,
} from "./encryption.js";

const TENANT = "tenant-test";
const TEMPLATE_ID = "Default";

const ENCRYPTION_CONFIG: MessageEncryption = {
  tenantId: TENANT,
  irmConfiguration: {
    identity: TENANT,
    azureRmsLicensingEnabled: true,
    internalLicensingEnabled: true,
    externalLicensingEnabled: false,
  },
  omeTemplates: [
    {
      identity: TEMPLATE_ID,
      externalMailExpiryInDays: 7,
      portalText: "This message is confidential.",
      disclaimerText: "Do not forward.",
      emailText: "Encrypted message",
      readButtonText: "Read",
      introductionText: "You received an encrypted message.",
    },
  ],
  retrievedAt: "2026-09-29T10:00:00.000Z",
};

const APPLY_PLAN: MessageEncryptionTemplatePlan = {
  action: "ome-template-apply",
  templateId: TEMPLATE_ID,
  targetName: TEMPLATE_ID,
  before: { identity: TEMPLATE_ID, portalText: "This message is confidential." },
  after: { identity: TEMPLATE_ID, portalText: "Updated portal text." },
  diff: ["portalText updated"],
  valid: true,
  dryRun: true,
  requiresConfirmation: true,
};

const APPLY_RESULT: MessageEncryptionTemplateResult = {
  success: true,
  plan: { ...APPLY_PLAN, dryRun: false, requiresConfirmation: false },
  result: { templateId: TEMPLATE_ID, state: "applied" },
  auditEvent: {
    id: "audit-encryption-1",
    tenantId: TENANT,
    action: "mail.encryption_template.apply",
    targetId: TEMPLATE_ID,
    targetName: TEMPLATE_ID,
    timestamp: "2026-09-29T10:01:00.000Z",
    before: { identity: TEMPLATE_ID, portalText: "This message is confidential." },
    after: { identity: TEMPLATE_ID, portalText: "Updated portal text." },
  },
};

class FakeEncryptionProvider implements EncryptionProvider {
  readonly readCalls: string[] = [];
  readonly applyCalls: Array<{
    tenantId: string;
    input: ApplyMessageEncryptionTemplateInput;
    preview: boolean;
  }> = [];
  applyOutcome: MessageEncryptionTemplateResult | MessageEncryptionTemplatePlan = APPLY_RESULT;
  applyError: unknown = undefined;

  async getMessageEncryption(tenantId: string): Promise<MessageEncryption | null> {
    this.readCalls.push(tenantId);
    return ENCRYPTION_CONFIG;
  }

  async applyMessageEncryptionTemplate(
    tenantId: string,
    input: ApplyMessageEncryptionTemplateInput,
    preview: boolean,
  ): Promise<MessageEncryptionTemplateResult | MessageEncryptionTemplatePlan> {
    this.applyCalls.push({ tenantId, input, preview });
    if (this.applyError !== undefined) {
      throw this.applyError;
    }
    return preview ? APPLY_PLAN : this.applyOutcome;
  }
}

function readCaller(): EncryptionCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [ENCRYPTION_READ_PERMISSION],
  };
}

function writeCaller(): EncryptionCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [ENCRYPTION_READ_PERMISSION, ENCRYPTION_WRITE_PERMISSION],
  };
}

function applyCaller(): EncryptionCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [ENCRYPTION_READ_PERMISSION, ENCRYPTION_APPLY_PERMISSION],
  };
}

interface TestContext {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

function ctxFor(path: string, body?: Record<string, unknown>, query = ""): TestContext {
  return {
    method: "PUT",
    path,
    params: { tenantId: TENANT },
    query: new URLSearchParams(query),
    headers: {},
    body,
  };
}

describe("Message encryption routes (T-0469)", () => {
  it("exposes GET and PUT encryption paths", () => {
    const routes = createEncryptionRoutes({
      provider: new FakeEncryptionProvider(),
      resolveCaller: readCaller,
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${ENCRYPTION_PATH}`,
      `PUT ${ENCRYPTION_PATH}`,
    ]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createEncryptionRoutes({
      provider: new FakeEncryptionProvider(),
      resolveCaller: () => undefined,
    });

    await expect(
      routes[0]!.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mail/encryption`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a tenant outside the caller scope with 403", async () => {
    const routes = createEncryptionRoutes({
      provider: new FakeEncryptionProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [ENCRYPTION_READ_PERMISSION],
      }),
    });

    await expect(
      routes[0]!.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mail/encryption`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("requires mailtools.read for the GET", async () => {
    const routes = createEncryptionRoutes({
      provider: new FakeEncryptionProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [],
      }),
    });

    await expect(
      routes[0]!.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mail/encryption`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("returns the IRM/OME configuration and templates from the provider", async () => {
    const provider = new FakeEncryptionProvider();
    const routes = createEncryptionRoutes({ provider, resolveCaller: readCaller });

    const response = await routes[0]!.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/mail/encryption`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(ENCRYPTION_CONFIG);
    expect(provider.readCalls).toEqual([TENANT]);
  });

  it("requires mailtools.write or Remediation.Apply for the PUT", async () => {
    const routes = createEncryptionRoutes({
      provider: new FakeEncryptionProvider(),
      resolveCaller: readCaller,
    });

    await expect(
      routes[1]!.handler(
        ctxFor(`/v1/tenants/${TENANT}/mail/encryption`, {
          settings: { portalText: "Updated portal text." },
          confirm: true,
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("permits the PUT with Remediation.Apply in place of mailtools.write", async () => {
    const provider = new FakeEncryptionProvider();
    const routes = createEncryptionRoutes({ provider, resolveCaller: applyCaller });

    const response = await routes[1]!.handler(
      ctxFor(`/v1/tenants/${TENANT}/mail/encryption`, {
        settings: { portalText: "Updated portal text." },
        confirm: true,
      }),
    );

    expect(response.status).toBe(200);
    expect(provider.applyCalls).toHaveLength(1);
  });

  it("returns the plan preview without confirmation", async () => {
    const provider = new FakeEncryptionProvider();
    const routes = createEncryptionRoutes({ provider, resolveCaller: writeCaller });

    const response = await routes[1]!.handler(
      ctxFor(`/v1/tenants/${TENANT}/mail/encryption`, {
        templateId: TEMPLATE_ID,
        settings: { portalText: "Updated portal text." },
        preview: true,
      }),
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual(APPLY_PLAN);
    expect(provider.applyCalls[0]).toMatchObject({ tenantId: TENANT, preview: true });
    expect(provider.applyCalls[0]!.input.settings).toEqual({ portalText: "Updated portal text." });
  });

  it("rejects an apply without confirmation", async () => {
    const routes = createEncryptionRoutes({
      provider: new FakeEncryptionProvider(),
      resolveCaller: writeCaller,
    });

    await expect(
      routes[1]!.handler(
        ctxFor(`/v1/tenants/${TENANT}/mail/encryption`, {
          settings: { portalText: "Updated portal text." },
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: ENCRYPTION_CONFIRM_REQUIRED });
  });

  it("rejects an empty settings object", async () => {
    const routes = createEncryptionRoutes({
      provider: new FakeEncryptionProvider(),
      resolveCaller: writeCaller,
    });

    await expect(
      routes[1]!.handler(
        ctxFor(`/v1/tenants/${TENANT}/mail/encryption`, { settings: {}, confirm: true }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("applies the change and records the audit event", async () => {
    const provider = new FakeEncryptionProvider();
    const auditEvents: MessageEncryptionTemplateAuditEvent[] = [];
    const routes = createEncryptionRoutes({
      provider,
      resolveCaller: writeCaller,
      recordAudit: (event) => {
        auditEvents.push(event);
      },
    });

    const response = await routes[1]!.handler(
      ctxFor(`/v1/tenants/${TENANT}/mail/encryption`, {
        templateId: TEMPLATE_ID,
        settings: { portalText: "Updated portal text." },
        confirm: true,
      }),
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual(APPLY_RESULT);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      tenantId: TENANT,
      action: "mail.encryption_template.apply",
      targetId: TEMPLATE_ID,
    });
    expect(provider.applyCalls[0]).toMatchObject({ tenantId: TENANT, preview: false });
  });

  it("maps an unsupported setting from the worker to a 400", async () => {
    const provider = new FakeEncryptionProvider();
    provider.applyError = new Error(
      "encryption.unsupported_setting: 'bogus' is not a supported OME template setting (code: encryption.unsupported_setting)",
    );
    const routes = createEncryptionRoutes({ provider, resolveCaller: writeCaller });

    const error = await routes[1]!
      .handler(
        ctxFor(`/v1/tenants/${TENANT}/mail/encryption`, {
          settings: { bogus: "x" },
          preview: true,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).status).toBe(400);
    expect((error as AppError).code).toBe(ENCRYPTION_UNSUPPORTED_SETTING);
  });

  it("maps a missing template from the worker to a 404", async () => {
    const provider = new FakeEncryptionProvider();
    provider.applyError = new Error(
      "NotFound: OME template 'Nope' was not found (code: encryption.template_not_found)",
    );
    const routes = createEncryptionRoutes({ provider, resolveCaller: writeCaller });

    await expect(
      routes[1]!.handler(
        ctxFor(`/v1/tenants/${TENANT}/mail/encryption`, {
          templateId: "Nope",
          settings: { portalText: "Updated portal text." },
          preview: true,
        }),
      ),
    ).rejects.toMatchObject({ status: 404, code: ENCRYPTION_TEMPLATE_NOT_FOUND });
  });
});
