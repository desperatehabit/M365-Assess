import { describe, expect, it, vi } from "vitest";
import { createInMemoryDefenderDeploymentTemplateRepository } from "../repository/defender-deployment-templates.js";
import { tenantScope } from "../rbac/scope.js";
import type { RequestContext } from "../server.js";
import {
  DEFENDER_DEPLOY_PATH,
  DEFENDER_DEPLOY_WRITE_PERMISSION,
  REMEDIATION_APPLY_PERMISSION,
  createDefenderDeployRoute,
  type DefenderDeployCaller,
  type DefenderDeployOptions,
  type DefenderDeployPlan,
  type DefenderDeployProvider,
  type DefenderDeployResult,
  type DefenderDeployRouteOptions,
} from "./defender-deploy.js";

const TENANT = "tenant-test";

function areaPlan(area: string, conflict: boolean) {
  return {
    area,
    displayName: area.toUpperCase(),
    supported: true,
    action: conflict ? ("create" as const) : ("create" as const),
    policyName: `Defender ${area} Baseline`,
    targetScope: "allDevices",
    overwrite: false,
    conflict,
    conflictMessage: conflict ? `A policy named 'Defender ${area} Baseline' already exists` : null,
    diff: [`+ Policy (${area}): Defender ${area} Baseline`],
    valid: !conflict,
  };
}

class FakeDefenderDeployProvider implements DefenderDeployProvider {
  readonly planCalls: { tenantId: string; options: DefenderDeployOptions }[] = [];
  readonly deployCalls: { tenantId: string; options: DefenderDeployOptions }[] = [];
  conflictAreas: readonly string[] = [];

  async planDeploy(tenantId: string, options: DefenderDeployOptions): Promise<DefenderDeployPlan> {
    this.planCalls.push({ tenantId, options });
    const plans = options.policyAreas.map((area) =>
      areaPlan(area, !options.overwrite && this.conflictAreas.includes(area)),
    );
    return {
      tenantId,
      plans,
      allValid: plans.every((plan) => plan.valid),
      overwrite: options.overwrite,
    };
  }

  async executeDeploy(
    tenantId: string,
    options: DefenderDeployOptions,
  ): Promise<DefenderDeployResult> {
    this.deployCalls.push({ tenantId, options });
    return {
      success: true,
      state: "succeeded",
      tenantId,
      plans: options.policyAreas.map((area) => areaPlan(area, false)),
      results: options.policyAreas.map((area) => ({
        area,
        policyId: `pol-${area}`,
        action: "create",
        state: "succeeded" as const,
        error: null,
      })),
      auditEvents: options.policyAreas.map((area) => ({
        id: `audit-${area}`,
        tenantId,
        action: "defender.deploy.create",
        targetName: `Defender ${area} Baseline`,
        area,
      })),
      policyJson: Object.fromEntries(
        options.policyAreas.map((area) => [area, { baseline: true }]),
      ),
      error: null,
    };
  }
}

function callerWith(permissions: readonly string[]): DefenderDeployCaller {
  return {
    userId: "user-operator",
    roles: ["operator"],
    tenantScope: tenantScope([TENANT]),
    permissions: [...permissions],
  };
}

async function setup(
  overrides: Partial<DefenderDeployRouteOptions> = {},
  caller: DefenderDeployCaller | null = callerWith([DEFENDER_DEPLOY_WRITE_PERMISSION]),
) {
  const provider = new FakeDefenderDeployProvider();
  const recordAudit = vi.fn(async () => {});
  const templateRepository = createInMemoryDefenderDeploymentTemplateRepository();
  const route = createDefenderDeployRoute({
    provider,
    resolveCaller: () => (caller === null ? undefined : caller),
    recordAudit,
    templateRepository,
    ...overrides,
  });
  return { route, provider, recordAudit, templateRepository };
}

function context(body: unknown, paramsTenant = TENANT): RequestContext {
  return {
    correlationId: "corr-test",
    method: "POST",
    path: `/v1/tenants/${paramsTenant}/defender/deploy`,
    params: { tenantId: paramsTenant },
    query: new URLSearchParams(),
    headers: {},
    body,
  } as unknown as RequestContext;
}

describe("defender deploy route (T-0364)", () => {
  it("is mounted at POST /v1/tenants/:tenantId/defender/deploy", async () => {
    const { route } = await setup();
    expect(route.method).toBe("POST");
    expect(route.path).toBe(DEFENDER_DEPLOY_PATH);
    expect(DEFENDER_DEPLOY_PATH).toBe("/v1/tenants/:tenantId/defender/deploy");
  });

  it("rejects unauthenticated requests with 401", async () => {
    const { route } = await setup({}, null);
    await expect(
      route.handler(context({ policyAreas: ["av"], preview: true })),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("requires defender.write or Remediation.Apply and tenant scope", async () => {
    const { route } = await setup();
    await expect(
      route.handler({
        ...context({ policyAreas: ["av"], preview: true }),
      } as RequestContext),
    ).resolves.toMatchObject({ status: 200 });

    const readOnly = createDefenderDeployRoute({
      provider: new FakeDefenderDeployProvider(),
      resolveCaller: () => callerWith(["Security.Defender.Read"]),
    });
    await expect(
      readOnly.handler(context({ policyAreas: ["av"], preview: true })),
    ).rejects.toMatchObject({ status: 403 });

    const remediation = createDefenderDeployRoute({
      provider: new FakeDefenderDeployProvider(),
      resolveCaller: () => callerWith([REMEDIATION_APPLY_PERMISSION]),
    });
    await expect(
      remediation.handler(context({ policyAreas: ["av"], preview: true })),
    ).resolves.toMatchObject({ status: 200 });

    const outOfScope = createDefenderDeployRoute({
      provider: new FakeDefenderDeployProvider(),
      resolveCaller: () => ({
        ...callerWith([DEFENDER_DEPLOY_WRITE_PERMISSION]),
        tenantScope: tenantScope(["other-tenant"]),
      }),
    });
    await expect(
      outOfScope.handler(context({ policyAreas: ["av"], preview: true })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("validates policyAreas: required, known, and v1-supported", async () => {
    const { route } = await setup();
    await expect(route.handler(context({ preview: true }))).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      route.handler(context({ policyAreas: [], preview: true })),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      route.handler(context({ policyAreas: ["phishing"], preview: true })),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      route.handler(context({ policyAreas: ["compliance"], preview: true })),
    ).rejects.toMatchObject({ status: 501 });
  });

  it("previews a plan per policy area with the overwrite option", async () => {
    const { route, provider } = await setup();
    provider.conflictAreas = ["edr"];
    const res = await route.handler(
      context({ policyAreas: ["av", "edr"], targetScope: "allDevices", preview: true }),
    );
    expect(res.status).toBe(200);
    const body = res.body as unknown as {
      preview: boolean;
      plans: { area: string; valid: boolean; conflict: boolean }[];
      allValid: boolean;
    };
    expect(body.preview).toBe(true);
    expect(body.plans.map((plan) => [plan.area, plan.valid])).toEqual([
      ["av", true],
      ["edr", false],
    ]);
    expect(body.plans[1]?.conflict).toBe(true);
    expect(body.allValid).toBe(false);
    expect(provider.planCalls[0]?.options).toMatchObject({
      policyAreas: ["av", "edr"],
      overwrite: false,
    });
    expect(provider.deployCalls).toHaveLength(0);
  });

  it("clears conflicts when overwrite is on", async () => {
    const { route, provider } = await setup();
    provider.conflictAreas = ["edr"];
    const res = await route.handler(
      context({ policyAreas: ["edr"], overwrite: true, preview: true }),
    );
    const body = res.body as unknown as { allValid: boolean };
    expect(res.status).toBe(200);
    expect(body.allValid).toBe(true);
  });

  it("applies the deploy and audits each created policy", async () => {
    const { route, provider, recordAudit } = await setup();
    const res = await route.handler(context({ policyAreas: ["av", "edr", "asr"] }));
    expect(res.status).toBe(201);
    const body = res.body as unknown as {
      success: boolean;
      results: { area: string; state: string }[];
      savedTemplate: unknown;
      intuneHandoff: unknown;
    };
    expect(body.success).toBe(true);
    expect(body.results.map((result) => [result.area, result.state])).toEqual([
      ["av", "succeeded"],
      ["edr", "succeeded"],
      ["asr", "succeeded"],
    ]);
    expect(provider.deployCalls).toHaveLength(1);
    expect(recordAudit).toHaveBeenCalledTimes(3);
    expect(body.savedTemplate).toBeNull();
    expect(body.intuneHandoff).toBeNull();
  });

  it("persists a T-0363 template only when save-as-template is requested", async () => {
    const { route, templateRepository } = await setup();
    expect(await templateRepository.list(TENANT)).toHaveLength(0);

    const res = await route.handler(
      context({
        policyAreas: ["av", "asr"],
        saveAsTemplate: true,
        templateName: "Pilot baseline",
      }),
    );
    expect(res.status).toBe(201);
    const body = res.body as unknown as {
      savedTemplate: { id: string; name: string; policyAreas: string[] } | null;
      intuneHandoff: { eligible: boolean; templateId: string } | null;
    };
    expect(body.savedTemplate).toMatchObject({
      name: "Pilot baseline",
      policyAreas: ["av", "asr"],
    });
    expect(body.intuneHandoff?.eligible).toBe(true);
    expect(body.intuneHandoff?.templateId).toBe(body.savedTemplate?.id);
    expect(await templateRepository.list(TENANT)).toHaveLength(1);
  });

  it("requires templateName when save-as-template is requested", async () => {
    const { route, templateRepository } = await setup();
    await expect(
      route.handler(context({ policyAreas: ["av"], saveAsTemplate: true })),
    ).rejects.toMatchObject({ status: 400 });
    expect(await templateRepository.list(TENANT)).toHaveLength(0);
  });
});
