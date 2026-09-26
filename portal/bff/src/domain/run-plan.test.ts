import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import type { Caller } from "../rbac/authorize.js";
import {
  CLI_DEFAULT_SECTIONS,
  assertTenantsInScope,
  buildRunPlan,
  expandTargetTenants,
  resolveSections,
  type GroupMemberResolver,
  type RunCreateRequest,
} from "./run-plan.js";

const TENANT_1 = "11111111-1111-1111-1111-111111111111";
const TENANT_2 = "22222222-2222-2222-2222-222222222222";
const TENANT_3 = "33333333-3333-3333-3333-333333333333";
const GROUP_1 = "group-uuid-1";

function adminCaller(): Caller {
  return { roles: ["admin"], tenantScope: ALL_TENANTS };
}

function scopedCaller(tenantIds: string[]): Caller {
  return { roles: ["operator"], tenantScope: tenantScope(tenantIds) };
}

class FakeGroupResolver implements GroupMemberResolver {
  readonly groups = new Map<string, string[]>();

  async resolveGroupMembers(groupId: string): Promise<readonly string[]> {
    return this.groups.get(groupId) ?? [];
  }
}

describe("run-plan domain (T-0043)", () => {
  it("expands direct tenants and deduplicates them", async () => {
    const request: RunCreateRequest = {
      tenantId: TENANT_1,
      tenantIds: [TENANT_1, TENANT_2],
      tenants: [TENANT_2, TENANT_3],
    };
    const expanded = await expandTargetTenants(request);
    expect(expanded).toHaveLength(3);
    expect(expanded).toContain(TENANT_1);
    expect(expanded).toContain(TENANT_2);
    expect(expanded).toContain(TENANT_3);
  });

  it("expands group members via GroupMemberResolver", async () => {
    const resolver = new FakeGroupResolver();
    resolver.groups.set(GROUP_1, [TENANT_1, TENANT_2]);

    const request: RunCreateRequest = {
      groups: [GROUP_1],
    };
    const expanded = await expandTargetTenants(request, resolver);
    expect(expanded).toEqual([TENANT_1, TENANT_2]);
  });

  it("throws 400 when no tenants or groups are specified", async () => {
    await expect(expandTargetTenants({})).rejects.toMatchObject({
      status: 400,
      code: "run.missing_tenants",
    });
  });

  it("applies CLI default sections when omitted or empty", () => {
    expect(resolveSections()).toEqual(CLI_DEFAULT_SECTIONS);
    expect(resolveSections([])).toEqual(CLI_DEFAULT_SECTIONS);
    expect(resolveSections(["Identity"])).toEqual(["Identity"]);
  });

  it("rejects when any tenant is outside the caller scope with 403", () => {
    const caller = scopedCaller([TENANT_1, TENANT_2]);
    // Within scope -> succeeds
    expect(() => assertTenantsInScope(caller, [TENANT_1, TENANT_2])).not.toThrow();

    // Tenant outside scope -> throws 403
    expect(() => assertTenantsInScope(caller, [TENANT_1, TENANT_3])).toThrow(AppError);
    try {
      assertTenantsInScope(caller, [TENANT_1, TENANT_3]);
    } catch (err) {
      const appErr = err as AppError;
      expect(appErr.status).toBe(403);
      expect(appErr.code).toBe("auth.forbidden");
    }
  });

  it("builds a plan for single and multi-tenant runs with one job per tenant", async () => {
    let seq = 0;
    const idGenerator = () => {
      seq += 1;
      return { runId: `run-${seq}`, jobId: `job-${seq}`, requestId: `req-${seq}` };
    };

    const request: RunCreateRequest = {
      tenantIds: [TENANT_1, TENANT_2],
      trigger: "manual",
      options: { quickScan: true, redact: false, skipPurview: true },
    };

    const plan = await buildRunPlan({
      request,
      caller: adminCaller(),
      idGenerator,
    });

    expect(plan.parentRunId).toBe("run-1");
    expect(plan.sections).toEqual(CLI_DEFAULT_SECTIONS);
    expect(plan.options).toEqual({ quickScan: true, redact: false, skipPurview: true });
    expect(plan.targets).toHaveLength(2);

    expect(plan.targets[0].tenantId).toBe(TENANT_1);
    expect(plan.targets[0].runId).toBe("run-2");
    expect(plan.targets[0].jobId).toBe("job-2");
    expect(plan.targets[0].envelope.jobId).toBe("job-2");
    expect(plan.targets[0].envelope.tenantId).toBe(TENANT_1);

    expect(plan.targets[1].tenantId).toBe(TENANT_2);
    expect(plan.targets[1].runId).toBe("run-3");
    expect(plan.targets[1].jobId).toBe("job-3");
    expect(plan.targets[1].envelope.jobId).toBe("job-3");
    expect(plan.targets[1].envelope.tenantId).toBe(TENANT_2);
  });
});
