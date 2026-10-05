// Teams LIS locations CRUD API (EPIC-026 SPEC.md §2 US-5, §3.4, §4.4, §6, §7, §8; T-0509).
// Exposes GET/POST /v1/tenants/:tenantId/teams/lis and
// PATCH/DELETE /v1/tenants/:tenantId/teams/lis/:locationId.
// Reads run the LIS worker for the tenant. Writes validate `Teams.Voice.ReadWrite` +
// `Remediation.Apply` and tenant scope, validate required civic address fields,
// then apply through the EPIC-006 gated executor (T-0108): the route enqueues a
// `remediation` job carrying the change and records a TeamOperation (T-0501)
// plus an AuditEvent. No direct tenant write bypasses the gated path.
import { randomUUID } from "node:crypto";
import type { JobEnvelope } from "@m365-assess/contracts";
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const TEAMS_LIS_BASE_PATH = "/v1/tenants/:tenantId/teams/lis";
export const TEAMS_LIS_ITEM_PATH = "/v1/tenants/:tenantId/teams/lis/:locationId";

export const TEAMS_READ_PERMISSION = "Teams.Team.Read";
export const TEAMS_VOICE_PERMISSION = "Teams.Voice.ReadWrite";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";
export const TEAMS_LIS_UNAUTHENTICATED = "request.unauthenticated";
export const TEAMS_LIS_CONFIRM_REQUIRED = "teams.lis.confirm_required";

export interface LisLocationItem {
  readonly id: string;
  readonly displayName: string;
  readonly street: string;
  readonly city: string;
  readonly state: string;
  readonly country: string;
  readonly postalCode: string;
  readonly companyName?: string;
}

export interface LisLocationsListResponse {
  readonly tenantId: string;
  readonly totalCount: number;
  readonly items: readonly LisLocationItem[];
}

export interface LisLocationPlan {
  readonly action: "create" | "edit" | "delete";
  readonly locationId?: string;
  readonly targetName: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
  readonly warning?: string;
}

export interface LisLocationAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly timestamp: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
}

export interface LisLocationMutationResult {
  readonly success: boolean;
  readonly plan: LisLocationPlan;
  readonly jobId: string;
  readonly auditEventId?: string;
}

export interface LisLocationCreateInput {
  readonly displayName: string;
  readonly street: string;
  readonly city: string;
  readonly state: string;
  readonly country: string;
  readonly postalCode: string;
  readonly companyName?: string;
  readonly preview?: boolean;
}

export interface LisLocationEditInput {
  readonly displayName?: string;
  readonly street?: string;
  readonly city?: string;
  readonly state?: string;
  readonly country?: string;
  readonly postalCode?: string;
  readonly companyName?: string;
  readonly preview?: boolean;
}

// Read seam for LIS locations: the production wiring calls the LIS worker for
// the tenant. Writes never go through the provider — they enqueue a gated job.
export interface LisLocationsProvider {
  listLocations(tenantId: string): Promise<LisLocationsListResponse>;
  getLocation(tenantId: string, locationId: string): Promise<LisLocationItem | undefined>;
}

// TeamOperation audit trail (T-0501): one row per LIS write, state transitions
// recorded in place.
export interface TeamOperationsStore {
  createTeamOperation(input: {
    id: string;
    tenantId: string;
    teamId: string;
    operation: string;
    state: string;
    by?: string | null;
    at?: string;
    result?: string | null;
  }): Promise<unknown>;
  updateTeamOperation(
    tenantId: string,
    operationId: string,
    update: { state?: string; result?: string | null },
  ): Promise<unknown>;
}

export interface LisLocationsCaller extends Caller {
  readonly userId?: string;
}

export type LisLocationsAuthorizer = (
  caller: LisLocationsCaller,
  permission: string,
) => void | Promise<void>;

export interface LisLocationsRoutesOptions {
  readonly provider: LisLocationsProvider;
  readonly queue?: {
    enqueue(envelope: JobEnvelope): Promise<string>;
  };
  readonly teamOperations?: TeamOperationsStore;
  readonly resolveCaller: (ctx: RequestContext) => LisLocationsCaller | undefined;
  readonly authorize?: LisLocationsAuthorizer;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
  readonly idGenerator?: () => string;
  readonly now?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError(TEAMS_LIS_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string, reason = "invalid"): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason }]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => LisLocationsCaller | undefined,
  ctx: RequestContext,
): LisLocationsCaller {
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

function requireLocationIdParam(ctx: RequestContext): string {
  const value = ctx.params["locationId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "locationId is required", 400, [
      { field: "locationId", reason: "required" },
    ]);
  }
  return value.trim();
}

async function authorizeRead(
  options: LisLocationsRoutesOptions,
  caller: LisLocationsCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, TEAMS_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const allowed =
    permissions.includes(TEAMS_READ_PERMISSION) ||
    permissions.includes(TEAMS_VOICE_PERMISSION) ||
    permissions.includes("*");
  if (!allowed) {
    throw new AppError(
      ErrorCodes.forbidden,
      `forbidden: read requires ${TEAMS_READ_PERMISSION}`,
      403,
    );
  }
}

async function authorizeWrite(
  options: LisLocationsRoutesOptions,
  caller: LisLocationsCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, TEAMS_VOICE_PERMISSION);
    await options.authorize(caller, REMEDIATION_APPLY_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const hasVoice = permissions.includes(TEAMS_VOICE_PERMISSION) || permissions.includes("*");
  const hasApply = permissions.includes(REMEDIATION_APPLY_PERMISSION) || permissions.includes("*");
  if (!hasVoice || !hasApply) {
    throw new AppError(
      ErrorCodes.forbidden,
      `forbidden: write requires ${TEAMS_VOICE_PERMISSION} and ${REMEDIATION_APPLY_PERMISSION}`,
      403,
    );
  }
}

export function validateCountryCode(code: string): boolean {
  if (typeof code !== "string") return false;
  return /^[A-Za-z]{2}$/.test(code.trim());
}

const CIVIC_FIELDS = [
  "displayName",
  "street",
  "city",
  "state",
  "country",
  "postalCode",
] as const;

type CivicField = (typeof CIVIC_FIELDS)[number];

function missingCivicFields(values: Record<CivicField, string>): CivicField[] {
  return CIVIC_FIELDS.filter((field) => typeof values[field] !== "string" || values[field].trim().length === 0);
}

function readBodyRecord(ctx: RequestContext): Record<string, unknown> {
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw validationError("Request body must be a JSON object", "body");
  }
  return body;
}

function readPreviewFlag(ctx: RequestContext, body: Record<string, unknown>): boolean {
  return Boolean(body["preview"] ?? (ctx.query.get("preview") === "true"));
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw validationError(`Field '${field}' must be a string`, field);
  }
  return value;
}

function requireCivicFields(
  values: Record<CivicField, string>,
  field: string,
): Record<CivicField, string> {
  const missing = missingCivicFields(values);
  if (missing.length > 0) {
    throw validationError(
      `Missing required civic fields: ${missing.join(", ")}`,
      field,
      "required",
    );
  }
  return values;
}

function buildChangePlan(
  action: "create" | "edit" | "delete",
  targetName: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  dryRun: boolean,
): LisLocationPlan {
  const diff: string[] = [];
  if (action === "create") {
    diff.push(`Create LIS location '${after?.["displayName"] ?? targetName}' (${after?.["city"]}, ${after?.["state"]} ${after?.["country"]})`);
  } else if (action === "delete") {
    diff.push(`Delete LIS location '${before?.["displayName"] ?? targetName}'`);
  } else if (before && after) {
    for (const field of CIVIC_FIELDS) {
      if (before[field] !== after[field]) {
        diff.push(`~ ${field}: '${before[field]}' -> '${after[field]}'`);
      }
    }
  }
  if (diff.length === 0) {
    diff.push("No changes detected.");
  }
  return {
    action,
    ...(after?.["id"] !== undefined ? { locationId: String(after["id"]) } : {}),
    targetName,
    before: before ?? null,
    after: after ?? null,
    diff,
    valid: true,
    dryRun,
    requiresConfirmation: action === "delete",
  };
}

function buildRemediationEnvelope(
  ctx: RequestContext,
  tenantId: string,
  jobId: string,
  requestId: string,
  createdAt: string,
  extraPayload: Record<string, unknown>,
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
      ...extraPayload,
    },
  };
}

function auditActionFor(action: "create" | "edit" | "delete"): string {
  return `teams.lis.${action}`;
}

function actorOf(caller: LisLocationsCaller): string {
  return caller.userId ?? "unknown";
}

function requireQueue(options: LisLocationsRoutesOptions): { enqueue(envelope: JobEnvelope): Promise<string> } {
  if (!options.queue) {
    throw new AppError(ErrorCodes.internalError, "LIS location writes require a worker queue", 500);
  }
  return options.queue;
}

export function createLisLocationsRoutes(options: LisLocationsRoutesOptions): Route[] {
  const idGenerator = options.idGenerator ?? (() => randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  const listHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    requireTenantInScope(caller, tenantId);
    await authorizeRead(options, caller);

    const result = await options.provider.listLocations(tenantId);
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: result,
    };
  };

  const createHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    requireTenantInScope(caller, tenantId);
    await authorizeWrite(options, caller);
    const queue = requireQueue(options);

    const body = readBodyRecord(ctx);
    const isPreview = readPreviewFlag(ctx, body);

    const values = requireCivicFields(
      {
        displayName: optionalString(body["displayName"], "displayName") ?? "",
        street: optionalString(body["street"], "street") ?? "",
        city: optionalString(body["city"], "city") ?? "",
        state: optionalString(body["state"], "state") ?? "",
        country: optionalString(body["country"], "country") ?? "",
        postalCode: optionalString(body["postalCode"], "postalCode") ?? "",
      },
      "body",
    );
    if (!validateCountryCode(values.country)) {
      throw validationError(
        `Invalid country code: '${values.country}'. Must be a 2-letter ISO 3166-1 alpha-2 code.`,
        "country",
        "invalid_country_code",
      );
    }
    const companyName = optionalString(body["companyName"], "companyName");

    const after: Record<string, unknown> = {
      displayName: values.displayName.trim(),
      street: values.street.trim(),
      city: values.city.trim(),
      state: values.state.trim(),
      country: values.country.trim().toUpperCase(),
      postalCode: values.postalCode.trim(),
      ...(companyName ? { companyName: companyName.trim() } : {}),
    };
    const plan = buildChangePlan("create", after.displayName as string, null, after, isPreview);
    if (isPreview) {
      return { status: 200, headers: { "content-type": "application/json" }, body: plan };
    }

    const jobId = idGenerator();
    const requestId = idGenerator();
    const auditEventId = idGenerator();
    const createdAt = now();
    const actor = actorOf(caller);

    await queue.enqueue(
      buildRemediationEnvelope(ctx, tenantId, jobId, requestId, createdAt, {
        area: "teams.lis",
        action: "create",
        displayName: after.displayName,
        street: after.street,
        city: after.city,
        state: after.state,
        country: after.country,
        postalCode: after.postalCode,
        ...(companyName ? { companyName: after.companyName } : {}),
        actor,
      }),
    );

    if (options.teamOperations) {
      await options.teamOperations.createTeamOperation({
        id: requestId,
        tenantId,
        teamId: "",
        operation: "lis.create",
        state: "queued",
        by: actor,
        at: createdAt,
        result: null,
      });
    }

    if (options.recordAudit) {
      await options.recordAudit({
        id: auditEventId,
        action: auditActionFor("create"),
        tenantId,
        actorUserId: actor,
        targetId: "",
        correlationId: ctx.correlationId,
        timestamp: createdAt,
        before: null,
        after,
      });
    }

    const result: LisLocationMutationResult = { success: true, plan, jobId, auditEventId };
    return { status: 202, headers: { "content-type": "application/json" }, body: result };
  };

  const patchHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const locationId = requireLocationIdParam(ctx);
    requireTenantInScope(caller, tenantId);
    await authorizeWrite(options, caller);
    const queue = requireQueue(options);

    const body = readBodyRecord(ctx);
    const isPreview = readPreviewFlag(ctx, body);

    const existing = await options.provider.getLocation(tenantId, locationId);
    if (!existing) {
      throw new AppError(ErrorCodes.notFound, `LIS location ${locationId} not found`, 404);
    }

    const merged = requireCivicFields(
      {
        displayName: optionalString(body["displayName"], "displayName") ?? existing.displayName,
        street: optionalString(body["street"], "street") ?? existing.street,
        city: optionalString(body["city"], "city") ?? existing.city,
        state: optionalString(body["state"], "state") ?? existing.state,
        country: optionalString(body["country"], "country") ?? existing.country,
        postalCode: optionalString(body["postalCode"], "postalCode") ?? existing.postalCode,
      },
      "body",
    );
    if (!validateCountryCode(merged.country)) {
      throw validationError(
        `Invalid country code: '${merged.country}'. Must be a 2-letter ISO 3166-1 alpha-2 code.`,
        "country",
        "invalid_country_code",
      );
    }
    const companyName = optionalString(body["companyName"], "companyName") ?? existing.companyName;

    const before: Record<string, unknown> = { ...existing };
    const after: Record<string, unknown> = {
      id: existing.id,
      displayName: merged.displayName.trim(),
      street: merged.street.trim(),
      city: merged.city.trim(),
      state: merged.state.trim(),
      country: merged.country.trim().toUpperCase(),
      postalCode: merged.postalCode.trim(),
      ...(companyName ? { companyName: companyName.trim() } : {}),
    };
    const plan = buildChangePlan("edit", after.displayName as string, before, after, isPreview);
    if (isPreview) {
      return { status: 200, headers: { "content-type": "application/json" }, body: plan };
    }

    const jobId = idGenerator();
    const requestId = idGenerator();
    const auditEventId = idGenerator();
    const createdAt = now();
    const actor = actorOf(caller);

    await queue.enqueue(
      buildRemediationEnvelope(ctx, tenantId, jobId, requestId, createdAt, {
        area: "teams.lis",
        action: "edit",
        locationId,
        displayName: after.displayName,
        street: after.street,
        city: after.city,
        state: after.state,
        country: after.country,
        postalCode: after.postalCode,
        ...(companyName ? { companyName: after.companyName } : {}),
        actor,
      }),
    );

    if (options.teamOperations) {
      await options.teamOperations.createTeamOperation({
        id: requestId,
        tenantId,
        teamId: locationId,
        operation: "lis.edit",
        state: "queued",
        by: actor,
        at: createdAt,
        result: null,
      });
    }

    if (options.recordAudit) {
      await options.recordAudit({
        id: auditEventId,
        action: auditActionFor("edit"),
        tenantId,
        actorUserId: actor,
        targetId: locationId,
        correlationId: ctx.correlationId,
        timestamp: createdAt,
        before,
        after,
      });
    }

    const result: LisLocationMutationResult = { success: true, plan, jobId, auditEventId };
    return { status: 202, headers: { "content-type": "application/json" }, body: result };
  };

  const deleteHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const locationId = requireLocationIdParam(ctx);
    requireTenantInScope(caller, tenantId);
    await authorizeWrite(options, caller);
    const queue = requireQueue(options);

    const body = readBodyRecord(ctx);
    const isPreview = readPreviewFlag(ctx, body);
    const confirmName = optionalString(body["confirmName"], "confirmName");

    const existing = await options.provider.getLocation(tenantId, locationId);
    if (!existing) {
      throw new AppError(ErrorCodes.notFound, `LIS location ${locationId} not found`, 404);
    }

    if (isPreview) {
      const plan = buildChangePlan("delete", existing.displayName, { ...existing }, null, true);
      return { status: 200, headers: { "content-type": "application/json" }, body: plan };
    }

    if (confirmName === undefined || confirmName.trim() !== existing.displayName.trim()) {
      throw new AppError(
        TEAMS_LIS_CONFIRM_REQUIRED,
        `deleting an LIS location requires confirmation: confirmName must match '${existing.displayName}'`,
        400,
        [{ field: "confirmName", reason: "required" }],
      );
    }

    const before: Record<string, unknown> = { ...existing };
    const plan = buildChangePlan("delete", existing.displayName, before, null, false);

    const jobId = idGenerator();
    const requestId = idGenerator();
    const auditEventId = idGenerator();
    const createdAt = now();
    const actor = actorOf(caller);

    await queue.enqueue(
      buildRemediationEnvelope(ctx, tenantId, jobId, requestId, createdAt, {
        area: "teams.lis",
        action: "delete",
        locationId,
        displayName: existing.displayName,
        actor,
      }),
    );

    if (options.teamOperations) {
      await options.teamOperations.createTeamOperation({
        id: requestId,
        tenantId,
        teamId: locationId,
        operation: "lis.delete",
        state: "queued",
        by: actor,
        at: createdAt,
        result: null,
      });
    }

    if (options.recordAudit) {
      await options.recordAudit({
        id: auditEventId,
        action: auditActionFor("delete"),
        tenantId,
        actorUserId: actor,
        targetId: locationId,
        correlationId: ctx.correlationId,
        timestamp: createdAt,
        before,
        after: null,
      });
    }

    const result: LisLocationMutationResult = { success: true, plan, jobId, auditEventId };
    return { status: 202, headers: { "content-type": "application/json" }, body: result };
  };

  return [
    { method: "GET", path: TEAMS_LIS_BASE_PATH, handler: listHandler },
    { method: "POST", path: TEAMS_LIS_BASE_PATH, handler: createHandler },
    { method: "PATCH", path: TEAMS_LIS_ITEM_PATH, handler: patchHandler },
    { method: "DELETE", path: TEAMS_LIS_ITEM_PATH, handler: deleteHandler },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const TEAMS_LIS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/teams/lis": {
      get: {
        operationId: "listLisLocations",
        summary: "LIS locations (emergency calling) with civic address fields",
        permission: TEAMS_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "LIS locations for the tenant, read live from the LIS worker." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Teams.Team.Read or the tenant is out of scope." },
        },
      },
      post: {
        operationId: "createLisLocation",
        summary: "Create a LIS location (plan preview with preview:true; applies through the EPIC-006 gated path)",
        permission: TEAMS_VOICE_PERMISSION,
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
                required: ["displayName", "street", "city", "state", "country", "postalCode"],
                properties: {
                  displayName: { type: "string" },
                  street: { type: "string" },
                  city: { type: "string" },
                  state: { type: "string" },
                  country: { type: "string", description: "ISO 3166-1 alpha-2 code" },
                  postalCode: { type: "string" },
                  companyName: { type: "string" },
                  preview: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Plan preview of the LIS location create." },
          "202": { description: "The create was queued through the EPIC-006 gated path." },
          "400": { description: "A required civic field is missing or the country code is invalid." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Teams.Voice.ReadWrite or Remediation.Apply, or the tenant is out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/teams/lis/{locationId}": {
      patch: {
        operationId: "editLisLocation",
        summary: "Edit a LIS location (plan preview with preview:true; applies through the EPIC-006 gated path)",
        permission: TEAMS_VOICE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "locationId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  displayName: { type: "string" },
                  street: { type: "string" },
                  city: { type: "string" },
                  state: { type: "string" },
                  country: { type: "string", description: "ISO 3166-1 alpha-2 code" },
                  postalCode: { type: "string" },
                  companyName: { type: "string" },
                  preview: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Edit plan preview." },
          "202": { description: "The edit was queued through the EPIC-006 gated path." },
          "400": { description: "A required civic field is missing or the country code is invalid." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Teams.Voice.ReadWrite or Remediation.Apply, or the tenant is out of scope." },
          "404": { description: "LIS location not found." },
        },
      },
      delete: {
        operationId: "deleteLisLocation",
        summary: "Delete a LIS location (requires confirmName matching the display name)",
        permission: TEAMS_VOICE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "locationId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Delete plan preview." },
          "202": { description: "The delete was queued through the EPIC-006 gated path." },
          "400": { description: "confirmName is required and must match the location display name." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Teams.Voice.ReadWrite or Remediation.Apply, or the tenant is out of scope." },
          "404": { description: "LIS location not found." },
        },
      },
    },
  },
};
