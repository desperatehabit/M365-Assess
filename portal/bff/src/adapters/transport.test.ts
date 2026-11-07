import { describe, expect, it } from "vitest";
import type { CredentialRecord, CredentialStoreRow } from "../routes/credentials.js";
import { createTransportProviders } from "./transport.js";
import type { WorkerRunner } from "./workers.js";

const CREDENTIAL: CredentialRecord = {
  id: "c-1",
  tenantId: "t-a",
  authMethod: "certificate-thumbprint",
  clientId: "app-1",
  secretRef: "thumbprint://ABC",
  thumbprint: "ABC",
  environment: "commercial",
  expiresOn: null,
  lastValidated: null,
  createdAt: "",
  updatedAt: "",
};

const credentials: CredentialStoreRow = {
  getCredential: async (tenantId) => (tenantId === "t-a" ? CREDENTIAL : undefined),
  upsertCredential: async (input) => input,
  appendAuditEvent: async () => undefined,
};

interface Call {
  readonly entrypoint: string;
  readonly job: Record<string, unknown>;
}

function harness(handler: (entrypoint: string, job: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const run: WorkerRunner = async <T>(entrypoint: string, job: Record<string, unknown>): Promise<T> => {
    calls.push({ entrypoint, job });
    return handler(entrypoint, job) as T;
  };
  return { calls, providers: createTransportProviders(run, credentials) };
}

describe("transport and connector providers (T-0851)", () => {
  it("lists transport rules with the route filters", async () => {
    const { calls, providers } = harness(() => ({
      tenantId: "t-a",
      totalCount: 1,
      items: [
        {
          id: "rule-1",
          name: "Block high risk",
          priority: 0,
          state: "enabled",
          conditions: [],
          actions: [],
          exceptions: [],
          lastModified: null,
        },
      ],
      nextCursor: "",
    }));

    const page = await providers.rules.listTransportRules("t-a", {
      search: "block",
      state: "enabled",
      cursor: null,
      limit: 25,
    });

    expect(page).toMatchObject({ tenantId: "t-a", totalCount: 1, nextCursor: null });
    expect(page.items[0]?.name).toBe("Block high risk");
    expect(calls[0]!.entrypoint).toBe("get-transport-rules.ps1");
    expect(calls[0]!.job).toMatchObject({ tenantId: "t-a", search: "block", state: "enabled", top: 25 });
    expect(calls[0]!.job["credential"]).toMatchObject({ record: { tenantId: "t-a" } });
  });

  it("previews a transport rule create with dryRun and JSON field payloads", async () => {
    const { calls, providers } = harness(() => ({
      action: "create",
      targetName: "Block high risk",
      diff: ["create rule"],
      valid: true,
      dryRun: true,
      requiresConfirmation: true,
    }));

    const outcome = await providers.rulesWrite.createRule(
      "t-a",
      {
        name: "Block high risk",
        enabled: true,
        priority: 0,
        conditions: { subjectContainsWords: ["wire"] },
        actions: { rejectMessageReasonText: "Blocked" },
      },
      true,
    );

    expect(outcome).toMatchObject({ action: "create", dryRun: true });
    expect(calls[0]!.entrypoint).toBe("set-transport-rule.ps1");
    expect(calls[0]!.job).toMatchObject({
      action: "create",
      name: "Block high risk",
      enabled: true,
      priority: 0,
      dryRun: true,
      confirmed: false,
      conditionsJson: JSON.stringify({ subjectContainsWords: ["wire"] }),
      actionsJson: JSON.stringify({ rejectMessageReasonText: "Blocked" }),
    });
  });

  it("edits and deletes rules through the same worker", async () => {
    const { calls, providers } = harness((_entrypoint, job) => ({
      action: job["action"],
      targetName: "Rule",
      diff: [],
      valid: true,
      dryRun: Boolean(job["dryRun"]),
      requiresConfirmation: false,
    }));

    await providers.rulesWrite.editRule("t-a", "rule-1", { enabled: false }, false);
    await providers.rulesWrite.deleteRule("t-a", "rule-1", false);

    expect(calls[0]!.job).toMatchObject({
      action: "edit",
      ruleId: "rule-1",
      enabled: false,
      dryRun: false,
      confirmed: true,
    });
    expect(calls[1]!.job).toMatchObject({ action: "delete", ruleId: "rule-1", confirmed: true });
  });

  it("lists connectors with type and state filters", async () => {
    const { calls, providers } = harness(() => ({
      tenantId: "t-a",
      totalCount: 1,
      items: [
        {
          id: "conn-1",
          name: "Partner inbound",
          type: "inbound",
          state: "enabled",
          from: "contoso.com",
          to: null,
          tls: true,
          lastModified: null,
        },
      ],
      nextCursor: "",
    }));

    const page = await providers.connectors.listConnectors("t-a", {
      search: "partner",
      type: "inbound",
      state: "enabled",
      cursor: null,
      limit: 50,
    });

    expect(page).toMatchObject({ tenantId: "t-a", totalCount: 1, nextCursor: null });
    expect(calls[0]!.entrypoint).toBe("get-connectors.ps1");
    expect(calls[0]!.job).toMatchObject({
      search: "partner",
      type: "inbound",
      state: "enabled",
      top: 50,
    });
  });

  it("creates and disables connectors through set-connector.ps1", async () => {
    const { calls, providers } = harness((_entrypoint, job) => ({
      success: true,
      plan: {
        action: job["action"],
        targetName: "Partner",
        diff: [],
        valid: true,
        dryRun: Boolean(job["dryRun"]),
        requiresConfirmation: false,
      },
    }));

    await providers.connectors.createConnector(
      "t-a",
      {
        name: "Partner",
        type: "inbound",
        senderDomains: "contoso.com",
        requireTls: true,
        enabled: true,
      },
      false,
    );
    await providers.connectors.editConnector("t-a", "conn-1", { action: "disable" }, false);
    await providers.connectors.deleteConnector("t-a", "conn-1", false);

    expect(calls[0]!.entrypoint).toBe("set-connector.ps1");
    expect(calls[0]!.job).toMatchObject({
      action: "create",
      name: "Partner",
      type: "inbound",
      senderDomains: "contoso.com",
      requireTls: true,
      enabled: true,
      confirmed: true,
    });
    expect(calls[1]!.job).toMatchObject({ action: "disable", connectorId: "conn-1" });
    expect(calls[2]!.job).toMatchObject({ action: "delete", connectorId: "conn-1" });
  });

  it("deploys a transport template to one target and returns its audit event", async () => {
    const { calls, providers } = harness(() => ({
      success: true,
      state: "succeeded",
      tenantId: "t-a",
      auditEvent: {
        id: "evt-1",
        tenantId: "t-a",
        action: "transport.template.deploy.rule",
        targetId: "template-1",
        targetName: "Template",
        actor: "user-1",
        timestamp: "2026-01-01T00:00:00Z",
        before: null,
        after: { name: "Rule" },
      },
    }));

    const outcome = await providers.deploy.apply({
      kind: "transport-rule",
      templateId: "template-1",
      tenantId: "t-a",
      name: "Template",
      payload: { name: "Rule" },
      actor: "user-1",
    });

    expect(outcome.auditEvent["id"]).toBe("evt-1");
    expect(outcome.after).toEqual({ name: "Rule" });
    expect(calls[0]!.entrypoint).toBe("deploy-transport-template.ps1");
    expect(calls[0]!.job).toMatchObject({
      kind: "rule",
      template: { name: "Rule" },
      actor: "user-1",
      confirmed: true,
      dryRun: false,
    });
  });

  it("fails with 409 when the tenant has no credential", async () => {
    const { providers } = harness(() => ({}));

    await expect(
      providers.rules.listTransportRules("t-missing", { cursor: null, limit: 10 }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
