// Teams create API (EPIC-026 SPEC.md §2 US-2, §3.1, §4.1, §6, §7, §8, §11 item 3; T-0504).
// Exposes POST /v1/tenants/:tenantId/teams for the `Add team` wizard fields:
// name, owners, members, template, and visibility. A supplied local
// TeamTemplate (T-0501) expands its owners/members/settings into the new team
// (SPEC §11 item 3: templates are local in v1). Writes validate `Teams.Team.ReadWrite`
// plus `Remediation.Apply` and tenant scope, then route through the EPIC-006
// gated path (T-0108): `preview` returns the plan with no write, otherwise the
// create is enqueued as a gated job and the route records a TeamOperation
// (T-0501) plus an AuditEvent. No direct tenant write bypasses the gated path.
import { randomUUID } from "node:crypto";
import type { JobEnvelope } from "@m365-assess/contracts";
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const TEAMS_CREATE_PATH = "/v1/tenants/:tenantId/teams";
export const TEAMS_WRITE_PERMISSION = "Teams.Team.ReadWrite";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";
export const TEAMS_CREATE_UNAUTHENTICATED = "request.unauthenticated";

export const TEAM_VISIBILITIES = ["public", "private"] as const;
export type TeamVisibility = (typeof TEAM_VISIBILITIES)[number];

export interface TeamTemplateRecord {
  readonly id: string;
  readonly name: string;
  readonly owners: readonly string[];
  readonly members: readonly string[];
  readonly visibility: TeamVisibility;
  readonly settings: Record<string, unknown>;
}

export interface TeamTemplateRepository {
  getTeamTemplate(templateId: string): Promise<TeamTemplateRecord | undefined>;
}

export interface CreateTeamInput {
  readonly name: string;
  readonly owners: readonly string[];
  readonly members: readonly string[];
  readonly visibility?: TeamVisibility;
  readonly settings?: Record<string, unknown>;
  readonly templateId?: string;
}

export interface ResolvedTeam {
  readonly name: string;
  readonly owners: readonly string[];
  readonly members: readonly string[];
  readonly visibility: TeamVisibility;
  readonly settings: Record<string, unknown>;
  readonly templateId: string | null;
}

export interface TeamCreatePlan {
  readonly action: "create";
  readonly targetName: string;
  readonly before: null;
  readonly after: ResolvedTeam;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
}

export interface TeamOperationRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly teamId: string;
  readonly operation: string;
  readonly state: string;
  readonly by: string | null;
  readonly at: string;
  readonly result: string | null;
}

export interface TeamOperationsStore {
  createTeamOperation(input: TeamOperationRecord): Promise<unknown>;
}

export interface TeamCreateResult {
  readonly success: boolean;
  readonly plan: TeamCreatePlan;
  readonly jobId: string;
  readonly teamOperation: TeamOperationRecord;
  readonly auditEventId: string;
}

export interface TeamsCreateCaller extends Caller {
  readonly userId?: string;
}

export type TeamsCreateAuthorizer = (
  caller: TeamsCreateCaller,
  permission: string,
) => void | Promise<void>;

export interface TeamsCreateRouteOptions {
  readonly teamTemplates: TeamTemplateRepository;
  readonly queue: { enqueue(envelope: JobEnvelope): Promise<string> };
  readonly teamOperations?: TeamOperationsStore;
  readonly resolveCaller: (ctx: RequestContext) => TeamsCreateCaller | undefined;
  readonly authorize?: TeamsCreateAuthorizer;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
  readonly idGenerator?: () => string;
  readonly now?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError(TEAMS_CREATE_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string, reason = "invalid"): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason }]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => TeamsCreateCaller | undefined,
  ctx: RequestContext,
): TeamsCreateCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

function requireTenantParam(ctx: RequestContext): string {
  const value = ctx.params["tenantId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "tenantId is required", 400, [
      { field: "tenantId", reason: "required" },
    ]);
  }
  return value.trim();
}

async function authorizeWrite(
  options: TeamsCreateRouteOptions,
  caller: TeamsCreateCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, TEAMS_WRITE_PERMISSION);
    await options.authorize(caller, REMEDIATION_APPLY_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const hasWrite = permissions.includes(TEAMS_WRITE_PERMISSION) || permissions.includes("*");
  const hasApply = permissions.includes(REMEDIATION_APPLY_PERMISSION) || permissions.includes("*");
  if (!hasWrite) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing Teams.Team.ReadWrite", 403);
  }
  if (!hasApply) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing Remediation.Apply", 403);
  }
}

export function mergeTeamIdentities(
  primary: readonly string[],
  secondary: readonly string[],
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of [...primary, ...secondary]) {
    const value = entry.trim();
    if (value.length === 0) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(value);
  }
  return merged;
}

/**
 * Expands a stored TeamTemplate into the team create fields (SPEC §4.1):
 * owners and members are the union of the wizard values and the template
 * (explicit first, de-duplicated), visibility falls back to the template's,
 * and settings are the template's overlaid by any explicit settings.
 */
export function expandTeamTemplate(
  input: CreateTeamInput,
  template?: TeamTemplateRecord,
): ResolvedTeam {
  return {
    name: input.name.trim(),
    owners: mergeTeamIdentities(input.owners, template?.owners ?? []),
    members: mergeTeamIdentities(input.members, template?.members ?? []),
    visibility: input.visibility ?? template?.visibility ?? "private",
    settings: { ...(template?.settings ?? {}), ...(input.settings ?? {}) },
    templateId: template?.id ?? null,
  };
}

export function validateCreateTeamInput(value: unknown): {
  valid: boolean;
  error?: string;
  field?: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { valid: false, error: "team must be an object", field: "team" };
  }
  const team = value as Record<string, unknown>;
  if (typeof team["name"] !== "string" || team["name"].trim().length === 0) {
    return { valid: false, error: "name is required", field: "name" };
  }
  if (
    team["visibility"] !== undefined &&
    !(TEAM_VISIBILITIES as readonly string[]).includes(String(team["visibility"]).trim().toLowerCase())
  ) {
    return { valid: false, error: "visibility must be public or private", field: "visibility" };
  }
  for (const field of ["owners", "members"] as const) {
    const raw = team[field];
    if (raw === undefined || raw === null) continue;
    if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
      return { valid: false, error: `${field} must be an array of strings`, field };
    }
  }
  return { valid: true };
}

function toStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
  }
  if (typeof value === "string") {
    return value.split(";").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  }
  return [];
}

function toCreateInput(team: Record<string, unknown>): CreateTeamInput {
  const visibility = typeof team["visibility"] === "string" ? team["visibility"].trim().toLowerCase() : "";
  return {
    name: (team["name"] as string).trim(),
    owners: toStringArray(team["owners"]),
    members: toStringArray(team["members"]),
    ...(visibility ? { visibility: visibility as TeamVisibility } : {}),
    ...(typeof team["settings"] === "object" && team["settings"] !== null
      ? { settings: team["settings"] as Record<string, unknown> }
      : {}),
    ...(typeof team["template"] === "string" && team["template"].trim()
      ? { templateId: team["template"].trim() }
      : {}),
  };
}

function buildCreatePlan(resolved: ResolvedTeam, dryRun: boolean): TeamCreatePlan {
  const diff: string[] = [`Create team '${resolved.name}' (${resolved.visibility})`];
  if (resolved.templateId) {
    diff.push(
      `Expand template '${resolved.templateId}': ${resolved.owners.length} owner(s), ${resolved.members.length} member(s)`,
    );
  } else if (resolved.owners.length > 0 || resolved.members.length > 0) {
    diff.push(`Add ${resolved.owners.length} owner(s) and ${resolved.members.length} member(s)`);
  }
  return {
    action: "create",
    targetName: resolved.name,
    before: null,
    after: resolved,
    diff,
    valid: true,
    dryRun,
    requiresConfirmation: false,
  };
}

function buildRemediationEnvelope(
  ctx: RequestContext,
  tenantId: string,
  jobId: string,
  requestId: string,
  createdAt: string,
  payload: Record<string, unknown>,
): JobEnvelope {
  return {
    schemaVersion: "v1",
    jobId,
    jobType: "remediation",
    tenantId,
    runId: "",
    requestId,
    correlationId: ctx.correlationId,
    createdAt,
    payload: {
      contextRef: `remediation/${tenantId}/${jobId}/job.json`,
      outputRef: `remediation/${tenantId}/${jobId}`,
      credentialRef: `tenants/${tenantId}/credential`,
      sectionRefs: [],
      artifactRefs: [],
      operation: "apply",
      ...payload,
    },
  };
}

export function createTeamsCreateRoute(options: TeamsCreateRouteOptions): Route {
  const idGenerator = options.idGenerator ?? (() => randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  return {
    method: "POST",
    path: TEAMS_CREATE_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = requireCaller(options.resolveCaller, ctx);
      const tenantId = requireTenantParam(ctx);
      requireTenantInScope(caller, tenantId);
      await authorizeWrite(options, caller);

      const body = (ctx.body ?? {}) as Record<string, unknown>;
      const check = validateCreateTeamInput(body);
      if (!check.valid) {
        throw validationError(check.error ?? "invalid team", check.field ?? "team");
      }

      const input = toCreateInput(body);
      let template: TeamTemplateRecord | undefined;
      if (input.templateId) {
        template = await options.teamTemplates.getTeamTemplate(input.templateId);
        if (!template) {
          throw new AppError(
            ErrorCodes.notFound,
            `Team template '${input.templateId}' not found`,
            404,
          );
        }
      }
      const resolved = expandTeamTemplate(input, template);

      const isPreview = Boolean(body["preview"] ?? ctx.query.get("preview") === "true");
      const plan = buildCreatePlan(resolved, isPreview);
      if (isPreview) {
        return { status: 200, headers: { "content-type": "application/json" }, body: plan };
      }

      const jobId = idGenerator();
      const requestId = idGenerator();
      const auditEventId = idGenerator();
      const createdAt = now();
      const actor = caller.userId ?? "unknown";

      await options.queue.enqueue(
        buildRemediationEnvelope(ctx, tenantId, jobId, requestId, createdAt, {
          area: "teams",
          action: "create",
          name: resolved.name,
          owners: resolved.owners,
          members: resolved.members,
          visibility: resolved.visibility,
          settings: resolved.settings,
          ...(resolved.templateId ? { templateId: resolved.templateId } : {}),
          actor,
        }),
      );

      const teamOperation: TeamOperationRecord = {
        id: requestId,
        tenantId,
        teamId: "",
        operation: "create",
        state: "queued",
        by: actor,
        at: createdAt,
        result: null,
      };
      if (options.teamOperations) {
        await options.teamOperations.createTeamOperation(teamOperation);
      }

      if (options.recordAudit) {
        await options.recordAudit({
          id: auditEventId,
          action: "teams.team.create",
          tenantId,
          actorUserId: actor,
          targetId: "",
          targetName: resolved.name,
          correlationId: ctx.correlationId,
          timestamp: createdAt,
          before: null,
          after: resolved,
        });
      }

      const result: TeamCreateResult = {
        success: true,
        plan,
        jobId,
        teamOperation,
        auditEventId,
      };
      return { status: 202, headers: { "content-type": "application/json" }, body: result };
    },
  };
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const TEAMS_CREATE_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/teams": {
      post: {
        operationId: "createTeam",
        summary: "Create a team from the wizard fields, expanding a local TeamTemplate",
        permission: TEAMS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string" },
                  owners: { type: "array", items: { type: "string" } },
                  members: { type: "array", items: { type: "string" } },
                  template: { type: "string", description: "Stored TeamTemplate id" },
                  visibility: { type: "string", enum: [...TEAM_VISIBILITIES] },
                  preview: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Plan preview of the team create with the expanded template." },
          "202": { description: "The create was queued through the EPIC-006 gated path with a TeamOperation." },
          "400": { description: "name is missing or visibility is not public/private." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Teams.Team.ReadWrite or Remediation.Apply, or the tenant is out of scope." },
          "404": { description: "The referenced TeamTemplate does not exist." },
        },
      },
    },
  },
} as const;
