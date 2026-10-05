// T-0504 — teams create route gating, template expansion, EPIC-006 gated
// enqueue, and TeamOperation audit.
// Route-level tests: POST /v1/tenants/:tenantId/teams validates Teams.Team.ReadWrite +
// Remediation.Apply + tenant scope, expands a supplied local TeamTemplate's
// owners/members/settings, returns a plan preview without writing, and on apply
// enqueues the gated job and records a TeamOperation plus an audit event.

import { describe, expect, it } from "vitest";
import type { JobEnvelope } from "@m365-assess/contracts";
import { tenantScope } from "../rbac/scope.js";
import type { RequestContext } from "../server.js";
import {
  REMEDIATION_APPLY_PERMISSION,
  TEAMS_CREATE_OPENAPI,
  TEAMS_CREATE_PATH,
  TEAMS_WRITE_PERMISSION,
  createTeamsCreateRoute,
  expandTeamTemplate,
  validateCreateTeamInput,
  type CreateTeamInput,
  type TeamCreateResult,
  type TeamCreatePlan,
  type TeamOperationsStore,
  type TeamTemplateRecord,
  type TeamTemplateRepository,
  type TeamsCreateCaller,
  type TeamsCreateRouteOptions,
} from "./teams-create.js";

const TENANT = "tenant-test";

const TEMPLATE: TeamTemplateRecord = {
  id: "tpl-standard",
  name: "Standard Team",
  owners: ["owner-template@example.invalid"],
  members: ["member-template@example.invalid"],
  visibility: "private",
  settings: { allowGuests: false, channels: ["general", "ops"] },
};

class FakeTeamTemplateRepository implements TeamTemplateRepository {
  constructor(private readonly templates: readonly TeamTemplateRecord[] = [TEMPLATE]) {}

  async getTeamTemplate(templateId: string): Promise<TeamTemplateRecord | undefined> {
    return this.templates.find((template) => template.id === templateId);
  }
}

class FakeQueue {
  readonly enqueued: JobEnvelope[] = [];

  async enqueue(envelope: JobEnvelope): Promise<string> {
    this.enqueued.push(envelope);
    return envelope.jobId;
  }
}

class FakeTeamOperationsStore implements TeamOperationsStore {
  readonly created: Array<Record<string, unknown>> = [];

  async createTeamOperation(input: Record<string, unknown>): Promise<unknown> {
    this.created.push(input);
    return input;
  }
}

function caller(permissions: readonly string[], tenant = TENANT): TeamsCreateCaller {
  return {
    tenantScope: tenantScope([tenant]),
    permissions: [...permissions],
    userId: "user-operator",
  };
}

const WRITE_CALLER = () => caller([TEAMS_WRITE_PERMISSION, REMEDIATION_APPLY_PERMISSION]);

function ctx(
  body: Record<string, unknown>,
  options: { tenantId?: string; preview?: boolean; correlationId?: string } = {},
): RequestContext & { body?: unknown } {
  const tenantId = options.tenantId ?? TENANT;
  return {
    correlationId: options.correlationId ?? "corr-teams-create-1",
    method: "POST",
    path: `/v1/tenants/${tenantId}/teams`,
    query: new URLSearchParams(options.preview ? { preview: "true" } : {}),
    headers: {},
    params: { tenantId },
    body,
  };
}

function harness(overrides: Partial<TeamsCreateRouteOptions> = {}) {
  const teamTemplates = new FakeTeamTemplateRepository();
  const queue = new FakeQueue();
  const teamOperations = new FakeTeamOperationsStore();
  const audited: Record<string, unknown>[] = [];
  let current: TeamsCreateCaller | undefined = WRITE_CALLER();

  const route = createTeamsCreateRoute({
    teamTemplates,
    queue,
    teamOperations,
    recordAudit: async (event) => {
      audited.push(event);
    },
    resolveCaller: () => current,
    ...overrides,
  });

  return {
    route,
    teamTemplates,
    queue,
    teamOperations,
    audited,
    setCaller: (next: TeamsCreateCaller | undefined) => {
      current = next;
    },
  };
}

describe("Team template expansion (T-0504)", () => {
  const base: CreateTeamInput = {
    name: "Project Alpha",
    owners: ["owner@example.invalid"],
    members: ["member@example.invalid"],
    visibility: "public",
  };

  it("returns the explicit wizard values when no template is supplied", () => {
    const resolved = expandTeamTemplate(base);
    expect(resolved).toMatchObject({
      name: "Project Alpha",
      owners: ["owner@example.invalid"],
      members: ["member@example.invalid"],
      visibility: "public",
      templateId: null,
    });
    expect(resolved.settings).toEqual({});
  });

  it("expands a supplied TeamTemplate's owners, members, settings, and visibility", () => {
    const resolved = expandTeamTemplate({ ...base, visibility: undefined }, TEMPLATE);
    expect(resolved.owners).toEqual([
      "owner@example.invalid",
      "owner-template@example.invalid",
    ]);
    expect(resolved.members).toEqual([
      "member@example.invalid",
      "member-template@example.invalid",
    ]);
    expect(resolved.visibility).toBe("private");
    expect(resolved.settings).toEqual({ allowGuests: false, channels: ["general", "ops"] });
    expect(resolved.templateId).toBe("tpl-standard");
  });

  it("de-duplicates identities shared by the wizard and the template", () => {
    const resolved = expandTeamTemplate(
      { ...base, owners: ["Owner@Example.invalid", "owner-template@example.invalid"] },
      TEMPLATE,
    );
    expect(resolved.owners).toEqual([
      "Owner@Example.invalid",
      "owner-template@example.invalid",
    ]);
  });

  it("validates the create input", () => {
    expect(validateCreateTeamInput({ name: "Team" }).valid).toBe(true);
    expect(validateCreateTeamInput({ name: "  " }).valid).toBe(false);
    expect(validateCreateTeamInput({ name: "Team", visibility: "secret" }).valid).toBe(false);
    expect(validateCreateTeamInput({ name: "Team", owners: "owner@example.invalid" }).valid).toBe(false);
  });
});

describe("POST /v1/tenants/:tenantId/teams (T-0504)", () => {
  it("exposes the create route and publishes Teams.Team.ReadWrite", () => {
    const h = harness();
    expect(h.route.method).toBe("POST");
    expect(h.route.path).toBe(TEAMS_CREATE_PATH);
    const entry = TEAMS_CREATE_OPENAPI.paths["/tenants/{tenantId}/teams"].post;
    expect(entry.permission).toBe("Teams.Team.ReadWrite");
    expect(entry.operationId).toBe("createTeam");
  });

  it("rejects unauthenticated requests with 401 and enqueues nothing", async () => {
    const h = harness();
    h.setCaller(undefined);
    await expect(h.route.handler(ctx({ name: "Team" }))).rejects.toMatchObject({ status: 401 });
    expect(h.queue.enqueued).toHaveLength(0);
  });

  it("refuses callers without Teams.Team.ReadWrite", async () => {
    const h = harness();
    h.setCaller(caller([REMEDIATION_APPLY_PERMISSION]));
    await expect(h.route.handler(ctx({ name: "Team" }))).rejects.toMatchObject({ status: 403 });
    expect(h.queue.enqueued).toHaveLength(0);
  });

  it("refuses callers without Remediation.Apply", async () => {
    const h = harness();
    h.setCaller(caller([TEAMS_WRITE_PERMISSION]));
    await expect(h.route.handler(ctx({ name: "Team" }))).rejects.toMatchObject({ status: 403 });
    expect(h.queue.enqueued).toHaveLength(0);
  });

  it("refuses tenants outside caller scope", async () => {
    const h = harness();
    h.setCaller(caller([TEAMS_WRITE_PERMISSION, REMEDIATION_APPLY_PERMISSION], "other-tenant"));
    await expect(h.route.handler(ctx({ name: "Team" }))).rejects.toMatchObject({ status: 403 });
    expect(h.queue.enqueued).toHaveLength(0);
  });

  it("rejects a create without a name before dispatch", async () => {
    const h = harness();
    await expect(h.route.handler(ctx({ name: "  " }))).rejects.toMatchObject({ status: 400 });
    expect(h.queue.enqueued).toHaveLength(0);
  });

  it("returns a plan preview with the template expanded and writes nothing", async () => {
    const h = harness();
    const response = await h.route.handler(
      ctx({ name: "Project Alpha", template: "tpl-standard" }, { preview: true }),
    );
    expect(response.status).toBe(200);
    const plan = response.body as TeamCreatePlan;
    expect(plan.dryRun).toBe(true);
    expect(plan.after.templateId).toBe("tpl-standard");
    expect(plan.after.owners).toEqual(["owner-template@example.invalid"]);
    expect(plan.after.members).toEqual(["member-template@example.invalid"]);
    expect(plan.after.settings).toEqual({ allowGuests: false, channels: ["general", "ops"] });
    expect(h.queue.enqueued).toHaveLength(0);
    expect(h.teamOperations.created).toHaveLength(0);
  });

  it("creates without a template using only the wizard fields", async () => {
    const h = harness();
    const response = await h.route.handler(
      ctx({
        name: "Project Alpha",
        owners: ["owner@example.invalid"],
        members: ["member@example.invalid"],
        visibility: "public",
      }),
    );
    expect(response.status).toBe(202);
    const body = response.body as TeamCreateResult;
    expect(body.plan.after.templateId).toBeNull();
    expect(body.plan.after.owners).toEqual(["owner@example.invalid"]);
    expect(body.plan.after.visibility).toBe("public");
    expect(h.queue.enqueued).toHaveLength(1);
  });

  it("expands a template, enqueues the gated job, and records a TeamOperation", async () => {
    const h = harness();
    const response = await h.route.handler(
      ctx({ name: "Project Alpha", template: "tpl-standard", visibility: "public" }),
    );
    expect(response.status).toBe(202);
    const body = response.body as TeamCreateResult;
    expect(body.success).toBe(true);
    expect(body.plan.after.templateId).toBe("tpl-standard");
    expect(body.plan.after.owners).toContain("owner-template@example.invalid");
    expect(body.plan.after.members).toContain("member-template@example.invalid");
    expect(body.plan.after.settings).toEqual({ allowGuests: false, channels: ["general", "ops"] });

    expect(h.queue.enqueued).toHaveLength(1);
    const job = h.queue.enqueued[0]!;
    expect(job.jobType).toBe("remediation");
    expect(job.tenantId).toBe(TENANT);
    expect(job.payload).toMatchObject({
      area: "teams",
      action: "create",
      name: "Project Alpha",
      templateId: "tpl-standard",
      actor: "user-operator",
    });

    expect(h.teamOperations.created).toHaveLength(1);
    expect(h.teamOperations.created[0]).toMatchObject({
      tenantId: TENANT,
      operation: "create",
      state: "queued",
      by: "user-operator",
      result: null,
    });

    expect(h.audited).toHaveLength(1);
    expect(h.audited[0]).toMatchObject({
      action: "teams.team.create",
      tenantId: TENANT,
      targetName: "Project Alpha",
    });
  });

  it("returns 404 when the referenced template does not exist", async () => {
    const h = harness();
    await expect(
      h.route.handler(ctx({ name: "Project Alpha", template: "missing-template" })),
    ).rejects.toMatchObject({ status: 404 });
    expect(h.queue.enqueued).toHaveLength(0);
  });
});
