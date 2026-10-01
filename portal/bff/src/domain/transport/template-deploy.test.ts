import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../errors.js";
import {
  TRANSPORT_TEMPLATE_DEPLOY_INVALID,
  TRANSPORT_TEMPLATE_DEPLOY_MISSING_VARIABLE,
  resolveTransportTemplateDeploy,
  runTransportTemplateDeploy,
  type TransportTemplateDeployExecutor,
  type TransportTemplateDeployRequest,
} from "./template-deploy.js";

const RULE_JSON = {
  name: "Block mail to %partnerDomain%",
  conditions: { recipientDomainIs: ["%partnerDomain%"] },
  actions: { rejectMessage: "%rejectText%" },
};

function request(overrides: Partial<TransportTemplateDeployRequest> = {}): TransportTemplateDeployRequest {
  return {
    kind: "transport-rule",
    templateId: "tpl-1",
    templateName: "Block partner mail",
    payload: RULE_JSON,
    declaredVariables: [
      { name: "partnerDomain" },
      { name: "rejectText", defaultValue: "Not allowed" },
    ],
    variables: { partnerDomain: "partner.example.invalid" },
    targets: ["tenant-a", "tenant-b"],
    ...overrides,
  };
}

describe("resolveTransportTemplateDeploy", () => {
  it("resolves supplied and defaulted variables and builds a per-target plan", () => {
    const resolved = resolveTransportTemplateDeploy(request());

    expect(resolved.payload).toEqual({
      name: "Block mail to partner.example.invalid",
      conditions: { recipientDomainIs: ["partner.example.invalid"] },
      actions: { rejectMessage: "Not allowed" },
    });
    expect(resolved.resolvedVariables).toEqual({
      partnerDomain: "partner.example.invalid",
      rejectText: "Not allowed",
    });
    expect(resolved.targetName).toBe("Block mail to partner.example.invalid");
    expect(resolved.targets.map((target) => target.tenantId)).toEqual(["tenant-a", "tenant-b"]);
    expect(resolved.targets[0]?.diff.join("\n")).toContain("Deploy transport rule");
    expect(resolved.targets[0]?.diff.join("\n")).toContain("partner.example.invalid");
    expect(resolved.targets[1]?.diff.join("\n")).toContain("tenant-b");
  });

  it("rejects a missing required variable before any target is planned", () => {
    let error: unknown;
    try {
      resolveTransportTemplateDeploy(request({ variables: {} }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(TRANSPORT_TEMPLATE_DEPLOY_MISSING_VARIABLE);
    expect((error as AppError).status).toBe(400);
    expect((error as AppError).details?.[0]?.field).toBe("variables.partnerDomain");
  });

  it("rejects a %token% that no variable supplies", () => {
    let error: unknown;
    try {
      resolveTransportTemplateDeploy(
        request({ declaredVariables: [], variables: {}, payload: { name: "Rule %missing%" } }),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(TRANSPORT_TEMPLATE_DEPLOY_MISSING_VARIABLE);
  });

  it("rejects a payload that does not resolve to an object", () => {
    let error: unknown;
    try {
      resolveTransportTemplateDeploy(request({ payload: "not-an-object" }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(TRANSPORT_TEMPLATE_DEPLOY_INVALID);
  });

  it("resolves connector templates too", () => {
    const resolved = resolveTransportTemplateDeploy(
      request({
        kind: "connector",
        payload: { name: "Partner %partnerDomain%", senderDomains: ["%partnerDomain%"] },
        declaredVariables: [{ name: "partnerDomain" }],
        variables: { partnerDomain: "partner.example.invalid" },
        targets: ["tenant-a"],
      }),
    );
    expect(resolved.kind).toBe("connector");
    expect(resolved.payload).toEqual({
      name: "Partner partner.example.invalid",
      senderDomains: ["partner.example.invalid"],
    });
    expect(resolved.targets[0]?.diff.join("\n")).toContain("Deploy connector");
  });
});

describe("runTransportTemplateDeploy", () => {
  it("applies per target through the gate, captures before/after, and isolates a target failure", async () => {
    const seen: string[] = [];
    const executor: TransportTemplateDeployExecutor = {
      apply: vi.fn(async (applyRequest) => {
        seen.push(applyRequest.tenantId);
        if (applyRequest.tenantId === "tenant-b") {
          throw new Error("mail flow rejected");
        }
        return {
          before: { name: "before" },
          after: { name: applyRequest.name },
          auditEvent: { id: `audit-${applyRequest.tenantId}`, action: "transport.rule.create" },
        };
      }),
    };

    const resolved = resolveTransportTemplateDeploy(
      request({ targets: ["tenant-a", "tenant-b", "tenant-c"] }),
    );
    const results = await runTransportTemplateDeploy(resolved, executor, "operator-1");

    expect(seen).toEqual(["tenant-a", "tenant-b", "tenant-c"]);
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({
      tenantId: "tenant-a",
      success: true,
      before: { name: "before" },
      auditEvent: { id: "audit-tenant-a" },
    });
    expect(results[1]).toMatchObject({
      tenantId: "tenant-b",
      success: false,
      error: "mail flow rejected",
    });
    expect(results[2]).toMatchObject({ tenantId: "tenant-c", success: true });
    expect(executor.apply).toHaveBeenCalledTimes(3);
  });
});
