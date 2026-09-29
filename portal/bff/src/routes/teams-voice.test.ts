import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import {
  REMEDIATION_APPLY_PERMISSION,
  TEAMS_VOICE_CONFIRM_REQUIRED,
  TEAMS_VOICE_LICENSE_REQUIRED,
  TEAMS_VOICE_NUMBER_ITEM_PATH,
  TEAMS_VOICE_NUMBERS_PATH,
  TEAMS_VOICE_POLICY_PATH,
  TEAMS_VOICE_WRITE_PERMISSION,
  createTeamsVoiceRoutes,
  type AssignVoiceNumberInput,
  type AssignVoicePolicyInput,
  type TeamsVoiceCaller,
  type TeamsVoiceLicenseState,
  type TeamsVoicePlan,
  type TeamsVoiceProvider,
  type TeamsVoiceResult,
  type VoiceNumber,
} from "./teams-voice.js";

const TENANT = "tenant-test";

const LICENSED: TeamsVoiceLicenseState = {
  licensed: true,
  missingPlans: [],
  activePlans: ["MCOEV"],
};

const UNLICENSED: TeamsVoiceLicenseState = {
  licensed: false,
  missingPlans: ["MCOEV"],
  activePlans: [],
};

const NUMBERS: VoiceNumber[] = [
  { id: "num-1", number: "+15550100", type: "DirectRouting", assignedTo: "user-1", state: "Assigned" },
];

const ASSIGN_PLAN: TeamsVoicePlan = {
  action: "assign",
  diff: ["Assign phone number '+15550100' to 'user-2'"],
  valid: true,
  dryRun: true,
  requiresConfirmation: false,
};

const ASSIGN_RESULT: TeamsVoiceResult = {
  success: true,
  plan: { ...ASSIGN_PLAN, dryRun: false },
  result: { targetId: "user-2", phoneNumber: "+15550100" },
  teamOperation: {
    id: "op-1",
    tenantId: TENANT,
    teamId: TENANT,
    operation: "voice.assign",
    state: "applied",
    by: null,
    at: "2026-09-28T00:00:00.000Z",
    result: "applied",
  },
  auditEvent: {
    id: "audit-1",
    tenantId: TENANT,
    action: "voice.assign",
    targetId: "user-2",
    targetName: "user-2",
    timestamp: "2026-09-28T00:00:00.000Z",
    before: { lineUri: "" },
    after: { lineUri: "+15550100" },
  },
};

const RELEASE_PLAN: TeamsVoicePlan = {
  action: "release",
  diff: ["Release phone number '+15550100' from 'user-1'"],
  valid: true,
  dryRun: true,
  requiresConfirmation: true,
};

const RELEASE_RESULT: TeamsVoiceResult = {
  success: true,
  plan: { ...RELEASE_PLAN, dryRun: false },
  result: { numberId: "num-1", phoneNumber: "+15550100" },
  teamOperation: {
    id: "op-2",
    tenantId: TENANT,
    teamId: TENANT,
    operation: "voice.release",
    state: "applied",
    by: null,
    at: "2026-09-28T00:00:00.000Z",
    result: "applied",
  },
  auditEvent: {
    id: "audit-2",
    tenantId: TENANT,
    action: "voice.release",
    targetId: "user-1",
    targetName: "user-1",
    timestamp: "2026-09-28T00:00:00.000Z",
    before: { assignedTo: "user-1" },
    after: { assignedTo: "" },
  },
};

const POLICY_PLAN: TeamsVoicePlan = {
  action: "policy",
  diff: ["Assign voice routing policy 'policy-1' to 'user-1'"],
  valid: true,
  dryRun: true,
  requiresConfirmation: false,
};

const POLICY_RESULT: TeamsVoiceResult = {
  success: true,
  plan: { ...POLICY_PLAN, dryRun: false },
  result: { targetId: "user-1", policyId: "policy-1" },
  teamOperation: {
    id: "op-3",
    tenantId: TENANT,
    teamId: TENANT,
    operation: "voice.policy",
    state: "applied",
    by: null,
    at: "2026-09-28T00:00:00.000Z",
    result: "applied",
  },
  auditEvent: {
    id: "audit-3",
    tenantId: TENANT,
    action: "voice.policy",
    targetId: "user-1",
    targetName: "user-1",
    timestamp: "2026-09-28T00:00:00.000Z",
    before: { voiceRoutingPolicy: "" },
    after: { voiceRoutingPolicy: "policy-1" },
  },
};

class FakeTeamsVoiceProvider implements TeamsVoiceProvider {
  readonly license: TeamsVoiceLicenseState;
  readonly assignCalls: Array<{ tenantId: string; input: AssignVoiceNumberInput; preview: boolean }> = [];
  readonly releaseCalls: Array<{ tenantId: string; numberId: string; preview: boolean }> = [];
  readonly policyCalls: Array<{ tenantId: string; input: AssignVoicePolicyInput; preview: boolean }> = [];
  readonly recordedAudits: Record<string, unknown>[] = [];
  readonly recordedOperations: unknown[] = [];

  constructor(license: TeamsVoiceLicenseState) {
    this.license = license;
  }

  async getLicenseState(tenantId: string) {
    void tenantId;
    return this.license;
  }

  async listNumbers(tenantId: string) {
    void tenantId;
    return { license: this.license, numbers: this.license.licensed ? NUMBERS : [] };
  }

  async assignNumber(
    tenantId: string,
    input: AssignVoiceNumberInput,
    preview: boolean,
  ): Promise<TeamsVoiceResult | TeamsVoicePlan> {
    this.assignCalls.push({ tenantId, input, preview });
    return preview ? ASSIGN_PLAN : ASSIGN_RESULT;
  }

  async releaseNumber(
    tenantId: string,
    numberId: string,
    preview: boolean,
  ): Promise<TeamsVoiceResult | TeamsVoicePlan> {
    this.releaseCalls.push({ tenantId, numberId, preview });
    return preview ? RELEASE_PLAN : RELEASE_RESULT;
  }

  async assignPolicy(
    tenantId: string,
    input: AssignVoicePolicyInput,
    preview: boolean,
  ): Promise<TeamsVoiceResult | TeamsVoicePlan> {
    this.policyCalls.push({ tenantId, input, preview });
    return preview ? POLICY_PLAN : POLICY_RESULT;
  }
}

function writerCaller(): TeamsVoiceCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [TEAMS_VOICE_WRITE_PERMISSION],
  };
}

function routeByPath(routes: ReturnType<typeof createTeamsVoiceRoutes>, method: string, path: string) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`missing route ${method} ${path}`);
  return route;
}

function optionsWith(provider: FakeTeamsVoiceProvider, caller: TeamsVoiceCaller) {
  return {
    provider,
    resolveCaller: () => caller,
    recordAudit: (event: Record<string, unknown>) => {
      provider.recordedAudits.push(event);
      return Promise.resolve();
    },
    recordTeamOperation: (operation: unknown) => {
      provider.recordedOperations.push(operation);
      return Promise.resolve();
    },
  };
}

describe("Teams Business Voice routes (T-0508)", () => {
  it("exposes the numbers and policy paths", () => {
    const routes = createTeamsVoiceRoutes(optionsWith(new FakeTeamsVoiceProvider(LICENSED), writerCaller()));
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${TEAMS_VOICE_NUMBERS_PATH}`,
      `POST ${TEAMS_VOICE_NUMBERS_PATH}`,
      `DELETE ${TEAMS_VOICE_NUMBER_ITEM_PATH}`,
      `POST ${TEAMS_VOICE_POLICY_PATH}`,
    ]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createTeamsVoiceRoutes({
      provider: new FakeTeamsVoiceProvider(LICENSED),
      resolveCaller: () => undefined,
    });
    await expect(
      routes[0]!.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/teams/voice/numbers`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const routes = createTeamsVoiceRoutes(
      optionsWith(new FakeTeamsVoiceProvider(LICENSED), {
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [TEAMS_VOICE_WRITE_PERMISSION],
      }),
    );
    await expect(
      routeByPath(routes, "POST", TEAMS_VOICE_NUMBERS_PATH).handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/teams/voice/numbers`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { phoneNumber: "+15550100", targetId: "user-2" },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing teams.voice with 403", async () => {
    const routes = createTeamsVoiceRoutes(
      optionsWith(new FakeTeamsVoiceProvider(LICENSED), {
        tenantScope: tenantScope([TENANT]),
        permissions: ["teams.read"],
      }),
    );
    await expect(
      routeByPath(routes, "POST", TEAMS_VOICE_NUMBERS_PATH).handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/teams/voice/numbers`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { phoneNumber: "+15550100", targetId: "user-2" },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("accepts Remediation.Apply through the EPIC-006 gate", async () => {
    const provider = new FakeTeamsVoiceProvider(LICENSED);
    const routes = createTeamsVoiceRoutes(
      optionsWith(provider, {
        tenantScope: tenantScope([TENANT]),
        permissions: [REMEDIATION_APPLY_PERMISSION],
      }),
    );
    const response = await routeByPath(routes, "POST", TEAMS_VOICE_NUMBERS_PATH).handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/teams/voice/numbers`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: { phoneNumber: "+15550100", targetId: "user-2" },
    });
    expect(response.status).toBe(201);
    expect(provider.assignCalls[0]).toMatchObject({ tenantId: TENANT, preview: false });
  });

  it("lists the inventory and license state", async () => {
    const provider = new FakeTeamsVoiceProvider(LICENSED);
    const routes = createTeamsVoiceRoutes(
      optionsWith(provider, {
        tenantScope: tenantScope([TENANT]),
        permissions: ["teams.read", TEAMS_VOICE_WRITE_PERMISSION],
      }),
    );
    const response = await routeByPath(routes, "GET", TEAMS_VOICE_NUMBERS_PATH).handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/teams/voice/numbers`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ tenantId: TENANT, license: LICENSED, numbers: NUMBERS });
  });

  it("refuses writes when voice is not licensed", async () => {
    const provider = new FakeTeamsVoiceProvider(UNLICENSED);
    const routes = createTeamsVoiceRoutes(optionsWith(provider, writerCaller()));
    await expect(
      routeByPath(routes, "POST", TEAMS_VOICE_NUMBERS_PATH).handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/teams/voice/numbers`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { phoneNumber: "+15550100", targetId: "user-2" },
      }),
    ).rejects.toMatchObject({ status: 403, code: TEAMS_VOICE_LICENSE_REQUIRED });
    expect(provider.assignCalls).toHaveLength(0);
  });

  it("refuses release when voice is not licensed", async () => {
    const provider = new FakeTeamsVoiceProvider(UNLICENSED);
    const routes = createTeamsVoiceRoutes(optionsWith(provider, writerCaller()));
    await expect(
      routeByPath(routes, "DELETE", TEAMS_VOICE_NUMBER_ITEM_PATH).handler({
        method: "DELETE",
        path: `/v1/tenants/${TENANT}/teams/voice/numbers/num-1`,
        params: { tenantId: TENANT, numberId: "num-1" },
        query: new URLSearchParams("confirm=true"),
        headers: {},
        body: {},
      }),
    ).rejects.toMatchObject({ status: 403, code: TEAMS_VOICE_LICENSE_REQUIRED });
    expect(provider.releaseCalls).toHaveLength(0);
  });

  it("refuses release without confirmation", async () => {
    const provider = new FakeTeamsVoiceProvider(LICENSED);
    const routes = createTeamsVoiceRoutes(optionsWith(provider, writerCaller()));
    await expect(
      routeByPath(routes, "DELETE", TEAMS_VOICE_NUMBER_ITEM_PATH).handler({
        method: "DELETE",
        path: `/v1/tenants/${TENANT}/teams/voice/numbers/num-1`,
        params: { tenantId: TENANT, numberId: "num-1" },
        query: new URLSearchParams(),
        headers: {},
        body: {},
      }),
    ).rejects.toMatchObject({ status: 400, code: TEAMS_VOICE_CONFIRM_REQUIRED });
    expect(provider.releaseCalls).toHaveLength(0);
  });

  it("release with confirmation applies and records a TeamOperation plus an audit event", async () => {
    const provider = new FakeTeamsVoiceProvider(LICENSED);
    const routes = createTeamsVoiceRoutes(optionsWith(provider, writerCaller()));
    const response = await routeByPath(routes, "DELETE", TEAMS_VOICE_NUMBER_ITEM_PATH).handler({
      method: "DELETE",
      path: `/v1/tenants/${TENANT}/teams/voice/numbers/num-1`,
      params: { tenantId: TENANT, numberId: "num-1" },
      query: new URLSearchParams("confirm=true"),
      headers: {},
      body: {},
    });
    expect(response.status).toBe(200);
    expect(provider.releaseCalls[0]).toMatchObject({ tenantId: TENANT, numberId: "num-1", preview: false });
    expect(provider.recordedOperations).toHaveLength(1);
    expect(provider.recordedOperations[0]).toMatchObject({ operation: "voice.release", state: "applied" });
    expect(provider.recordedAudits).toHaveLength(1);
    expect(provider.recordedAudits[0]).toMatchObject({ action: "voice.release", targetId: "user-1" });
  });

  it("assign applies and records a TeamOperation plus an audit event", async () => {
    const provider = new FakeTeamsVoiceProvider(LICENSED);
    const routes = createTeamsVoiceRoutes(optionsWith(provider, writerCaller()));
    const response = await routeByPath(routes, "POST", TEAMS_VOICE_NUMBERS_PATH).handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/teams/voice/numbers`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: { phoneNumber: "+15550100", targetId: "user-2" },
    });
    expect(response.status).toBe(201);
    expect(provider.recordedOperations[0]).toMatchObject({ operation: "voice.assign", state: "applied" });
    expect(provider.recordedAudits[0]).toMatchObject({ action: "voice.assign", targetId: "user-2" });
  });

  it("assign preview returns the plan with no write and no audit", async () => {
    const provider = new FakeTeamsVoiceProvider(LICENSED);
    const routes = createTeamsVoiceRoutes(optionsWith(provider, writerCaller()));
    const response = await routeByPath(routes, "POST", TEAMS_VOICE_NUMBERS_PATH).handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/teams/voice/numbers`,
      params: { tenantId: TENANT },
      query: new URLSearchParams("preview=true"),
      headers: {},
      body: { phoneNumber: "+15550100", targetId: "user-2" },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ action: "assign", dryRun: true, valid: true });
    expect(provider.recordedOperations).toHaveLength(0);
    expect(provider.recordedAudits).toHaveLength(0);
  });

  it("policy assignment applies and records a TeamOperation plus an audit event", async () => {
    const provider = new FakeTeamsVoiceProvider(LICENSED);
    const routes = createTeamsVoiceRoutes(optionsWith(provider, writerCaller()));
    const response = await routeByPath(routes, "POST", TEAMS_VOICE_POLICY_PATH).handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/teams/voice/policy`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: { policyId: "policy-1", targetId: "user-1" },
    });
    expect(response.status).toBe(201);
    expect(provider.policyCalls[0]).toMatchObject({ tenantId: TENANT, preview: false });
    expect(provider.recordedOperations[0]).toMatchObject({ operation: "voice.policy", state: "applied" });
    expect(provider.recordedAudits[0]).toMatchObject({ action: "voice.policy", targetId: "user-1" });
  });

  it("policy assignment is refused when voice is not licensed", async () => {
    const provider = new FakeTeamsVoiceProvider(UNLICENSED);
    const routes = createTeamsVoiceRoutes(optionsWith(provider, writerCaller()));
    await expect(
      routeByPath(routes, "POST", TEAMS_VOICE_POLICY_PATH).handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/teams/voice/policy`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { policyId: "policy-1", targetId: "user-1" },
      }),
    ).rejects.toMatchObject({ status: 403, code: TEAMS_VOICE_LICENSE_REQUIRED });
    expect(provider.policyCalls).toHaveLength(0);
  });
});
