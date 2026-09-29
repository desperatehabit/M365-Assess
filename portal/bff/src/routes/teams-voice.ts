// Teams Business Voice numbers and policy assignment (EPIC-026 SPEC.md §2 US-4,
// §3.3, §4.3, §5, §6, §8, §11.1; T-0508). GET reads the voice-number inventory
// and license state live from the tenant through the injected provider, which
// is backed by the worker queue (T-0010); this module holds no M365 SDK call
// and issues no tenant write on reads. Assign, release, and policy assignment
// run form → plan preview → apply through the EPIC-006 gated executor (T-0108):
// `preview` (or ?preview=true) returns the worker plan with no tenant write,
// otherwise the worker applies with before/after capture and returns one
// AuditEvent per write plus one TeamOperation row (T-0501), recorded by the
// app audit sink and the team-operation sink. Voice is license-gated (SPEC
// §3.3, §4.3, §9): when the tenant holds no active Phone System service plan
// the route refuses every write with a clear requirement message, and release
// additionally requires explicit confirmation (SPEC §8).
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const TEAMS_VOICE_NUMBERS_PATH = "/v1/tenants/:tenantId/teams/voice/numbers";
export const TEAMS_VOICE_NUMBER_ITEM_PATH = "/v1/tenants/:tenantId/teams/voice/numbers/:numberId";
export const TEAMS_VOICE_POLICY_PATH = "/v1/tenants/:tenantId/teams/voice/policy";

export const TEAMS_VOICE_READ_PERMISSION = "teams.read";
export const TEAMS_VOICE_WRITE_PERMISSION = "teams.voice";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";
export const TEAMS_VOICE_UNAUTHENTICATED = "request.unauthenticated";
export const TEAMS_VOICE_LICENSE_REQUIRED = "voice.license_required";
export const TEAMS_VOICE_CONFIRM_REQUIRED = "voice.confirm_required";

export interface TeamsVoiceLicenseState {
  readonly licensed: boolean;
  readonly missingPlans: readonly string[];
  readonly activePlans: readonly string[];
}

export interface VoiceNumber {
  readonly id: string;
  readonly number: string;
  readonly type: string;
  readonly assignedTo: string;
  readonly state: string;
}

export interface TeamsVoicePlan {
  readonly action: string;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
}

export interface TeamsVoiceOperation {
  readonly id: string;
  readonly tenantId: string;
  readonly teamId: string;
  readonly operation: string;
  readonly state: string;
  readonly by: string | null;
  readonly at: string;
  readonly result: string | null;
}

export interface TeamsVoiceAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly timestamp: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly note?: string;
}

export interface TeamsVoiceResult {
  readonly success: boolean;
  readonly plan: TeamsVoicePlan;
  readonly result?: Record<string, unknown>;
  readonly teamOperation?: TeamsVoiceOperation;
  readonly auditEvent?: TeamsVoiceAuditEvent;
}

export interface AssignVoiceNumberInput {
  readonly phoneNumber: string;
  readonly targetId: string;
  readonly preview?: boolean;
}

export interface AssignVoicePolicyInput {
  readonly policyId: string;
  readonly targetId: string;
  readonly preview?: boolean;
}

export interface TeamsVoiceProvider {
  getLicenseState(tenantId: string): Promise<TeamsVoiceLicenseState>;
  listNumbers(tenantId: string): Promise<{ license: TeamsVoiceLicenseState; numbers: VoiceNumber[] }>;
  assignNumber(
    tenantId: string,
    input: AssignVoiceNumberInput,
    preview: boolean,
  ): Promise<TeamsVoiceResult | TeamsVoicePlan>;
  releaseNumber(tenantId: string, numberId: string, preview: boolean): Promise<TeamsVoiceResult | TeamsVoicePlan>;
  assignPolicy(
    tenantId: string,
    input: AssignVoicePolicyInput,
    preview: boolean,
  ): Promise<TeamsVoiceResult | TeamsVoicePlan>;
}

export interface TeamsVoiceCaller extends Caller {
  readonly userId?: string;
}

export type TeamsVoiceAuthorizer = (
  caller: TeamsVoiceCaller,
  permission: string,
) => void | Promise<void>;

export interface TeamsVoiceRouteOptions {
  readonly provider: TeamsVoiceProvider;
  readonly resolveCaller: (ctx: RequestContext) => TeamsVoiceCaller | undefined;
  readonly authorize?: TeamsVoiceAuthorizer;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
  readonly recordTeamOperation?: (operation: TeamsVoiceOperation) => Promise<void>;
}

function unauthenticatedError(): AppError {
  return new AppError(TEAMS_VOICE_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function licenseRequiredError(missingPlans: readonly string[]): AppError {
  const missing = missingPlans.length > 0 ? missingPlans.join(", ") : "Phone System";
  return new AppError(
    TEAMS_VOICE_LICENSE_REQUIRED,
    `Teams Business Voice requires an active Phone System service plan (missing: ${missing})`,
    403,
  );
}

function confirmRequiredError(): AppError {
  return new AppError(TEAMS_VOICE_CONFIRM_REQUIRED, "release requires explicit confirmation", 400, [
    { field: "confirm", reason: "required" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => TeamsVoiceCaller | undefined,
  ctx: RequestContext,
): TeamsVoiceCaller {
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

function requireNumberParam(ctx: RequestContext): string {
  const value = ctx.params["numberId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "numberId is required", 400, [
      { field: "numberId", reason: "required" },
    ]);
  }
  return value.trim();
}

async function requireTeamsVoiceRead(
  options: TeamsVoiceRouteOptions,
  caller: TeamsVoiceCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, TEAMS_VOICE_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(TEAMS_VOICE_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing teams.read", 403);
  }
}

async function requireTeamsVoiceWrite(
  options: TeamsVoiceRouteOptions,
  caller: TeamsVoiceCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, TEAMS_VOICE_WRITE_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const hasWrite =
    permissions.includes(TEAMS_VOICE_WRITE_PERMISSION) ||
    permissions.includes(REMEDIATION_APPLY_PERMISSION) ||
    permissions.includes("*");
  if (!hasWrite) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing teams.voice", 403);
  }
}

function readPreviewFlag(ctx: RequestContext, body: Record<string, unknown>): boolean {
  return Boolean(body["preview"] ?? (ctx.query.get("preview") === "true"));
}

async function requireVoiceLicensed(
  options: TeamsVoiceRouteOptions,
  tenantId: string,
): Promise<TeamsVoiceLicenseState> {
  const license = await options.provider.getLicenseState(tenantId);
  if (!license.licensed) {
    throw licenseRequiredError(license.missingPlans);
  }
  return license;
}

function parseAssignNumberBody(ctx: RequestContext): AssignVoiceNumberInput {
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const phoneNumber = typeof body["phoneNumber"] === "string" ? body["phoneNumber"].trim() : "";
  if (!phoneNumber) {
    throw validationError("phoneNumber is required", "phoneNumber");
  }
  const targetId = typeof body["targetId"] === "string" ? body["targetId"].trim() : "";
  if (!targetId) {
    throw validationError("targetId is required", "targetId");
  }
  return { phoneNumber, targetId, preview: readPreviewFlag(ctx, body) };
}

function parseAssignPolicyBody(ctx: RequestContext): AssignVoicePolicyInput {
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const policyId = typeof body["policyId"] === "string" ? body["policyId"].trim() : "";
  if (!policyId) {
    throw validationError("policyId is required", "policyId");
  }
  const targetId = typeof body["targetId"] === "string" ? body["targetId"].trim() : "";
  if (!targetId) {
    throw validationError("targetId is required", "targetId");
  }
  return { policyId, targetId, preview: readPreviewFlag(ctx, body) };
}

function readReleaseConfirmFlag(ctx: RequestContext, body: Record<string, unknown>): boolean {
  return Boolean(body["confirm"] ?? (ctx.query.get("confirm") === "true"));
}

async function recordWriteAudits(
  options: TeamsVoiceRouteOptions,
  result: TeamsVoiceResult,
): Promise<void> {
  if (result.auditEvent && options.recordAudit) {
    await options.recordAudit({ ...result.auditEvent });
  }
  if (result.teamOperation && options.recordTeamOperation) {
    await options.recordTeamOperation(result.teamOperation);
  }
}

export function createTeamsVoiceRoutes(options: TeamsVoiceRouteOptions): Route[] {
  return [
    {
      method: "GET",
      path: TEAMS_VOICE_NUMBERS_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireTeamsVoiceRead(options, caller);
        const { license, numbers } = await options.provider.listNumbers(tenantId);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: { tenantId, license, numbers },
        };
      },
    },
    {
      method: "POST",
      path: TEAMS_VOICE_NUMBERS_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireTeamsVoiceWrite(options, caller);
        await requireVoiceLicensed(options, tenantId);

        const input = parseAssignNumberBody(ctx);
        const isPreview = Boolean(input.preview);
        const result = await options.provider.assignNumber(tenantId, input, isPreview);
        if (!isPreview) {
          await recordWriteAudits(options, result as TeamsVoiceResult);
        }
        return {
          status: isPreview ? 200 : 201,
          headers: { "content-type": "application/json" },
          body: result,
        };
      },
    },
    {
      method: "DELETE",
      path: TEAMS_VOICE_NUMBER_ITEM_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const numberId = requireNumberParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireTeamsVoiceWrite(options, caller);
        await requireVoiceLicensed(options, tenantId);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        if (!readReleaseConfirmFlag(ctx, body)) {
          throw confirmRequiredError();
        }
        const result = await options.provider.releaseNumber(tenantId, numberId, false);
        await recordWriteAudits(options, result as TeamsVoiceResult);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: result,
        };
      },
    },
    {
      method: "POST",
      path: TEAMS_VOICE_POLICY_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireTeamsVoiceWrite(options, caller);
        await requireVoiceLicensed(options, tenantId);

        const input = parseAssignPolicyBody(ctx);
        const isPreview = Boolean(input.preview);
        const result = await options.provider.assignPolicy(tenantId, input, isPreview);
        if (!isPreview) {
          await recordWriteAudits(options, result as TeamsVoiceResult);
        }
        return {
          status: isPreview ? 200 : 201,
          headers: { "content-type": "application/json" },
          body: result,
        };
      },
    },
  ];
}

export const TEAMS_VOICE_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/teams/voice/numbers": {
      get: {
        operationId: "listVoiceNumbers",
        summary: "List the voice-number inventory and license state",
        permission: TEAMS_VOICE_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The voice-number inventory with the license state." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks teams.read or the tenant is out of scope." },
        },
      },
      post: {
        operationId: "assignVoiceNumber",
        summary: "Assign a phone number to a user or resource account (plan preview with preview:true)",
        permission: TEAMS_VOICE_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Assignment plan preview." },
          "201": { description: "The assignment with before/after, TeamOperation, and audit event." },
          "400": { description: "phoneNumber or targetId failed validation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks teams.voice, the tenant is out of scope, or voice is not licensed." },
        },
      },
    },
    "/tenants/{tenantId}/teams/voice/numbers/{numberId}": {
      delete: {
        operationId: "releaseVoiceNumber",
        summary: "Release a phone number (requires confirm:true)",
        permission: TEAMS_VOICE_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "numberId", in: "path", required: true, schema: { type: "string" } },
          { name: "confirm", in: "query", required: true, schema: { type: "boolean" } },
        ],
        responses: {
          "200": { description: "The release with before/after, TeamOperation, and audit event." },
          "400": { description: "confirm is required to release a phone number." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks teams.voice, the tenant is out of scope, or voice is not licensed." },
        },
      },
    },
    "/tenants/{tenantId}/teams/voice/policy": {
      post: {
        operationId: "assignVoicePolicy",
        summary: "Assign a voice routing policy to a user (plan preview with preview:true)",
        permission: TEAMS_VOICE_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Policy assignment plan preview." },
          "201": { description: "The policy assignment with before/after, TeamOperation, and audit event." },
          "400": { description: "policyId or targetId failed validation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks teams.voice, the tenant is out of scope, or voice is not licensed." },
        },
      },
    },
  },
} as const;
