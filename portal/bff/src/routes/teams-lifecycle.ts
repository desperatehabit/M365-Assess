// Teams lifecycle API (EPIC-026 SPEC.md §2 US-2, §3.1, §4.1, §6, §7, §8, §9; T-0505).
// Exposes the Teams page row actions: PATCH /v1/tenants/:tenantId/teams/:teamId
// edits a team, DELETE .../teams/:teamId deletes one, POST .../teams/:teamId/archive
// archives one, and POST .../teams/:teamId/clone clones one. Every write routes
// through EPIC-006 remediation semantics (T-0108): `preview` plans without
// writing, apply requires `Teams.Team.ReadWrite` plus `Remediation.Apply`, delete
// additionally requires `{ "confirm": true }` naming the team, and every apply
// returns before/after plus one audit event and updates a TeamOperation row
// (T-0501) with state and result. An unknown team is a structured 4xx, never a
// silent no-op.
import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const TEAMS_LIFECYCLE_ITEM_PATH = "/v1/tenants/:tenantId/teams/:teamId";
export const TEAMS_LIFECYCLE_ARCHIVE_PATH = "/v1/tenants/:tenantId/teams/:teamId/archive";
export const TEAMS_LIFECYCLE_CLONE_PATH = "/v1/tenants/:tenantId/teams/:teamId/clone";

export const TEAMS_WRITE_PERMISSION = "Teams.Team.ReadWrite";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";

export const TEAMS_LIFECYCLE_UNAUTHENTICATED = "request.unauthenticated";
export const TEAMS_CONFIRM_REQUIRED = "teams.confirm_required";
export const TEAMS_TEAM_NOT_FOUND = "teams.team_not_found";

export type TeamLifecycleAction = "edit" | "archive" | "clone" | "delete";

export interface TeamLifecycleInput {
  readonly preview?: boolean;
  readonly confirm?: boolean;
  readonly confirmName?: string;
  readonly reason?: string;
  readonly changes?: Record<string, unknown>;
  readonly newName?: string;
  readonly description?: string;
  readonly visibility?: string;
  readonly partsToClone?: string;
  readonly shouldSetSpoSiteReadOnlyForMembers?: boolean;
}

export interface TeamLifecyclePlan {
  readonly action: TeamLifecycleAction;
  readonly teamId: string;
  readonly targetName: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: true;
  readonly requiresConfirmation: boolean;
}

export interface TeamAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly timestamp: string;
  readonly result: "success" | "failure";
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly error?: string | null;
  readonly actor?: string | null;
  readonly correlationId?: string;
}

export interface TeamOperationResult {
  readonly success: boolean;
  readonly state: "succeeded" | "failed";
  readonly operation: TeamLifecycleAction;
  readonly teamId: string;
  readonly targetName: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly error: string | null;
  readonly auditEvent?: TeamAuditEvent;
}

// Queue-backed seam for the lifecycle writes: the production wiring enqueues an
// invoke-team-action worker job and serves the worker result. Depending on the
// seam keeps Graph and process code out of the BFF.
export interface TeamsLifecycleProvider {
  editTeam(
    tenantId: string,
    teamId: string,
    input: TeamLifecycleInput,
    preview: boolean,
  ): Promise<TeamOperationResult | TeamLifecyclePlan>;
  archiveTeam(
    tenantId: string,
    teamId: string,
    input: TeamLifecycleInput,
    preview: boolean,
  ): Promise<TeamOperationResult | TeamLifecyclePlan>;
  cloneTeam(
    tenantId: string,
    teamId: string,
    input: TeamLifecycleInput,
    preview: boolean,
  ): Promise<TeamOperationResult | TeamLifecyclePlan>;
  deleteTeam(
    tenantId: string,
    teamId: string,
    input: TeamLifecycleInput,
    preview: boolean,
  ): Promise<TeamOperationResult | TeamLifecyclePlan>;
}

// Structural subset of the T-0501 TeamOperation repository surface: the route
// opens the row when the write starts and closes it with the final state and
// result. Keeping it structural avoids importing @m365-assess/db here.
export interface TeamOperationRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly teamId: string;
  readonly operation: string;
  readonly state: string;
  readonly by: string | null;
  readonly at: string;
  readonly result: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TeamOperationStore {
  createTeamOperation(input: {
    id: string;
    tenantId: string;
    teamId: string;
    operation: string;
    state: string;
    by?: string | null;
    at?: string;
    result?: string | null;
    createdAt?: string;
    updatedAt?: string;
  }): Promise<TeamOperationRecord>;
  updateTeamOperation(
    tenantId: string,
    operationId: string,
    update: { state?: string; result?: string | null },
  ): Promise<TeamOperationRecord | undefined>;
}

export interface TeamsLifecycleCaller extends Caller {
  readonly userId?: string;
}

export type TeamsLifecycleAuthorizer = (
  caller: TeamsLifecycleCaller,
  permission: string,
) => void | Promise<void>;

export interface TeamsLifecycleRouteOptions {
  readonly provider: TeamsLifecycleProvider;
  readonly teamOperations?: TeamOperationStore;
  readonly resolveCaller: (ctx: RequestContext) => TeamsLifecycleCaller | undefined;
  readonly authorize?: TeamsLifecycleAuthorizer;
  readonly recordAudit?: (event: TeamAuditEvent) => void | Promise<void>;
  readonly now?: () => string;
  readonly newId?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError(TEAMS_LIFECYCLE_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string, reason = "invalid"): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason }]);
}

export function teamNotFoundError(teamId: string): AppError {
  return new AppError(
    TEAMS_TEAM_NOT_FOUND,
    `team '${teamId}' was not found; the lifecycle action is available only for a live team`,
    404,
    [{ field: "teamId", reason: "not_found" }],
  );
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => TeamsLifecycleCaller | undefined,
  ctx: RequestContext,
): TeamsLifecycleCaller {
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

function requireTeamParam(ctx: RequestContext): string {
  const value = ctx.params["teamId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "teamId is required", 400, [
      { field: "teamId", reason: "required" },
    ]);
  }
  return value.trim();
}

async function authorize(
  options: TeamsLifecycleRouteOptions,
  caller: TeamsLifecycleCaller,
  permission: string,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, permission);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(permission) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, `forbidden: missing ${permission}`, 403);
  }
}

function readBody(ctx: RequestContext): Record<string, unknown> {
  const body = ctx.body ?? {};
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AppError(ErrorCodes.validationFailed, "request body must be a JSON object", 400, [
      { field: "body", reason: "invalid" },
    ]);
  }
  return body as Record<string, unknown>;
}

function readPreviewFlag(ctx: RequestContext, body: Record<string, unknown>): boolean {
  const value = body["preview"];
  if (value !== undefined && typeof value !== "boolean") {
    throw validationError("preview must be a boolean", "preview");
  }
  return value === true || ctx.query.get("preview") === "true";
}

function readConfirmFlag(body: Record<string, unknown>): boolean {
  const value = body["confirm"];
  if (value !== undefined && typeof value !== "boolean") {
    throw validationError("confirm must be a boolean", "confirm");
  }
  return value === true;
}

function readConfirmName(ctx: RequestContext, body: Record<string, unknown>): string {
  const value = body["confirmName"];
  if (value !== undefined && typeof value !== "string") {
    throw validationError("confirmName must be a string", "confirmName");
  }
  const fromBody = typeof value === "string" ? value.trim() : "";
  return fromBody.length > 0 ? fromBody : (ctx.query.get("confirmName")?.trim() ?? "");
}

function readChanges(body: Record<string, unknown>): Record<string, unknown> {
  const raw = body["changes"];
  if (raw === undefined || raw === null) {
    throw validationError("changes must be a non-empty object of editable team fields", "changes");
  }
  if (typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length === 0) {
    throw validationError("changes must be a non-empty object of editable team fields", "changes");
  }
  return raw as Record<string, unknown>;
}

function readRequiredName(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(`${field} is required`, field);
  }
  return value.trim();
}

function readOptionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw validationError(`${field} must be a string`, field);
  }
  return value;
}

function readOptionalBoolean(
  body: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw validationError(`${field} must be a boolean`, field);
  }
  return value;
}

async function beginTeamOperation(
  options: TeamsLifecycleRouteOptions,
  tenantId: string,
  teamId: string,
  operation: TeamLifecycleAction,
  by: string | null,
): Promise<string | null> {
  if (!options.teamOperations) {
    return null;
  }
  const newId = options.newId ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());
  const record = await options.teamOperations.createTeamOperation({
    id: newId(),
    tenantId,
    teamId,
    operation,
    state: "running",
    by,
    at: now(),
  });
  return record.id;
}

async function completeTeamOperation(
  options: TeamsLifecycleRouteOptions,
  tenantId: string,
  operationId: string | null,
  state: "succeeded" | "failed",
  result: Record<string, unknown> | null,
): Promise<void> {
  if (!options.teamOperations || operationId === null) {
    return;
  }
  await options.teamOperations.updateTeamOperation(tenantId, operationId, {
    state,
    result: result === null ? null : JSON.stringify(result),
  });
}

function operationPayload(
  operation: TeamLifecycleAction,
  outcome: TeamOperationResult,
): Record<string, unknown> {
  return {
    operation,
    teamId: outcome.teamId,
    targetName: outcome.targetName,
    before: outcome.before,
    after: outcome.after,
    error: outcome.error,
  };
}

function isPlan(
  outcome: TeamOperationResult | TeamLifecyclePlan,
): outcome is TeamLifecyclePlan {
  return (outcome as TeamLifecyclePlan).dryRun === true;
}

function mapProviderError(error: unknown, teamId: string): never {
  if (error instanceof AppError) {
    throw error;
  }
  const message = error instanceof Error ? error.message : "";
  if (/not.?found|was not found/i.test(message)) {
    throw teamNotFoundError(teamId);
  }
  throw error;
}

async function applyTeamOperation(
  options: TeamsLifecycleRouteOptions,
  caller: TeamsLifecycleCaller,
  tenantId: string,
  teamId: string,
  operation: TeamLifecycleAction,
  outcome: TeamOperationResult,
): Promise<RouteResponse> {
  const operationId = await beginTeamOperation(
    options,
    tenantId,
    teamId,
    operation,
    caller.userId ?? null,
  );
  await completeTeamOperation(
    options,
    tenantId,
    operationId,
    outcome.state,
    operationPayload(operation, outcome),
  );
  if (outcome.auditEvent && options.recordAudit) {
    await options.recordAudit(outcome.auditEvent);
  }
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: outcome,
  };
}

export function createTeamsLifecycleRoutes(
  options: TeamsLifecycleRouteOptions,
): Route[] {
  const editHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const teamId = requireTeamParam(ctx);

    requireTenantInScope(caller, tenantId);
    await authorize(options, caller, TEAMS_WRITE_PERMISSION);

    const body = readBody(ctx);
    const isPreview = readPreviewFlag(ctx, body);
    const changes = readChanges(body);
    if (!isPreview) {
      await authorize(options, caller, REMEDIATION_APPLY_PERMISSION);
    }

    let outcome: TeamOperationResult | TeamLifecyclePlan;
    try {
      outcome = await options.provider.editTeam(
        tenantId,
        teamId,
        { preview: isPreview, changes },
        isPreview,
      );
    } catch (error) {
      mapProviderError(error, teamId);
    }

    if (isPreview || isPlan(outcome)) {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: outcome,
      };
    }
    return applyTeamOperation(options, caller, tenantId, teamId, "edit", outcome);
  };

  const archiveHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const teamId = requireTeamParam(ctx);

    requireTenantInScope(caller, tenantId);
    await authorize(options, caller, TEAMS_WRITE_PERMISSION);

    const body = readBody(ctx);
    const isPreview = readPreviewFlag(ctx, body);
    const shouldSetSpoSiteReadOnlyForMembers = readOptionalBoolean(
      body,
      "shouldSetSpoSiteReadOnlyForMembers",
    );
    if (!isPreview) {
      await authorize(options, caller, REMEDIATION_APPLY_PERMISSION);
    }

    let outcome: TeamOperationResult | TeamLifecyclePlan;
    try {
      outcome = await options.provider.archiveTeam(
        tenantId,
        teamId,
        {
          preview: isPreview,
          ...(shouldSetSpoSiteReadOnlyForMembers !== undefined
            ? { shouldSetSpoSiteReadOnlyForMembers }
            : {}),
        },
        isPreview,
      );
    } catch (error) {
      mapProviderError(error, teamId);
    }

    if (isPreview || isPlan(outcome)) {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: outcome,
      };
    }
    return applyTeamOperation(options, caller, tenantId, teamId, "archive", outcome);
  };

  const cloneHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const teamId = requireTeamParam(ctx);

    requireTenantInScope(caller, tenantId);
    await authorize(options, caller, TEAMS_WRITE_PERMISSION);

    const body = readBody(ctx);
    const isPreview = readPreviewFlag(ctx, body);
    const newName = readRequiredName(body, "newName");
    const description = readOptionalString(body, "description");
    const visibility = readOptionalString(body, "visibility");
    const partsToClone = readOptionalString(body, "partsToClone");
    if (!isPreview) {
      await authorize(options, caller, REMEDIATION_APPLY_PERMISSION);
    }

    let outcome: TeamOperationResult | TeamLifecyclePlan;
    try {
      outcome = await options.provider.cloneTeam(
        tenantId,
        teamId,
        {
          preview: isPreview,
          newName,
          ...(description !== undefined ? { description } : {}),
          ...(visibility !== undefined ? { visibility } : {}),
          ...(partsToClone !== undefined ? { partsToClone } : {}),
        },
        isPreview,
      );
    } catch (error) {
      mapProviderError(error, teamId);
    }

    if (isPreview || isPlan(outcome)) {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: outcome,
      };
    }
    return applyTeamOperation(options, caller, tenantId, teamId, "clone", outcome);
  };

  const deleteHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const teamId = requireTeamParam(ctx);

    requireTenantInScope(caller, tenantId);
    await authorize(options, caller, TEAMS_WRITE_PERMISSION);

    const body = readBody(ctx);
    const isPreview = readPreviewFlag(ctx, body);
    const confirmed = readConfirmFlag(body);
    const confirmName = readConfirmName(ctx, body);
    if (!isPreview) {
      await authorize(options, caller, REMEDIATION_APPLY_PERMISSION);
      if (!confirmed || confirmName.length === 0) {
        throw new AppError(
          TEAMS_CONFIRM_REQUIRED,
          `delete of team '${teamId}' requires confirmation naming the team ({ "confirm": true, "confirmName": "<team display name>" })`,
          400,
          [{ field: "confirmName", reason: "required" }],
        );
      }
    }

    let outcome: TeamOperationResult | TeamLifecyclePlan;
    try {
      outcome = await options.provider.deleteTeam(
        tenantId,
        teamId,
        { preview: isPreview, confirm: confirmed, confirmName },
        isPreview,
      );
    } catch (error) {
      mapProviderError(error, teamId);
    }

    if (isPreview || isPlan(outcome)) {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: outcome,
      };
    }
    return applyTeamOperation(options, caller, tenantId, teamId, "delete", outcome);
  };

  return [
    { method: "PATCH", path: TEAMS_LIFECYCLE_ITEM_PATH, handler: editHandler },
    { method: "DELETE", path: TEAMS_LIFECYCLE_ITEM_PATH, handler: deleteHandler },
    { method: "POST", path: TEAMS_LIFECYCLE_ARCHIVE_PATH, handler: archiveHandler },
    { method: "POST", path: TEAMS_LIFECYCLE_CLONE_PATH, handler: cloneHandler },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const TEAMS_LIFECYCLE_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/teams/{teamId}": {
      patch: {
        operationId: "editTeam",
        summary: "Edit a team (preview with preview:true; apply needs Teams.Team.ReadWrite, Remediation.Apply)",
        permission: TEAMS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "teamId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["changes"],
                properties: {
                  changes: { type: "object" },
                  preview: { type: "boolean" },
                  reason: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Edit plan preview, or the applied result with before/after and audit event." },
          "400": { description: "changes is missing or not an object." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Teams.Team.ReadWrite or Remediation.Apply, or the tenant is out of scope." },
          "404": { description: "The team is not live." },
        },
      },
      delete: {
        operationId: "deleteTeam",
        summary: "Delete a team (preview with preview:true; apply needs Teams.Team.ReadWrite, Remediation.Apply, confirm:true, and confirmName naming the team)",
        permission: TEAMS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "teamId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  preview: { type: "boolean" },
                  confirm: { type: "boolean" },
                  confirmName: { type: "string", description: "Must match the team display name." },
                  reason: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Delete plan preview, or the applied result with before/after and audit event." },
          "400": { description: "Confirmation naming the team is missing for the delete." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Teams.Team.ReadWrite or Remediation.Apply, or the tenant is out of scope." },
          "404": { description: "The team is not live." },
        },
      },
    },
    "/tenants/{tenantId}/teams/{teamId}/archive": {
      post: {
        operationId: "archiveTeam",
        summary: "Archive a team (preview with preview:true; apply needs Teams.Team.ReadWrite and Remediation.Apply)",
        permission: TEAMS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "teamId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  preview: { type: "boolean" },
                  shouldSetSpoSiteReadOnlyForMembers: { type: "boolean" },
                  reason: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Archive plan preview, or the applied result with before/after and audit event." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Teams.Team.ReadWrite or Remediation.Apply, or the tenant is out of scope." },
          "404": { description: "The team is not live." },
        },
      },
    },
    "/tenants/{tenantId}/teams/{teamId}/clone": {
      post: {
        operationId: "cloneTeam",
        summary: "Clone a team (preview with preview:true; apply needs Teams.Team.ReadWrite and Remediation.Apply)",
        permission: TEAMS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "teamId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["newName"],
                properties: {
                  newName: { type: "string" },
                  description: { type: "string" },
                  visibility: { type: "string", enum: ["public", "private"] },
                  partsToClone: { type: "string" },
                  preview: { type: "boolean" },
                  reason: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Clone plan preview, or the applied result with before/after and audit event." },
          "400": { description: "newName is missing." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Teams.Team.ReadWrite or Remediation.Apply, or the tenant is out of scope." },
          "404": { description: "The source team is not live." },
        },
      },
    },
  },
} as const;
